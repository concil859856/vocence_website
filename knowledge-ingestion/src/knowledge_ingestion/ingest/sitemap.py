"""Sitemap XML parser — discover URLs, fetch each, extract content.

Standard sitemap format (sitemaps.org). We support:
  • ``<urlset>`` flat sitemaps (one or many ``<loc>`` entries)
  • ``<sitemapindex>`` nested sitemaps (we fetch each child)
  • include / exclude glob filters on the URL path
  • per-job page cap

Concurrency cap of 4 simultaneous fetches per job — enough to keep the
pipeline moving without hammering the origin. Each child URL is
processed via ``url.py``'s extractor.
"""

from __future__ import annotations

import asyncio
import logging
import re
from urllib.parse import urlparse

import httpx
from lxml import etree

from . import ChunkInput
from .chunker import normalize_whitespace, split_text
from .url import _extract_text  # type: ignore[attr-defined]


_log = logging.getLogger(__name__)


# Per-job concurrency cap — keeps memory and outbound socket count
# bounded even on a 500-page sitemap.
_FETCH_CONCURRENCY = 4


async def parse_sitemap(
    sitemap_url: str,
    *,
    title: str | None,
    include: list[str] | None,
    exclude: list[str] | None,
    max_pages: int,
) -> list[ChunkInput]:
    """Discover URLs from a sitemap, filter, fetch + extract each."""
    raw_urls = await _discover(sitemap_url, max_pages=max_pages * 4)  # over-collect
    filtered = _filter_urls(raw_urls, include, exclude)[:max_pages]
    if not filtered:
        return []

    sem = asyncio.Semaphore(_FETCH_CONCURRENCY)

    async def _one(u: str) -> tuple[str, str | None]:
        async with sem:
            return u, await _extract_text(u)

    results = await asyncio.gather(*(_one(u) for u in filtered))

    chunks: list[ChunkInput] = []
    for url, text in results:
        if not text:
            continue
        md = {"source_title": title or sitemap_url, "url": url}
        for piece in split_text(normalize_whitespace(text)):
            chunks.append(ChunkInput(text=piece, metadata=dict(md)))
    return chunks


async def _discover(sitemap_url: str, *, max_pages: int) -> list[str]:
    """Fetch a sitemap (or sitemap-index), return a flat list of page
    URLs. Resolves ``<sitemapindex>`` one level deep — we don't recurse
    further to avoid sitemap-bomb pathology."""
    xml_text = await _fetch(sitemap_url)
    if not xml_text:
        return []
    urls = _extract_urls_from_xml(xml_text)
    # If those URLs are themselves sitemaps (e.g. ``sitemap-1.xml``),
    # walk one more level.
    flat: list[str] = []
    sub_sitemap_pattern = re.compile(r"sitemap.*\.xml(\.gz)?$", re.IGNORECASE)
    for u in urls:
        if len(flat) >= max_pages:
            break
        if sub_sitemap_pattern.search(urlparse(u).path):
            sub = await _fetch(u)
            if sub:
                flat.extend(_extract_urls_from_xml(sub))
        else:
            flat.append(u)
    return flat[:max_pages]


async def _fetch(url: str, *, timeout: float = 20.0) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as c:
            r = await c.get(
                url,
                headers={
                    "User-Agent": "Vocence-Knowledge-Ingestion/0.1 (+https://vocence.ai)",
                    "Accept": "application/xml,text/xml",
                },
            )
            if r.status_code >= 400:
                _log.info("sitemap fetch %s → %d", url, r.status_code)
                return None
            return r.text
    except Exception as exc:  # noqa: BLE001
        _log.info("sitemap fetch errored %s → %s", url, exc)
        return None


def _extract_urls_from_xml(xml_text: str) -> list[str]:
    """Parse a sitemap XML body, return all ``<loc>`` values regardless
    of whether the outer element is ``<urlset>`` or ``<sitemapindex>``."""
    try:
        root = etree.fromstring(xml_text.encode("utf-8"))
    except etree.XMLSyntaxError:
        return []
    # Use a wildcard namespace match — sitemaps usually declare the
    # standard sitemaps.org namespace but some don't.
    out: list[str] = []
    for elem in root.iter():
        # ``localname`` extraction works regardless of namespace prefix.
        if etree.QName(elem).localname == "loc" and elem.text:
            out.append(elem.text.strip())
    return out


def _filter_urls(
    urls: list[str], include: list[str] | None, exclude: list[str] | None
) -> list[str]:
    """Apply include / exclude glob filters on URL PATH only.

    ``include`` is a positive list — if non-empty, only URLs whose path
    matches at least one pattern survive. ``exclude`` is a negative
    list — URLs matching any pattern are dropped.
    """
    inc_re = _compile_globs(include) if include else None
    exc_re = _compile_globs(exclude) if exclude else None

    out: list[str] = []
    for u in urls:
        path = urlparse(u).path
        if inc_re and not inc_re.search(path):
            continue
        if exc_re and exc_re.search(path):
            continue
        out.append(u)
    return out


def _compile_globs(patterns: list[str]) -> re.Pattern[str]:
    """Convert a list of shell-style globs (``/docs/*``) into a single
    compiled regex matching any of them."""
    import fnmatch

    parts = [fnmatch.translate(p) for p in patterns]
    return re.compile("|".join(parts))
