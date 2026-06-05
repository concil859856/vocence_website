"""PDF parser using ``pypdf``.

We use ``pypdf`` rather than the heavier ``unstructured`` library for
two reasons:
  1. Image-free install (~1 MB vs ~2 GB) keeps the container small.
  2. For most prose PDFs (handbooks, FAQs, docs PDFs) pypdf's plain
     text extraction is acceptable.

For PDFs that are scanned images, pypdf returns empty text — we surface
a warning in the job's status and yield zero chunks rather than failing.
Customers with image-only PDFs should run them through OCR first
(separate concern; not v1).

Page-level metadata is preserved on each chunk so the LLM can cite
"Handbook page 42, section X".
"""

from __future__ import annotations

import io
import logging

from . import ChunkInput
from .chunker import normalize_whitespace, split_text


_log = logging.getLogger(__name__)


def parse_pdf(file_bytes: bytes, title: str | None) -> list[ChunkInput]:
    """Parse a PDF file body into chunks with per-page metadata.

    Chunks are produced one page at a time, then the chunker splits any
    long page into multiple sub-chunks. Short pages are emitted as a
    single chunk each. The page number is tagged on every chunk so
    cross-page coalescing doesn't lose source attribution.
    """
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(file_bytes))
    except Exception as exc:  # noqa: BLE001
        # Corrupt/encrypted PDFs — surface a clear error rather than
        # producing zero chunks silently.
        raise ValueError(f"could not parse PDF: {exc}") from exc

    out: list[ChunkInput] = []
    for page_num, page in enumerate(reader.pages, start=1):
        try:
            page_text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001
            # Per-page extraction can fail on garbled PDFs without
            # killing the whole document — log and continue.
            _log.warning("pdf parse: page %d errored (%s); skipping", page_num, exc)
            continue
        page_text = normalize_whitespace(page_text)
        if not page_text:
            continue
        for piece in split_text(page_text):
            md: dict = {"page": page_num}
            if title:
                md["source_title"] = title
            out.append(ChunkInput(text=piece, metadata=md))

    if not out:
        _log.warning(
            "pdf parse: %d-page document produced 0 chunks — likely scanned image PDF",
            len(reader.pages),
        )
    return out
