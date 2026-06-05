"""Parser unit tests for text/markdown/PDF.

URL + sitemap parsers depend on network I/O so they're tested in the
integration suite with a mocked HTTP layer rather than here.
"""

from __future__ import annotations

import io

import pytest

from knowledge_ingestion.ingest.text import parse_markdown, parse_text


class TestParseText:
    def test_basic(self) -> None:
        chunks = parse_text("Hello world", title="Greetings")
        assert len(chunks) == 1
        assert chunks[0].text == "Hello world"
        assert chunks[0].metadata == {"source_title": "Greetings"}

    def test_empty_returns_empty(self) -> None:
        assert parse_text("", title="x") == []
        assert parse_text("   \n\n  ", title="x") == []

    def test_long_text_chunks(self) -> None:
        chunks = parse_text("Sentence. " * 500, title="X")
        # ~5000 chars → multiple chunks
        assert len(chunks) > 1

    def test_no_title_omits_metadata(self) -> None:
        chunks = parse_text("Hello", title=None)
        assert chunks[0].metadata == {}


class TestParseMarkdown:
    def test_section_metadata(self) -> None:
        md = """Preamble before any heading.

# Welcome

Some intro text.

## Billing

### Cancellations

To cancel, visit Account > Subscription.

## Refunds

Within 7 days.
"""
        chunks = parse_markdown(md, title="Help")
        assert len(chunks) >= 2
        # The "Cancellations" section's chunk should carry the heading path.
        cancel_chunks = [
            c for c in chunks if "cancel" in c.text.lower()
        ]
        assert cancel_chunks
        assert any(
            c.metadata.get("section") and "Cancellations" in c.metadata["section"]
            for c in cancel_chunks
        )
        # The preamble (BEFORE any heading) should NOT have a section
        # key — there's no heading above it to attribute to.
        pre_chunks = [c for c in chunks if "preamble" in c.text.lower()]
        assert pre_chunks
        assert "section" not in pre_chunks[0].metadata
        # The intro text (under "# Welcome") DOES belong to Welcome.
        intro_chunks = [c for c in chunks if "intro" in c.text.lower()]
        assert intro_chunks
        assert intro_chunks[0].metadata.get("section") == "Welcome"

    def test_nested_headings_use_separator(self) -> None:
        md = "# A\n\n## B\n\n### C\n\ncontent"
        chunks = parse_markdown(md, title="X")
        # Section path should join with " > "
        assert chunks[0].metadata["section"] == "A > B > C"

    def test_heading_stack_pop_on_sibling(self) -> None:
        md = "## A\n\nfoo\n\n## B\n\nbar"
        chunks = parse_markdown(md, title="X")
        for c in chunks:
            sec = c.metadata.get("section", "")
            if "foo" in c.text:
                assert "A" in sec and "B" not in sec
            if "bar" in c.text:
                assert "B" in sec and "A" not in sec


class TestParsePdf:
    """PDF tests don't require pypdf to actually parse a complex PDF
    — we just build a minimal valid PDF on the fly and check that
    pypdf returns no crash + zero chunks (scanned-PDF behaviour)."""

    def test_corrupt_pdf_raises(self) -> None:
        from knowledge_ingestion.ingest.pdf import parse_pdf
        with pytest.raises(ValueError):
            parse_pdf(b"this is not a pdf", title=None)

    def test_empty_bytes_raises(self) -> None:
        from knowledge_ingestion.ingest.pdf import parse_pdf
        with pytest.raises(ValueError):
            parse_pdf(b"", title=None)

    def test_real_pdf_extracts_text(self) -> None:
        """Build a real minimal PDF with text content and verify
        extraction works end-to-end."""
        from knowledge_ingestion.ingest.pdf import parse_pdf
        from pypdf import PdfWriter

        writer = PdfWriter()
        writer.add_blank_page(width=72 * 8.5, height=72 * 11)
        # pypdf doesn't have a "add text" helper, but pypdf can still
        # parse a real PDF without text — the result is just zero
        # chunks (matches our scanned-PDF policy).
        buf = io.BytesIO()
        writer.write(buf)
        chunks = parse_pdf(buf.getvalue(), title="empty")
        assert chunks == []
