"""OKX MCP configuration — env-driven, safe defaults.

The whole surface is gated on ``okx_enabled()``: without the settlement wallet
and the x402 package it stays dark, so the app boots unchanged in dev/CI.
Prices are per-tool USD strings (the x402 SDK converts USD → the X Layer
stablecoin at settlement), each overridable by env so pricing changes need no
redeploy.
"""

from __future__ import annotations

import os


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


# ---------------------------------------------------------------------------
# Settlement wiring
# ---------------------------------------------------------------------------

# The Agentic Wallet EVM address that receives payments. The single most
# important setting — without it, nothing is payable.
PAY_TO_ADDRESS = _env("OKX_PAY_TO_ADDRESS")

# OKX Developer Portal credentials authenticating our resource server to the
# OKX Facilitator/Broker that orchestrates settlement.
OKX_API_KEY = _env("OKX_API_KEY")
OKX_SECRET_KEY = _env("OKX_SECRET_KEY")
OKX_PASSPHRASE = _env("OKX_PASSPHRASE")
OKX_BASE_URL = _env("OKX_BASE_URL", "https://web3.okx.com")

# CAIP-2 network id. Default TESTNET so a misconfigured deploy can never take
# real funds — flip to eip155:196 (X Layer mainnet) for production.
OKX_NETWORK = _env("OKX_NETWORK", "eip155:1952")  # X Layer testnet

# Settlement token override. The x402 SDK knows the default stablecoin for
# X Layer MAINNET (USD₮0), but not for the TESTNET — so testnet runs must set
# the test-token contract here or every priced call fails at challenge time.
OKX_ASSET_ADDRESS = _env("OKX_ASSET_ADDRESS")
OKX_ASSET_DECIMALS = int(_env("OKX_ASSET_DECIMALS", "6") or "6")
OKX_ASSET_NAME = _env("OKX_ASSET_NAME", "USDT")
OKX_ASSET_VERSION = _env("OKX_ASSET_VERSION", "1")

# Sync = block the response until settlement confirms; async returns 200 and
# settles in the background. Sync is safer for one-shot tool calls.
OKX_SYNC_SETTLE = _env("OKX_SYNC_SETTLE", "1") not in {"0", "false", "no"}

# A ``voc_live_`` API key for a system account. Tool fulfillment reuses
# Vocence's own /v1 API with this key, so no new generation logic is added and
# the credit-charging path is unchanged — the account is the internal executor.
# Payment happens on-chain via x402; keep this account funded with credits (the
# /v1 API still meters it) or the generations it fronts will fail.
OKX_SYSTEM_API_KEY = _env("OKX_SYSTEM_API_KEY")

# Base URL of our own /v1 API the tools call back into. Same host in prod;
# localhost for co-located dev.
OKX_SELF_API_BASE = _env("OKX_SELF_API_BASE", "http://127.0.0.1:8031")


def okx_enabled() -> bool:
    """True only when the surface can actually fulfill a paid call.

    Requires the wallet, a funded system key, and the x402 package. Without
    these the routes still mount (the manifest stays discoverable) but paid
    tools return 503 until fully wired.
    """
    return bool(PAY_TO_ADDRESS and OKX_SYSTEM_API_KEY and _x402_installed())


def payments_configured() -> bool:
    """True when the x402 settlement layer has everything it needs."""
    return bool(
        PAY_TO_ADDRESS
        and OKX_API_KEY
        and OKX_SECRET_KEY
        and OKX_PASSPHRASE
        and _x402_installed()
    )


def _x402_installed() -> bool:
    import importlib.util

    return importlib.util.find_spec("x402") is not None


# ---------------------------------------------------------------------------
# Per-tool pricing (USD strings; env-overridable)
# ---------------------------------------------------------------------------
#
# Set independently of the internal credit costs — this is the on-chain price
# an agent pays, denominated in USD and settled as an X Layer stablecoin.
# Video dubbing is metered per minute, so its price is a per-minute rate the
# route multiplies by the source duration into a concrete per-call charge.

PRICE_TTS = _env("OKX_PRICE_TTS", "$0.02")
PRICE_VOICE_DESIGN = _env("OKX_PRICE_VOICE_DESIGN", "$0.10")
PRICE_STT = _env("OKX_PRICE_STT", "$0.02")
PRICE_VOICE_CLONE = _env("OKX_PRICE_VOICE_CLONE", "$0.05")
PRICE_NOISE_REMOVER = _env("OKX_PRICE_NOISE_REMOVER", "$0.02")
# Per-minute rates for the metered dubbing tool.
PRICE_VIDEO_DUB_PER_MIN = _env("OKX_PRICE_VIDEO_DUB_PER_MIN", "$0.60")
PRICE_VIDEO_DUB_LIPSYNC_PER_MIN = _env("OKX_PRICE_VIDEO_DUB_LIPSYNC_PER_MIN", "$2.40")
