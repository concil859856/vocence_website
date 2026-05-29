"""Vocence knowledge ingestion service.

Per-agent RAG layer: ingest PDFs / URLs / sitemaps / text / markdown,
embed and store in LanceDB, serve top-K retrieval queries per turn.

Entrypoint: ``knowledge_ingestion.server:app`` (ASGI).
"""

__version__ = "0.1.0"
