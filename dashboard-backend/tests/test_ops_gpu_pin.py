"""Tests for the multi-GPU pinning logic in ops.

Covers:
  * docker_run emits ``--gpus all`` when gpu_index is None (back-compat
    with single-GPU hosts).
  * docker_run emits ``--gpus '"device=N"'`` when gpu_index is set.
  * insert_pod persists gpu_index correctly.
  * ensure_ops_tables idempotently adds the gpu_index column to pre-
    existing ops_pods tables (migration path for live DBs).
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-" + "x" * 40)
os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-internal-" + "y" * 40)

# Isolated DB so we don't tread on the email-auth tests.
_DB = tempfile.NamedTemporaryFile(delete=False, suffix="_ops_gpu.db")
_DB.close()
os.environ["SQLITE_PATH"] = _DB.name

from ops import db as ops_db  # noqa: E402
from ops import ssh as ops_ssh  # noqa: E402
from local_db import ensure_tables, get_connection  # noqa: E402


@pytest.fixture
async def db():
    """Fresh schema for each test. Idempotent ensure_* calls so the
    file gets reused across tests with state reset between them."""
    await ensure_tables()
    await ops_db.ensure_ops_tables()
    conn = await get_connection()
    try:
        await conn.execute("DELETE FROM ops_pods")
        await conn.execute("DELETE FROM ops_servers")
        await conn.commit()
    finally:
        await conn.close()
    yield


@pytest.mark.asyncio
async def test_docker_run_command_emits_gpus_all_when_no_index(monkeypatch):
    """Audit: docker_run with gpu_index=None must produce ``--gpus all``
    so existing single-GPU deployments keep working unchanged."""
    captured: dict[str, str] = {}

    async def fake_run_command(server, cmd, **kwargs):
        captured["cmd"] = cmd
        class _Res:
            stdout = "fake_container_id_123"
        return _Res()

    monkeypatch.setattr(ops_ssh, "run_command", fake_run_command)
    await ops_ssh.docker_run(
        {"id": 1, "host": "h"},
        container_name="vocence-stt-1",
        image="vocence/stt:latest",
        host_port=8114,
        container_port=8114,
        env={"STT_API_KEY": "k"},
        gpu_index=None,
    )
    assert "--gpus all" in captured["cmd"]
    assert "device=" not in captured["cmd"]


@pytest.mark.asyncio
async def test_docker_run_command_pins_gpu_when_index_set(monkeypatch):
    """Audit: docker_run with gpu_index=N must emit
    ``--gpus '"device=N"'`` so the container sees only that one GPU.
    Without this, every container on a multi-GPU host defaults to
    cuda:0 and they all pile onto the same physical card."""
    captured: dict[str, str] = {}

    async def fake_run_command(server, cmd, **kwargs):
        captured["cmd"] = cmd
        class _Res:
            stdout = "fake_container_id_456"
        return _Res()

    monkeypatch.setattr(ops_ssh, "run_command", fake_run_command)
    await ops_ssh.docker_run(
        {"id": 1, "host": "h"},
        container_name="vocence-stt-1",
        image="vocence/stt:latest",
        host_port=8114,
        container_port=8114,
        env={"STT_API_KEY": "k"},
        gpu_index=3,
    )
    assert "--gpus '\"device=3\"'" in captured["cmd"]
    assert "--gpus all" not in captured["cmd"]


@pytest.mark.asyncio
async def test_insert_pod_persists_gpu_index(db):
    server_id = await ops_db.insert_server(
        name="rtx4090-box",
        host="10.0.0.5",
        ssh_user="root",
        ssh_port=22,
        ssh_private_key_enc=None,
        hourly_cost_usd=0.0,
        notes=None,
    )
    pod_id = await ops_db.insert_pod(
        server_id=server_id,
        name="stt-on-gpu-3",
        service="stt",
        image="vocence/stt:latest",
        port=8114,
        api_key_enc="enc",
        extra_env_enc="enc",
        gpu_index=3,
    )
    row = await ops_db.get_pod(pod_id)
    assert row is not None
    assert row["gpu_index"] == 3


@pytest.mark.asyncio
async def test_insert_pod_gpu_index_defaults_to_null(db):
    """Back-compat: omitting gpu_index stores NULL → docker_run's
    --gpus all path runs unchanged."""
    server_id = await ops_db.insert_server(
        name="single-gpu",
        host="10.0.0.6",
        ssh_user="root",
        ssh_port=22,
        ssh_private_key_enc=None,
        hourly_cost_usd=0.0,
        notes=None,
    )
    pod_id = await ops_db.insert_pod(
        server_id=server_id,
        name="legacy-stt",
        service="stt",
        image="vocence/stt:latest",
        port=8114,
        api_key_enc="enc",
        extra_env_enc="enc",
        # gpu_index omitted → default None
    )
    row = await ops_db.get_pod(pod_id)
    assert row is not None
    assert row["gpu_index"] is None


@pytest.mark.asyncio
async def test_ensure_ops_tables_migrates_existing_ops_pods_without_gpu_index():
    """Migration regression: a pre-existing ops_pods table without
    the gpu_index column must gain it via the _ensure_column path."""
    conn = await get_connection()
    try:
        # Drop the table and recreate WITHOUT the gpu_index column to
        # simulate the pre-migration state.
        await conn.execute("DROP TABLE IF EXISTS ops_pods")
        await conn.execute(
            """
            CREATE TABLE ops_pods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER NOT NULL REFERENCES ops_servers(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                service TEXT NOT NULL,
                image TEXT NOT NULL,
                port INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'deploying',
                deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        await conn.commit()
    finally:
        await conn.close()

    # Run the migration.
    await ops_db.ensure_ops_tables()

    # Verify the column now exists.
    conn = await get_connection()
    try:
        cur = await conn.execute("PRAGMA table_info(ops_pods)")
        cols = {row[1] for row in await cur.fetchall()}
        assert "gpu_index" in cols
    finally:
        await conn.close()
