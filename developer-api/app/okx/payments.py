"""x402 payment gate — the only module that touches the OKX SDK.

Isolated on purpose: the OKX x402 packages pull in heavy web3/solana deps and
are only present in a configured deployment. Everything imports lazily inside
``build_payment_middleware`` so the app boots — and the manifest stays
discoverable — even where the SDK isn't installed.

Wired against the verified x402 2.16.0 API:
    x402.http.middleware.fastapi.payment_middleware(routes, server)
    x402.http.types.PaymentOption / RouteConfig  (price may be a DynamicPrice)
    x402.x402ResourceServer(facilitator).register(network, ExactEvmScheme())

Metered pricing: the dubbing tool's price depends on the request body
(duration × languages × lip-sync), but the SDK's FastAPI adapter exposes no
body to a DynamicPrice callable (``get_body()`` returns None). So the wrapper
around the SDK middleware reads the body first and parks the parsed arguments
in a ContextVar; the DynamicPrice callable picks them up from there — same
task, same context. Starlette caches the body it hands a middleware, so the
downstream route still reads it normally.

The OKX-specific facilitator client comes from ``okxweb3-app-x402``; if only the
reference ``x402`` package is present the generic HTTP facilitator is used, so
integration can be exercised on testnet before the OKX package lands.
"""

from __future__ import annotations

import json
import logging
from contextvars import ContextVar

from . import config
from .tools import TOOLS, Tool

_log = logging.getLogger(__name__)

# Arguments of the in-flight metered call, set by the gate wrapper before the
# SDK middleware resolves the route's DynamicPrice.
_metered_args: ContextVar[dict] = ContextVar("okx_metered_args", default={})

_DUB_ROUTE_PATH = "/okx/tools/vocence_video_dub"


def price_for(tool: Tool, arguments: dict | None = None) -> str:
    """USD price string for one call of ``tool``.

    Flat tools return their fixed price. The metered dubbing tool charges its
    per-minute rate (lip-sync rate when ``lipsync`` is true) × the source
    duration rounded up to the minute × the number of target languages —
    mirroring how the job is billed downstream. Missing/invalid arguments fall
    back to the 1-minute single-language minimum; the schema validation on the
    route rejects such a request anyway.
    """
    if not tool.metered:
        return tool.price or "$0.00"
    args = arguments or {}
    rate = (
        config.PRICE_VIDEO_DUB_LIPSYNC_PER_MIN
        if args.get("lipsync")
        else config.PRICE_VIDEO_DUB_PER_MIN
    )
    try:
        duration = float(args.get("duration_sec") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    minutes = max(1, -(-int(duration) // 60))  # ceil, ≥1
    langs = args.get("target_languages")
    lang_count = max(1, len(langs)) if isinstance(langs, list) else 1
    return _mul_usd(rate, minutes * lang_count)


def _mul_usd(price: str, factor: int) -> str:
    """Multiply a ``$X.YY`` string by an integer, returning a ``$`` string."""
    cents = round(float(price.lstrip("$")) * 100) * max(1, factor)
    return f"${cents / 100:.2f}"


def route_key(tool: Tool) -> str:
    """The 'METHOD /path' key x402 uses to price a route."""
    return f"POST /okx/tools/{tool.name}"


def build_payment_middleware():
    """Return a configured x402 FastAPI middleware, or None if unconfigured.

    None means the payment layer is off — routes then enforce a 402/503
    themselves rather than silently serving for free.
    """
    if not config.payments_configured():
        _log.info("[okx] x402 not configured; payment gate disabled")
        return None

    try:
        from x402 import x402ResourceServer
        from x402.http.middleware.fastapi import payment_middleware
        from x402.http.types import PaymentOption, RouteConfig
        from x402.mechanisms.evm.exact.server import ExactEvmScheme

        facilitator = _facilitator_client()
        server = x402ResourceServer(facilitator)
        scheme = ExactEvmScheme()
        _register_settlement_asset(scheme)
        server.register(config.OKX_NETWORK, scheme)

        def _metered_price(_context):
            """DynamicPrice: read the parked request arguments (see module doc)."""
            metered = next(t for t in TOOLS if t.metered)
            return price_for(metered, _metered_args.get())

        routes: dict[str, RouteConfig] = {}
        for tool in TOOLS:
            price = _metered_price if tool.metered else (tool.price or "$0.00")
            routes[route_key(tool)] = RouteConfig(
                accepts=[
                    PaymentOption(
                        scheme="exact",
                        price=price,
                        network=config.OKX_NETWORK,
                        pay_to=config.PAY_TO_ADDRESS,
                        max_timeout_seconds=300,
                    )
                ],
                description=tool.description,
                mime_type="application/json",
            )

        _log.info("[okx] x402 payment gate active on %s → %s (%d tools)",
                  config.OKX_NETWORK, config.PAY_TO_ADDRESS[:10] + "…", len(routes))
        okx_dispatch = payment_middleware(routes, server)

        async def guarded(request, call_next):
            """Wrap OKX's middleware: park metered-call args for DynamicPrice,
            and turn facilitator faults into a clean 503 (fail CLOSED — a real
            fault must not serve the tool for free nor leak OKX internals; a
            genuine payment challenge is a returned 402 Response, not an
            exception).
            """
            from fastapi.responses import JSONResponse

            if request.method == "POST" and request.url.path == _DUB_ROUTE_PATH:
                _metered_args.set(await _read_json_body(request))

            try:
                return await okx_dispatch(request, call_next)
            except Exception:
                _log.exception("[okx] payment facilitator error on %s", request.url.path)
                return JSONResponse(
                    {"detail": "Payment service is temporarily unavailable. Please try again."},
                    status_code=503,
                )

        return guarded
    except Exception:
        # Never let a payment-layer import/config error take down the API.
        _log.exception("[okx] failed to build x402 middleware; payment gate disabled")
        return None


def _register_settlement_asset(scheme) -> None:
    """Wire the settlement token for networks the SDK has no default for.

    The SDK maps ``"$X.YY"`` Money strings to a network's default stablecoin —
    X Layer MAINNET (eip155:196) ships one (USD₮0), but X Layer TESTNET
    (eip155:1952) does not, so without this every priced call on our default
    network dies with "No default stablecoin configured" at challenge time.
    ``OKX_ASSET_ADDRESS`` (+ decimals/name/version) supplies the token; when it
    is unset on a network with no SDK default, warn loudly at boot instead of
    failing on the first paid call.
    """
    from decimal import Decimal

    from x402.schemas.base import AssetAmount

    address = config.OKX_ASSET_ADDRESS
    if address:
        decimals = config.OKX_ASSET_DECIMALS

        def parser(amount: float, network: str):
            if network != config.OKX_NETWORK:
                return None
            atomic = int((Decimal(str(amount)) * (10 ** decimals)).to_integral_value())
            return AssetAmount(
                amount=str(atomic),
                asset=address,
                extra={"name": config.OKX_ASSET_NAME, "version": config.OKX_ASSET_VERSION},
            )

        scheme.register_money_parser(parser)
        _log.info("[okx] settlement asset %s (%d dp) registered for %s",
                  address[:10] + "…", decimals, config.OKX_NETWORK)
        return

    try:
        from x402.mechanisms.evm.constants import get_network_config

        default = (get_network_config(config.OKX_NETWORK) or {}).get("default_asset")
    except Exception:
        default = None
    if not (default and default.get("address")):
        _log.warning(
            "[okx] network %s has no default settlement asset and OKX_ASSET_ADDRESS "
            "is unset — every priced call will fail until one is configured",
            config.OKX_NETWORK,
        )


async def _read_json_body(request) -> dict:
    """Best-effort parse of the request body for metered pricing.

    Starlette's BaseHTTPMiddleware hands dispatchers a cached-body request, so
    reading here does not starve the downstream handler. A malformed body
    prices at the minimum and is then rejected by schema validation anyway.
    """
    try:
        raw = await request.body()
        data = json.loads(raw) if raw else {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _facilitator_client():
    """OKX facilitator if the OKX package is present, else the generic one."""
    try:
        from x402.http import OKXAuthConfig, OKXFacilitatorClient, OKXFacilitatorConfig

        return OKXFacilitatorClient(
            OKXFacilitatorConfig(
                auth=OKXAuthConfig(
                    api_key=config.OKX_API_KEY,
                    secret_key=config.OKX_SECRET_KEY,
                    passphrase=config.OKX_PASSPHRASE,
                ),
                base_url=config.OKX_BASE_URL,
                sync_settle=config.OKX_SYNC_SETTLE,
            )
        )
    except Exception:
        # Fall back to the reference HTTP facilitator (testnet integration).
        from x402.http import HTTPFacilitatorClient

        _log.info("[okx] OKX facilitator unavailable; using reference HTTPFacilitatorClient")
        return HTTPFacilitatorClient()
