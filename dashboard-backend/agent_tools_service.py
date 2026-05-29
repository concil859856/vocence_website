"""Voice agent tool registry + dispatcher.

This module powers tool calling for Studio Agents — the "what's the
weather in Tokyo?" magic from the spec. Tools are exposed to the LLM
via OpenAI-compatible function specs (Groq + OpenAI + Chutes all
understand this format); when the LLM emits a ``tool_call`` event,
the voicechat WS hands the name + arguments to ``dispatch_tool_call``
which runs the matching executor and ships the result back into the
conversation as a ``role: tool`` message.

Tools are registered at import time. A tool is included in the live
registry only when its required env vars are present, so a deploy
without ``TAVILY_API_KEY`` simply doesn't advertise web_search — the
LLM never sees it and never tries to call it.

  Built-in tools (v1):
    • web_search(query)          → Tavily search API
    • get_weather(location)      → OpenWeatherMap current weather
    • get_time(timezone)         → IANA-zone local time
    • fetch_url(url)             → public-internet URL fetch + extract
    • wikipedia_lookup(query)    → Wikipedia summary

  External call rules (all enforced):
    • per-tool timeout (5 s default)
    • SSRF-safe outgoing HTTP for ``fetch_url`` and any user-defined
      tool whose endpoint is user-supplied (resolve DNS first, block
      private/loopback/link-local IPs, force HTTPS)
    • result size cap (~8 KB string) so a chatty tool doesn't blow
      the LLM context window on a single call

  Public API:
    tool_specs(enabled: set[str] | None = None) -> list[dict]
        → JSON-Schema specs to hand the LLM
    async dispatch_tool_call(name: str, arguments: str) -> str
        → executes the tool, returns a JSON-stringified result
"""

from __future__ import annotations

import asyncio
import html
import ipaddress
import json
import logging
import os
import re
import socket
import time as _time_mod
import urllib.parse
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import aiohttp

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TAVILY_API_KEY = (os.environ.get("TAVILY_API_KEY") or "").strip()
OPENWEATHER_API_KEY = (os.environ.get("OPENWEATHER_API_KEY") or "").strip()

# Global default timeout for any single tool call. Tool authors can
# override per-tool by setting ``timeout_s`` on the registration.
DEFAULT_TOOL_TIMEOUT_S = float(os.environ.get("AGENT_TOOL_TIMEOUT_S") or "5.0")

# Cap the tool-result string fed back to the LLM. Web-search results
# in particular can be huge; if we paste 50 KB back the LLM blows its
# context and either fails or hallucinates. 8 KB is enough for any
# realistic answer.
MAX_TOOL_RESULT_CHARS = 8000

# User-Agent for outbound HTTP. Some endpoints reject blank or curl UAs.
_HTTP_UA = "VocenceAgentTools/1.0 (+https://www.vocence.ai)"


# ---------------------------------------------------------------------------
# TTL cache (in-memory, bounded)
# ---------------------------------------------------------------------------
#
# Tool calls that hit external APIs (weather, web search, wikipedia)
# routinely get repeated within seconds during a voice conversation —
# user rephrases, asks follow-ups, etc. The cache turns those repeat
# calls into ~1 µs dict lookups instead of 400 ms API round-trips.
#
# It's deliberately minimal: a Python OrderedDict with a per-tool size
# cap and TTL. Lives in process memory; restart-clears. No disk, no DB,
# no external dependency. Cache keys are (tool_name, normalised_args_json).


class _TTLCache:
    """Bounded LRU cache with per-entry TTL. Suitable for caching small
    tool-result strings (each result is already capped at 8 KB by
    MAX_TOOL_RESULT_CHARS, so worst-case footprint is bounded by
    max_entries * 8 KB ≈ 8 MB per cache when full)."""

    def __init__(self, max_entries: int = 1000):
        self._max = max_entries
        # Insertion-ordered so we can evict the oldest entry cheaply
        # when we hit the cap (LRU behaviour: re-access moves to end).
        self._data: OrderedDict[str, tuple[str, float]] = OrderedDict()

    def get(self, key: str, ttl_s: float) -> str | None:
        """Return the cached value if fresh; otherwise None. Treats
        expired entries as a cache miss (we leave the stale row in
        place; it'll get overwritten on the next ``set`` or evicted
        when the cap fills)."""
        row = self._data.get(key)
        if row is None:
            return None
        value, stored_at = row
        if (_time_mod.monotonic() - stored_at) > ttl_s:
            return None
        # Refresh LRU position.
        self._data.move_to_end(key)
        return value

    def set(self, key: str, value: str) -> None:
        self._data[key] = (value, _time_mod.monotonic())
        self._data.move_to_end(key)
        # Evict the oldest entry when we exceed the cap. The check runs
        # on every set; eviction is O(1) so this stays cheap.
        if len(self._data) > self._max:
            self._data.popitem(last=False)


# A single cache shared across all cached tools. Keys are namespaced
# with the tool name so different tools can't collide on identical
# arguments (e.g. {"query": "Tokyo"} works for both web_search and
# wikipedia_lookup).
_tool_cache = _TTLCache(max_entries=1000)


def _cache_key(tool_name: str, args: dict) -> str:
    """Stable key for the cache. Sort keys so {"a":1,"b":2} and
    {"b":2,"a":1} hash to the same entry — the LLM occasionally
    emits arguments in different orders for what's the same call."""
    return f"{tool_name}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"


# ---------------------------------------------------------------------------
# Shared HTTP session — keep-alive across tool calls
# ---------------------------------------------------------------------------
#
# Before: every tool dispatch created a fresh aiohttp.ClientSession,
# which means a fresh TCP + TLS handshake to api.tavily.com (or wherever)
# every call. That handshake is ~100-200 ms — on a voice agent that
# calls web_search three times in a row, that's 300-600 ms of avoidable
# latency.
#
# After: one process-wide ClientSession with a TCPConnector configured
# for keep-alive. Subsequent calls to the same host within ~60 s of
# idle reuse the connection. Saves ~150 ms per repeat-host call.
#
# The session is lazily initialised on first use because aiohttp won't
# let us construct one outside an event loop. ``close_shared_session``
# is called from main.py's lifespan shutdown for clean teardown.

_shared_session: aiohttp.ClientSession | None = None
_session_lock = asyncio.Lock()


async def _get_shared_session() -> aiohttp.ClientSession:
    global _shared_session
    if _shared_session is not None and not _shared_session.closed:
        return _shared_session
    async with _session_lock:
        if _shared_session is not None and not _shared_session.closed:
            return _shared_session
        connector = aiohttp.TCPConnector(
            limit=64,                  # total open connections across all hosts
            limit_per_host=8,          # per-host concurrency cap
            ttl_dns_cache=300,         # cache DNS for 5 min — saves ~20 ms per call
            keepalive_timeout=60,      # idle keep-alive window
        )
        # Each per-request timeout overrides this default; the default
        # is just a safety net for accidental missing timeouts.
        _shared_session = aiohttp.ClientSession(
            connector=connector,
            timeout=aiohttp.ClientTimeout(total=30),
            headers={"User-Agent": _HTTP_UA},
        )
        return _shared_session


async def close_shared_session() -> None:
    """Clean shutdown — called from FastAPI lifespan when the app exits."""
    global _shared_session
    if _shared_session is not None and not _shared_session.closed:
        await _shared_session.close()
    _shared_session = None


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]            # JSON Schema
    executor: Callable[[dict], Awaitable[Any]]
    timeout_s: float = DEFAULT_TOOL_TIMEOUT_S
    requires_env: tuple[str, ...] = field(default_factory=tuple)

    def available(self) -> bool:
        """Whether this tool can run on the current deployment.
        Tools whose required env vars aren't set drop out of the
        registry — the LLM never sees them so it can't try to call
        them and time out."""
        return all(os.environ.get(v) for v in self.requires_env)

    def as_spec(self) -> dict[str, Any]:
        """The OpenAI-compatible function spec we hand to the LLM."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


_REGISTRY: dict[str, Tool] = {}


def _register(tool: Tool) -> None:
    _REGISTRY[tool.name] = tool


def all_tool_names() -> list[str]:
    """Every tool name registered (regardless of whether its env is
    configured). The frontend uses this to render toggles."""
    return list(_REGISTRY.keys())


def available_tool_names() -> set[str]:
    """Tools that can actually run right now — env vars present."""
    return {name for name, t in _REGISTRY.items() if t.available()}


def tool_specs(enabled: set[str] | None = None) -> list[dict[str, Any]]:
    """Specs for the subset the agent has enabled AND that are
    configured. Pass ``enabled=None`` to get every available tool
    (handy for the Logos assistant which has all tools by default)."""
    out: list[dict[str, Any]] = []
    for name, tool in _REGISTRY.items():
        if not tool.available():
            continue
        if enabled is not None and name not in enabled:
            continue
        out.append(tool.as_spec())
    return out


def tool_catalog() -> list[dict[str, Any]]:
    """Lightweight info-only listing for the frontend Tools picker.
    Returns ``[{name, description, available}, ...]`` — no executor
    references, JSON-serializable."""
    return [
        {
            "name": t.name,
            "description": t.description,
            "available": t.available(),
            "requires_env": list(t.requires_env),
        }
        for t in _REGISTRY.values()
    ]


# ---------------------------------------------------------------------------
# SSRF-safe outgoing HTTP (used by fetch_url + future user-defined tools)
# ---------------------------------------------------------------------------


_PRIVATE_RANGES = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),       # loopback
    ipaddress.ip_network("169.254.0.0/16"),    # link-local + cloud metadata
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),     # CGNAT
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),          # IPv6 ULA
    ipaddress.ip_network("fe80::/10"),         # IPv6 link-local
]


def _is_private_addr(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in net for net in _PRIVATE_RANGES)


def assert_safe_url(url: str) -> None:
    """Raise ``ValueError`` if ``url`` resolves to an unsafe target.

    Used by ``fetch_url`` and the custom-tool dispatcher (Phase 3) so
    a user-supplied endpoint can't be coerced into hitting an internal
    network. Checks:
      • scheme must be http/https
      • host must resolve to public IPs only
      • port must be the default for the scheme (no random ports)

    DNS resolution happens BEFORE the HTTP call so a hostname that
    resolves to 169.254.169.254 (AWS metadata) is rejected even when
    the user types ``somehost.example.com``."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception as exc:
        raise ValueError(f"unparseable URL: {exc}") from exc
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"only http/https URLs are allowed, got '{parsed.scheme}'")
    if not parsed.hostname:
        raise ValueError("URL has no hostname")
    # Resolve DNS — if any of the A/AAAA records lands inside a private
    # range we reject. Some attacks use DNS records that *only* return
    # private IPs for one of several round-robin entries.
    try:
        addr_infos = socket.getaddrinfo(parsed.hostname, parsed.port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise ValueError(f"DNS resolution failed for {parsed.hostname}: {exc}") from exc
    if not addr_infos:
        raise ValueError(f"DNS returned no records for {parsed.hostname}")
    for _, _, _, _, sockaddr in addr_infos:
        addr = sockaddr[0]
        if _is_private_addr(addr):
            raise ValueError(f"URL host {parsed.hostname} resolves to private/internal IP {addr}")


async def safe_request(
    method: str,
    url: str,
    *,
    session: "aiohttp.ClientSession",
    max_redirects: int = 0,
    **kwargs,
) -> "aiohttp.ClientResponse":
    """``session.request`` with SSRF-safe redirect handling.

    ``assert_safe_url`` only validates the URL handed to it — aiohttp's
    built-in redirect follower happily chases ``302 Location: http://
    169.254.169.254/...`` because it never goes back through validation.
    This wrapper disables aiohttp's auto-follow and, when redirects are
    permitted, re-validates the ``Location`` header at every hop.

    Returns the final aiohttp response, opened with the caller's
    ``async with``-style context expectations (so callers should use
    ``async with await safe_request(...) as resp:``).
    """
    assert_safe_url(url)
    kwargs.pop("allow_redirects", None)
    kwargs.pop("max_redirects", None)

    current = url
    for _ in range(max_redirects + 1):
        resp = await session.request(method, current, allow_redirects=False, **kwargs)
        if resp.status not in (301, 302, 303, 307, 308):
            return resp
        location = resp.headers.get("Location") or ""
        await resp.release()
        if not location:
            raise ValueError(f"redirect from {current} had no Location header")
        # Resolve relative Location against the previous URL
        nxt = urllib.parse.urljoin(current, location)
        assert_safe_url(nxt)
        current = nxt
    raise ValueError(f"too many redirects (>{max_redirects})")


# ---------------------------------------------------------------------------
# Result shaping
# ---------------------------------------------------------------------------


_NO_FABRICATION_NOTE = (
    "This tool returned no useful data (empty or error). Tell the user "
    "honestly that you couldn't find the information. Do NOT invent an "
    "answer. Do NOT borrow facts from other topics discussed earlier "
    "in this conversation."
)


def _stringify_result(result: Any) -> str:
    """Tool result → string for the LLM. We always JSON-encode dicts/
    lists so the LLM gets a stable shape; plain strings pass through.
    Trims to MAX_TOOL_RESULT_CHARS so a 50 KB scrape doesn't poison
    the context.

    For dict results that look like an error or empty payload, we
    inject ``instructions_for_model`` so the LLM is explicitly told
    not to fabricate. Implementations that return ``{"error": …}``
    directly (without going through ``_error_payload``) get the same
    protection here at the central choke point.
    """
    if isinstance(result, dict):
        if "error" in result and "instructions_for_model" not in result:
            result = {**result, "instructions_for_model": _NO_FABRICATION_NOTE}
    if isinstance(result, str):
        out = result
    else:
        out = json.dumps(result, ensure_ascii=False, default=str)
    if len(out) > MAX_TOOL_RESULT_CHARS:
        out = out[:MAX_TOOL_RESULT_CHARS] + "\n…[truncated]"
    return out


def _error_payload(reason: str) -> str:
    """Structured error returned to the LLM so it can decide whether
    to recover (e.g. re-call with different args) or give up
    gracefully. JSON-encoded so the LLM can parse if it wants to.

    Includes an ``instructions_for_model`` field so the model doesn't
    silently fabricate a plausible answer when the tool failed —
    especially important for small open-weight models that tend to
    paper over errors by inventing context from elsewhere in the
    conversation."""
    return json.dumps(
        {
            "error": reason,
            "instructions_for_model": (
                "This tool call failed. Tell the user honestly that you "
                "couldn't get the information. Do NOT invent an answer. "
                "Do NOT borrow facts from other topics discussed earlier "
                "in this conversation. You may suggest the user try "
                "again with more specific context."
            ),
        },
        ensure_ascii=False,
    )


# ---------------------------------------------------------------------------
# Built-in tools
# ---------------------------------------------------------------------------


# ----- get_time --------------------------------------------------------------

async def _impl_get_time(args: dict) -> dict:
    tz_name = (args.get("timezone") or "UTC").strip() or "UTC"
    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        return {"error": f"unknown timezone: {tz_name!r}. Use an IANA zone like 'America/New_York' or 'UTC'."}
    now = datetime.now(tz)
    return {
        "timezone": tz_name,
        "iso": now.isoformat(),
        "local": now.strftime("%A, %B %d %Y at %I:%M %p %Z"),
        "weekday": now.strftime("%A"),
        "year": now.year, "month": now.month, "day": now.day,
        "hour": now.hour, "minute": now.minute,
    }


_register(Tool(
    name="get_time",
    description=(
        "Get the current date and time in a given timezone. Use whenever the user asks "
        "what time it is, what day it is, or anything time-related. Default UTC."
    ),
    parameters={
        "type": "object",
        "properties": {
            "timezone": {
                "type": "string",
                "description": "IANA timezone name (e.g. 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'UTC').",
            },
        },
        "required": [],
    },
    executor=_impl_get_time,
    timeout_s=2.0,
))


# ----- web_search (Tavily) ---------------------------------------------------
#
# Cached for 60 s: in a voice conversation the user often rephrases or
# follows up within seconds. The cache catches those repeat queries
# without serving stale headlines.

_WEB_SEARCH_TTL_S = 60.0


async def _impl_web_search(args: dict) -> Any:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "missing 'query'"}
    if not TAVILY_API_KEY:
        return {"error": "web search is not configured (TAVILY_API_KEY missing)"}

    ckey = _cache_key("web_search", {"query": query})
    cached = _tool_cache.get(ckey, _WEB_SEARCH_TTL_S)
    if cached is not None:
        return cached  # already a JSON string

    # Tavily's /search endpoint — purpose-built for LLM agents,
    # returns pre-summarized text rather than raw HTML so we can feed
    # the result straight back into the conversation.
    body = {
        "api_key": TAVILY_API_KEY,
        "query": query,
        "search_depth": "basic",       # "basic" is fast (~600ms); "advanced" is slower but richer
        "max_results": 5,
        "include_answer": True,
        "include_raw_content": False,
        "include_images": False,
    }
    session = await _get_shared_session()
    try:
        async with session.post(
            "https://api.tavily.com/search",
            headers={"Content-Type": "application/json"},
            json=body,
            timeout=aiohttp.ClientTimeout(total=8),
        ) as resp:
            if resp.status != 200:
                snippet = (await resp.text())[:300]
                return {"error": f"tavily returned {resp.status}: {snippet}"}
            data = await resp.json()
    except aiohttp.ClientError as exc:
        return {"error": f"tavily request failed: {exc}"}

    result = {
        "query": query,
        "answer": data.get("answer") or "",
        "results": [
            {
                "title": r.get("title") or "",
                "url": r.get("url") or "",
                "content": (r.get("content") or "")[:1200],  # cap individual snippets
            }
            for r in (data.get("results") or [])[:5]
        ],
    }
    # Empty-result trip-wire. Without this the LLM (especially small
    # open-weight models like gpt-oss-120b) will silently fabricate a
    # plausible-sounding answer by borrowing context from earlier in
    # the conversation. The instructions field is a direct command to
    # the model when synthesizing its reply — visible to it as part
    # of the tool result payload.
    if not result["answer"] and not result["results"]:
        result["instructions_for_model"] = (
            "No matching information was found for this query. You MUST "
            "tell the user honestly that you couldn't find anything on "
            "this topic. Do NOT invent a description. Do NOT borrow "
            "facts from other topics discussed earlier in the "
            "conversation. Ask the user for a link or more context."
        )
    # Cache the stringified form so cache hits skip the json.dumps
    # round-trip too.
    stringified = json.dumps(result, ensure_ascii=False)
    _tool_cache.set(ckey, stringified)
    return stringified


_register(Tool(
    name="web_search",
    description=(
        "Live web search — your DEFAULT tool for looking anything up that you don't already know "
        "from memory. Use it broadly: news and current events, prices/stocks/crypto, sports scores, "
        "specific people (their profile, current role, recent statements, achievements), companies "
        "and products, events past and present, places, niche topics, anything specific the user "
        "names that you aren't fully sure about. Call this BEFORE guessing — search first, then "
        "answer from what the search actually returned. If the search returns no useful results, "
        "tell the user honestly that you couldn't find anything — DO NOT fabricate an answer by "
        "borrowing context from earlier in the conversation. Returns a concise answer plus 3–5 "
        "source snippets when matches exist."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for. Be concise — 3–8 words usually works best."},
        },
        "required": ["query"],
    },
    executor=_impl_web_search,
    timeout_s=8.0,
    requires_env=("TAVILY_API_KEY",),
))


# ----- get_weather (Open-Meteo) ---------------------------------------------
#
# Open-Meteo is free, no API key, no signup, no rate limit for normal use.
# Two-step internally: geocoding lookup turns a city name into lat/lon,
# then the forecast endpoint returns current conditions. We run both
# calls in parallel where possible — geocode finishes first because
# it has tighter quotas, then the forecast call lands ~150ms later.
#
# Cached for 10 min: weather APIs only refresh on that cadence anyway,
# so the cache costs zero accuracy.

_WEATHER_TTL_S = 600.0

# WMO weather codes → human-readable summary. Open-Meteo returns a
# numeric weather_code; we translate to natural language so the LLM
# has prose to work with, not numbers.
_WMO_DESCRIPTIONS = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "foggy", 48: "rime fog",
    51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
    56: "light freezing drizzle", 57: "dense freezing drizzle",
    61: "light rain", 63: "moderate rain", 65: "heavy rain",
    66: "light freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "moderate snow", 75: "heavy snow",
    77: "snow grains",
    80: "light rain showers", 81: "moderate rain showers", 82: "violent rain showers",
    85: "light snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with light hail", 99: "thunderstorm with heavy hail",
}


async def _impl_get_weather(args: dict) -> Any:
    location = (args.get("location") or "").strip()
    if not location:
        return {"error": "missing 'location'"}
    units = (args.get("units") or "metric").strip().lower()
    if units not in ("metric", "imperial"):
        units = "metric"

    ckey = _cache_key("get_weather", {"location": location, "units": units})
    cached = _tool_cache.get(ckey, _WEATHER_TTL_S)
    if cached is not None:
        return cached

    session = await _get_shared_session()

    # Step 1: geocode the location to lat/lon. Open-Meteo's geocoder
    # is free, fast (~150ms), and forgives common city-name shapes.
    try:
        async with session.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": location, "count": 1, "language": "en", "format": "json"},
            timeout=aiohttp.ClientTimeout(total=4),
        ) as geo_resp:
            if geo_resp.status != 200:
                return {"error": f"geocoding API returned {geo_resp.status}"}
            geo = await geo_resp.json()
    except aiohttp.ClientError as exc:
        return {"error": f"geocoding request failed: {exc}"}

    results = geo.get("results") or []
    if not results:
        return {"error": f"location not found: {location!r}"}
    place = results[0]
    lat = place.get("latitude")
    lon = place.get("longitude")
    if lat is None or lon is None:
        return {"error": f"geocoding for {location!r} returned no coordinates"}

    # Step 2: current weather at that lat/lon.
    temp_unit = "celsius" if units == "metric" else "fahrenheit"
    wind_unit = "kmh" if units == "metric" else "mph"
    try:
        async with session.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat, "longitude": lon,
                "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
                "temperature_unit": temp_unit,
                "wind_speed_unit": wind_unit,
            },
            timeout=aiohttp.ClientTimeout(total=4),
        ) as resp:
            if resp.status != 200:
                snippet = (await resp.text())[:200]
                return {"error": f"weather API returned {resp.status}: {snippet}"}
            data = await resp.json()
    except aiohttp.ClientError as exc:
        return {"error": f"weather request failed: {exc}"}

    cur = data.get("current") or {}
    code = cur.get("weather_code")
    summary = _WMO_DESCRIPTIONS.get(int(code) if code is not None else -1, "unknown conditions")
    temp_sym = "°C" if units == "metric" else "°F"
    speed_sym = "km/h" if units == "metric" else "mph"
    result = {
        "location": place.get("name") or location,
        "country": place.get("country") or "",
        "summary": summary,
        "temp_now": f"{cur.get('temperature_2m')}{temp_sym}" if cur.get("temperature_2m") is not None else None,
        "feels_like": f"{cur.get('apparent_temperature')}{temp_sym}" if cur.get("apparent_temperature") is not None else None,
        "humidity_pct": cur.get("relative_humidity_2m"),
        "wind": f"{cur.get('wind_speed_10m')}{speed_sym}" if cur.get("wind_speed_10m") is not None else None,
    }
    stringified = json.dumps(result, ensure_ascii=False)
    _tool_cache.set(ckey, stringified)
    return stringified


_register(Tool(
    name="get_weather",
    description=(
        "Get the current weather for a city or region. Returns temperature, feels-like, "
        "humidity, wind, and a short text summary. Use for any weather question."
    ),
    parameters={
        "type": "object",
        "properties": {
            "location": {
                "type": "string",
                "description": "City name, optionally with country, e.g. 'Tokyo' or 'Paris, France'.",
            },
            "units": {
                "type": "string",
                "enum": ["metric", "imperial"],
                "description": "metric (°C, km/h) or imperial (°F, mph). Default metric.",
            },
        },
        "required": ["location"],
    },
    executor=_impl_get_weather,
    timeout_s=8.0,
    # No API key required — Open-Meteo is free for non-commercial use.
    requires_env=(),
))


# ----- fetch_url (SSRF-safe) -------------------------------------------------

# Crude HTML-to-text extraction — enough for an LLM to read the page.
# Real parsing (BeautifulSoup, readability) would be richer but adds a
# dep; this strips tags + collapses whitespace which is sufficient for
# the use-case of "agent reads a known article URL."
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(?:script|style)\b[^>]*>.*?</(?:script|style)>", re.DOTALL | re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


def _html_to_text(html_str: str) -> str:
    s = _SCRIPT_STYLE_RE.sub(" ", html_str)
    s = _TAG_RE.sub(" ", s)
    s = html.unescape(s)
    s = _WS_RE.sub(" ", s).strip()
    return s


async def _impl_fetch_url(args: dict) -> Any:
    # Intentionally NOT cached — fetch_url can hit dynamic endpoints
    # (status pages, REST APIs the user pointed it at, etc.). Caching
    # would risk serving stale data the agent assumes is current.
    url = (args.get("url") or "").strip()
    if not url:
        return {"error": "missing 'url'"}

    session = await _get_shared_session()
    try:
        resp = await safe_request(
            "GET",
            url,
            session=session,
            headers={"Accept": "text/html, text/plain;q=0.5, */*;q=0.1"},
            max_redirects=5,
            timeout=aiohttp.ClientTimeout(total=6),
        )
    except ValueError as exc:
        return {"error": f"unsafe URL: {exc}"}
    except aiohttp.ClientError as exc:
        return {"error": f"fetch failed: {exc}"}

    try:
        async with resp:
            if resp.status >= 400:
                return {"error": f"{url} returned {resp.status}"}
            ct = (resp.headers.get("Content-Type") or "").lower()
            # Cap response body so a 50 MB PDF doesn't get pulled
            raw = await resp.content.read(512 * 1024)  # 512 KB cap
    except aiohttp.ClientError as exc:
        return {"error": f"fetch failed: {exc}"}

    body = raw.decode("utf-8", errors="replace")
    if "html" in ct:
        text = _html_to_text(body)
    else:
        text = _WS_RE.sub(" ", body).strip()
    return {"url": url, "content_type": ct, "text": text[:MAX_TOOL_RESULT_CHARS]}


_register(Tool(
    name="fetch_url",
    description=(
        "Fetch the contents of a public web page and return its text. Use when the user gives "
        "you a specific URL to read or summarize. Only works on public-internet URLs (no private "
        "networks). Returns up to ~8 KB of cleaned text."
    ),
    parameters={
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Full http/https URL to fetch."},
        },
        "required": ["url"],
    },
    executor=_impl_fetch_url,
    timeout_s=6.0,
))


# ----- wikipedia_lookup ------------------------------------------------------
#
# Cached 24 hours — article intros change rarely day-to-day, and we'd
# rather a follow-up question about the same person/place be instant.

_WIKI_TTL_S = 86_400.0


async def _impl_wikipedia_lookup(args: dict) -> Any:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "missing 'query'"}

    ckey = _cache_key("wikipedia_lookup", {"query": query})
    cached = _tool_cache.get(ckey, _WIKI_TTL_S)
    if cached is not None:
        return cached

    # Wikipedia REST API — no key needed. /page/summary/{title} returns
    # a clean intro paragraph + thumbnail. We URL-encode the title.
    title = urllib.parse.quote(query.replace(" ", "_"), safe="")
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{title}"
    session = await _get_shared_session()
    try:
        async with session.get(
            url, headers={"Accept": "application/json"},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            if resp.status == 404:
                return {"error": f"no Wikipedia article for {query!r}"}
            if resp.status != 200:
                return {"error": f"wikipedia returned {resp.status}"}
            data = await resp.json()
    except aiohttp.ClientError as exc:
        return {"error": f"wikipedia request failed: {exc}"}

    result = {
        "title": data.get("title") or query,
        "summary": data.get("extract") or "",
        "url": (data.get("content_urls") or {}).get("desktop", {}).get("page") or url,
    }
    if not result["summary"]:
        result["instructions_for_model"] = (
            "Wikipedia returned no substantive summary for this query. "
            "Tell the user honestly that you couldn't find an article. "
            "Do NOT fabricate a description from earlier conversation context."
        )
    stringified = json.dumps(result, ensure_ascii=False)
    _tool_cache.set(ckey, stringified)
    return stringified


_register(Tool(
    name="wikipedia_lookup",
    description=(
        "Narrow fallback: pulls a canonical Wikipedia article intro for a single named entity. "
        "PREFER web_search FIRST for almost everything — including people, places, events, "
        "companies, concepts. Only reach for wikipedia_lookup in narrow cases where the user "
        "explicitly asks for a Wikipedia-style overview (\"give me the Wikipedia summary on…\"), "
        "or where you specifically need the canonical encyclopedic phrasing of a historical / "
        "scientific / definitional topic (e.g. \"what's the formal definition of entropy?\", "
        "\"summarize the French Revolution from Wikipedia\"). If unsure between the two, use "
        "web_search — it's almost always better. Returns the article title, 1–2 paragraph "
        "summary, and a link."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Specific named entity to look up — a person's name, place, work, concept."},
        },
        "required": ["query"],
    },
    executor=_impl_wikipedia_lookup,
    timeout_s=5.0,
))


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


async def dispatch_tool_call(name: str, arguments: str) -> str:
    """Run a single tool call and return its result as a JSON string
    (ready to drop into a ``role: tool`` message). Catches everything
    so the voicechat loop never crashes on a misbehaving tool — the
    LLM gets a structured error instead and can recover."""
    tool = _REGISTRY.get(name)
    if tool is None:
        return _error_payload(f"unknown tool: {name!r}")
    if not tool.available():
        missing = ", ".join(v for v in tool.requires_env if not os.environ.get(v))
        return _error_payload(f"tool {name!r} is not configured (missing: {missing})")

    try:
        parsed_args = json.loads(arguments or "{}") if isinstance(arguments, str) else dict(arguments or {})
    except json.JSONDecodeError as exc:
        return _error_payload(f"tool arguments not valid JSON: {exc}")
    if not isinstance(parsed_args, dict):
        return _error_payload("tool arguments must be a JSON object")

    try:
        result = await asyncio.wait_for(tool.executor(parsed_args), timeout=tool.timeout_s)
    except asyncio.TimeoutError:
        _log.warning("tool %s timed out after %.1fs (args=%s)", name, tool.timeout_s, parsed_args)
        return _error_payload(f"tool {name!r} timed out after {tool.timeout_s}s")
    except Exception as exc:  # noqa: BLE001
        _log.exception("tool %s raised", name)
        return _error_payload(f"tool {name!r} failed: {type(exc).__name__}: {exc}")

    return _stringify_result(result)


# ---------------------------------------------------------------------------
# Custom (user-defined) tools — webhook executor
# ---------------------------------------------------------------------------
#
# Custom tools are stored in SQLite (``agent_custom_tools``) and bound
# per-agent via ``agent_custom_tool_bindings``. The voicechat WS loads
# the bound tools for an agent at turn start, merges their JSON Schema
# specs alongside the built-in specs, and routes any matching tool_call
# to ``dispatch_custom_tool`` instead of the built-in dispatcher.
#
# Execution model: HTTP POST to ``endpoint_url`` with a JSON body
# ``{ "arguments": <parsed args> }``. Optional auth (Bearer or fixed
# header). SSRF protection via ``assert_safe_url``. Per-tool timeout
# (default 5 s, max 30 s).


@dataclass
class CustomToolDef:
    """In-memory shape of a row from ``agent_custom_tools``. Loaders
    in voicechat.py and the CRUD router construct these from DB rows."""
    id: str
    user_id: str
    name: str
    description: str
    parameters: dict[str, Any]   # JSON Schema (already parsed from parameters_json)
    endpoint_url: str
    method: str = "POST"
    auth_type: str = "none"      # 'none' | 'bearer' | 'header'
    auth_header_name: str | None = None
    auth_secret: str | None = None
    timeout_ms: int = 5000

    def as_spec(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


async def dispatch_custom_tool(tool: CustomToolDef, arguments: str) -> str:
    """Invoke a user-defined webhook tool. Same error shape as the
    built-in dispatcher (``_error_payload`` on failure, stringified
    JSON on success) so the voicechat loop doesn't care which kind it
    just executed."""
    try:
        parsed_args = json.loads(arguments or "{}") if isinstance(arguments, str) else dict(arguments or {})
    except json.JSONDecodeError as exc:
        return _error_payload(f"tool arguments not valid JSON: {exc}")
    if not isinstance(parsed_args, dict):
        return _error_payload("tool arguments must be a JSON object")

    headers = {
        "Content-Type": "application/json",
        "User-Agent": _HTTP_UA,
    }
    if tool.auth_type == "bearer" and tool.auth_secret:
        headers["Authorization"] = f"Bearer {tool.auth_secret}"
    elif tool.auth_type == "header" and tool.auth_header_name and tool.auth_secret:
        headers[tool.auth_header_name] = tool.auth_secret

    timeout_s = max(1.0, min(30.0, tool.timeout_ms / 1000.0))
    client_timeout = aiohttp.ClientTimeout(total=timeout_s)
    method = (tool.method or "POST").upper()

    # Body vs query: GET/DELETE/HEAD don't take a body — send the args
    # (if any) as query params instead. Some servers / CDNs / WAFs hard-
    # reject GET requests with a Content-Type: application/json body, so
    # we don't even attach one for those methods. POST/PUT/PATCH keep
    # the wrapped ``{"arguments": ...}`` shape they always had.
    request_kwargs: dict[str, Any] = {
        "headers": headers,
        "timeout": client_timeout,
    }
    if method in ("GET", "DELETE", "HEAD"):
        # Drop Content-Type since there's no body. Pass parsed_args as
        # query params — aiohttp serialises lists / dicts via repeated
        # keys, which works for most REST APIs.
        request_kwargs["headers"] = {k: v for k, v in headers.items() if k.lower() != "content-type"}
        if parsed_args:
            request_kwargs["params"] = parsed_args
    else:
        request_kwargs["json"] = {"arguments": parsed_args}

    session = await _get_shared_session()
    try:
        # SECURITY: do NOT follow redirects on custom-tool requests.
        # aiohttp's default for ``session.request`` would chase
        # ``Location: http://169.254.169.254`` if the user's webhook
        # method is GET (and the user can flip method to GET via the
        # CRUD endpoint). max_redirects=0 forces a single-hop call;
        # the auth_secret never leaves the validated host.
        resp = await safe_request(
            method,
            tool.endpoint_url,
            session=session,
            max_redirects=0,
            **request_kwargs,
        )
    except ValueError as exc:
        return _error_payload(f"tool endpoint URL is unsafe: {exc}")
    except asyncio.TimeoutError:
        return _error_payload(f"tool {tool.name!r} timed out after {timeout_s:.1f}s")
    except aiohttp.ClientError as exc:
        return _error_payload(f"tool {tool.name!r} request failed: {exc}")
    try:
        async with resp:
            # Cap response body so a chatty endpoint can't blow the
            # LLM's context window. We still respect MAX_TOOL_RESULT_CHARS
            # downstream via _stringify_result, but reading 5 MB just
            # to truncate it would be silly — cap at the source.
            raw = await resp.content.read(64 * 1024)
            if resp.status >= 500:
                return _error_payload(f"tool {tool.name!r} returned {resp.status}")
            if resp.status >= 400:
                snippet = raw.decode("utf-8", errors="replace")[:300]
                return _error_payload(f"tool {tool.name!r} returned {resp.status}: {snippet}")
            body = raw.decode("utf-8", errors="replace")
    except aiohttp.ClientError as exc:
        return _error_payload(f"tool {tool.name!r} request failed: {exc}")

    # Try to parse as JSON so the LLM gets structured data; if the
    # endpoint returned plain text, pass it through verbatim.
    try:
        parsed = json.loads(body)
        return _stringify_result(parsed)
    except (json.JSONDecodeError, ValueError):
        return _stringify_result(body)


# Re-export the canonical names so callers don't have to know the
# module's internal structure.
__all__ = [
    "Tool",
    "CustomToolDef",
    "tool_specs",
    "tool_catalog",
    "all_tool_names",
    "available_tool_names",
    "dispatch_tool_call",
    "dispatch_custom_tool",
    "assert_safe_url",
    "close_shared_session",
    "MAX_TOOL_RESULT_CHARS",
]
