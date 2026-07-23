"""OKX AI Marketplace integration — Vocence as an A2MCP ASP.

Exposes Vocence's voice tools as a payment-gated MCP merchant surface for the
OKX AI Marketplace. Each tool call is monetized per-call via OKX's x402 Payment
SDK (HTTP 402), settling a stablecoin on X Layer to our Agentic Wallet.

This is a SEPARATE surface from the ``voc_live_`` developer API:
  * developer API — human/dev users, API-key auth, credits deducted
  * OKX MCP       — buyer agents, payment IS the auth, no credits, crypto pay

Both proxy to the same dashboard backend; only the front gate differs.

Everything here is inert unless configured (OKX creds + wallet + the x402
package installed), so the module imports and the app boots in every
environment — the marketplace surface simply reports unavailable until wired.
"""
