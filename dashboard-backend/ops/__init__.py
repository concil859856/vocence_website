"""Vocence ops package — fleet manager for GPU service pods.

This is the in-backend control plane the user interacts with via
``/studio/ops``. It owns:

* The pod & server registry (in SQLite tables under the existing
  ``website.db``).
* The SSH wrapper used to remotely run ``docker pull``/``docker run`` on
  rented GPU boxes.
* The background pollers that scrape ``/healthz`` + ``/metrics`` from each
  registered pod and roll the counters up into daily aggregates.
* A dispatcher (``pick_pod``) that any service caller (voicechat,
  studio_tts, music, stt) uses to find the least-loaded healthy pod for
  a given service, subject to a 2*N global cap.

Designed to replace static ``QWEN3_CLONE_BASE_URL`` etc. env vars with a
live pool. The static envs still work as fallback when no pods are
registered for that service.
"""
