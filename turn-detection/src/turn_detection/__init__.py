"""Vocence turn-detection pod.

Bundles Pipecat Smart Turn v3 (audio EOU) and LiveKit Turn Detector v2
(text EOU) behind one FastAPI service with two WebSocket endpoints +
two REST batch endpoints.

Entrypoint: ``turn_detection.server:app`` (ASGI).
"""

__version__ = "0.1.0"
