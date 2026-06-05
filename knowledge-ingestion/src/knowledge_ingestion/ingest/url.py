"""Web-page parser using ``trafilatura`` for main-content extraction.

``trafilatura`` is the standard open-source library for "give me the
actual article text, skipping nav and footer." It works well across a
broad spectrum of CMSes (WordPress, docs sites, blogs) without
per-site configuration.

For URL crawls we support max_depth = 0 (this page only) and
max_depth = 1 (this page + same-origin links one hop deep). Anything
beyond is rejected at the API layer — crawling deep is a different
problem with different failure modes (crawl traps, JS-rendered pages,
politeness) and v1 punts.
"""

from __future__ import annotations

import logging
from urllib.parse import urljoin, urlparse

import httpx
import trafilatura

from . import ChunkInput
from .chunker import normalize_whitespace, split_text


_log = logging.getLogger(__name__)


async def parse_url(
    url: str, title: str | None, *, max_depth: int = 0,
) -> list[ChunkInput]:
    """Fetch + extract main content from a URL. ``max_depth=1`` follows
    same-origin links one hop deep with at most 20 pages — beyond that
    operators should use ``parse_sitemap``."""
    if max_depth not in (0, 1):
        raise ValueError("max_depth must be 0 or 1")
    urls = [url]
    if max_depth == 1:
        # Best-effort link discovery — fetch the seed page, find
        # same-origin links, cap at 20. We don't follow further
        # because deep crawls without rate-limit awareness get pods
        # banned from servers fast.
        seed_html = await _fetch_html(url)
        if seed_html:
            urls = [url] + _discover_same_origin_links(seed_html, url, cap=20)

    chunks: list[ChunkInput] = []
    for u in urls:
        text = await _extract_text(u)
        if not text:
            continue
        md = {"source_title": title or u, "url": u}
        for piece in split_text(normalize_whitespace(text)):
            chunks.append(ChunkInput(text=piece, metadata=dict(md)))
    return chunks


async def _fetch_html(url: str, *, timeout: float = 15.0) -> str | None:
    """GET a URL with a sensible user-agent + timeout. Returns the body
    text, or ``None`` if anything went wrong (non-2xx, network error,
    etc.) — we never want one bad URL to fail the whole job."""
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            r = await client.get(
                url,
                headers={
                    "User-Agent": "Vocence-Knowledge-Ingestion/0.1 (+https://vocence.ai)"
                },
            )
            if r.status_code >= 400:
                _log.info("url fetch failed: %s → %d", url, r.status_code)
                return None
            return r.text
    except Exception as exc:  # noqa: BLE001
        _log.info("url fetch errored: %s → %s", url, exc)
        return None


async def _extract_text(url: str) -> str | None:
    """Fetch + run trafilatura. Returns the cleaned main-content text
    or None when extraction yields nothing useful."""
    html = await _fetch_html(url)
    if not html:
        return None
    # ``include_comments=False`` drops user comment sections (rarely
    # useful as authoritative knowledge). ``no_fallback=False`` falls
    # back to a simpler extractor if the main pipeline returns nothing
    # — most likely on heavily JS-rendered pages.
    extracted = trafilatura.extract(
        html,
        url=url,
        include_comments=False,
        include_tables=True,
        no_fallback=False,
    )
    return extracted or None


def _discover_same_origin_links(html: str, base_url: str, *, cap: int) -> list[str]:
    """Pull same-origin ``<a href=...>`` links from a page. Returns
    absolute URLs, de-duplicated, capped at ``cap`` items."""
    from bs4 import BeautifulSoup

    base_origin = urlparse(base_url).netloc
    soup = BeautifulSoup(html, "html.parser")
    seen: set[str] = set()
    out: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        abs_url = urljoin(base_url, href)
        parsed = urlparse(abs_url)
        if parsed.netloc != base_origin:
            continue
        # Normalise: drop the fragment.
        normalised = parsed._replace(fragment="").geturl()
        if normalised in seen or normalised == base_url:
            continue
        seen.add(normalised)
        out.append(normalised)
        if len(out) >= cap:
            break
    return out
