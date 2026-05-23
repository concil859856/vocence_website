"""Vocence Studio /ops admin endpoints.

All routes here gate on ``require_admin_session`` so only addresses in
ADMIN_EMAIL can see/modify the fleet.

Surface (mounted at ``/api/dashboard/ops``):

  GET    /servers                  list servers + lightweight per-server stats
  POST   /servers                  add a new server (SSH probe runs synchronously)
  DELETE /servers/{id}             soft-delete (also tombstones its pods)
  POST   /servers/{id}/probe       re-run probe_server (refresh GPU info)

  GET    /pods                     list pods + current load + today's stats
  POST   /pods                     deploy a service to a server (docker pull + run)
  POST   /pods/{id}/stop           docker stop
  POST   /pods/{id}/restart        docker restart
  POST   /pods/{id}/update         docker pull + restart (rolling update)
  POST   /pods/{id}/drain          mark drain_requested=1 (dispatcher skips)
  DELETE /pods/{id}                drain + stop + remove (tombstones row)
  GET    /pods/{id}/logs           docker logs (last N lines)

  GET    /overview                 fleet tiles for the Studio dashboard
  GET    /dispatcher               live in-memory pool state
  GET    /pods/{id}/timeseries     per-minute series for charts
  GET    /events                   recent ops_pod_events
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import ops.crypto as ops_crypto
import ops.db as ops_db
import ops.docker_hub as ops_docker_hub
import ops.pool as ops_pool
import ops.ssh as ops_ssh
from routers.auth import require_admin_session

_log = logging.getLogger(__name__)
router = APIRouter(prefix="/ops", tags=["ops"])


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

_ENV_KEY_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")


def _validate_env(env: dict[str, str]) -> None:
    """Reject env-var keys that aren't safe to interpolate into ``docker run``.
    Values can be anything; ssh.docker_run shell-quotes them."""
    for k in env:
        if not _ENV_KEY_RE.match(k):
            raise HTTPException(status_code=400, detail=f"invalid env key: {k!r} (must match [A-Z_][A-Z0-9_]+)")


def _validate_name(name: str) -> None:
    if not _NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=f"invalid name {name!r}: must be lowercase a-z 0-9 -, 2-64 chars",
        )


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ServerIn(BaseModel):
    name: str = Field(..., description="Display name; lowercase letters/digits/-")
    host: str = Field(..., description="IP or DNS")
    ssh_user: str = "root"
    ssh_port: int = 22
    ssh_private_key: str | None = Field(
        None,
        description="Per-server SSH private key (PEM). When None, the platform "
                    "key at OPS_SSH_PRIVATE_KEY_PATH is used.",
    )
    hourly_cost_usd: float = 0.0
    notes: str | None = None


class PodDeployIn(BaseModel):
    server_id: int
    name: str
    service: str = Field(..., description=f"one of {ops_db.SERVICE_NAMES}")
    image: str = Field(..., description="docker.io/<ns>/<repo>:<tag>")
    port: int
    api_key: str | None = Field(
        None,
        description="Bearer token the pod will require on /healthz, /metrics, "
                    "and its main endpoint. Auto-generated if omitted.",
    )
    extra_env: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# /servers
# ---------------------------------------------------------------------------

@router.get("/servers")
async def list_servers_endpoint(_: str = Depends(require_admin_session)) -> dict:
    servers = await ops_db.list_servers()
    out: list[dict] = []
    for s in servers:
        pods = await ops_db.list_pods(server_id=int(s["id"]), statuses=(
            "deploying", "online", "unhealthy", "restarting", "draining",
        ))
        sd = dict(s)
        # Don't leak the encrypted private key to the UI.
        sd.pop("ssh_private_key_enc", None)
        sd["pod_count"] = len(pods)
        sd["pods_summary"] = [
            {
                "id": p["id"],
                "name": p["name"],
                "service": p["service"],
                "port": p["port"],
                "status": p["status"],
            }
            for p in pods
        ]
        out.append(sd)
    return {"servers": out}


@router.post("/servers")
async def add_server(body: ServerIn, _: str = Depends(require_admin_session)) -> dict:
    _validate_name(body.name)
    if not ops_crypto.is_configured() and body.ssh_private_key:
        raise HTTPException(status_code=503, detail="OPS_FERNET_KEY not set on backend — cannot store per-server SSH key")

    enc_key = ops_crypto.encrypt(body.ssh_private_key) if body.ssh_private_key else None

    try:
        server_id = await ops_db.insert_server(
            name=body.name,
            host=body.host,
            ssh_user=body.ssh_user,
            ssh_port=body.ssh_port,
            ssh_private_key_enc=enc_key,
            hourly_cost_usd=body.hourly_cost_usd,
            notes=body.notes,
        )
    except Exception as e:
        # Most likely UNIQUE constraint on name.
        raise HTTPException(status_code=400, detail=f"could not insert server: {e}")

    # Synchronously probe so the admin sees ready/unreachable immediately
    # instead of a forever-pending row.
    server = await ops_db.get_server(server_id)
    assert server is not None
    try:
        probe = await ops_ssh.probe_server(server)
        await ops_db.update_server_status(
            server_id,
            status="ready",
            last_seen_at=__import__("datetime").datetime.utcnow().isoformat() + "Z",
            docker_version=probe.get("docker_version"),
            gpu_info_json=json.dumps(probe.get("gpu_info", [])),
        )
        await ops_db.log_pod_event(None, "server_added", f"server {body.name} probed ok", probe)
    except ops_ssh.SshError as e:
        await ops_db.update_server_status(server_id, status="unreachable")
        await ops_db.log_pod_event(None, "server_probe_failed", f"server {body.name}: {e}")
        # Don't 5xx — admin still wants to see the server row, and the
        # error message comes back in the response.
        server = await ops_db.get_server(server_id)
        srv = dict(server or {})
        srv.pop("ssh_private_key_enc", None)
        return {"server": srv, "probe_error": str(e)}

    server = await ops_db.get_server(server_id)
    srv = dict(server or {})
    srv.pop("ssh_private_key_enc", None)
    return {"server": srv}


@router.delete("/servers/{server_id}")
async def remove_server(server_id: int, _: str = Depends(require_admin_session)) -> dict:
    server = await ops_db.get_server(server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="server not found")
    await ops_db.soft_delete_server(server_id)
    # Drop the cached SSH connection so the next add of a new server at
    # the same id doesn't reuse stale creds.
    await ops_ssh.close_connection(server_id)
    await ops_db.log_pod_event(None, "server_removed", server["name"])
    return {"ok": True}


@router.post("/servers/{server_id}/probe")
async def reprobe_server(server_id: int, _: str = Depends(require_admin_session)) -> dict:
    server = await ops_db.get_server(server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="server not found")
    try:
        probe = await ops_ssh.probe_server(server)
        await ops_db.update_server_status(
            server_id,
            status="ready",
            last_seen_at=__import__("datetime").datetime.utcnow().isoformat() + "Z",
            docker_version=probe.get("docker_version"),
            gpu_info_json=json.dumps(probe.get("gpu_info", [])),
        )
        return {"server": await ops_db.get_server(server_id), "probe": probe}
    except ops_ssh.SshError as e:
        await ops_db.update_server_status(server_id, status="unreachable")
        raise HTTPException(status_code=502, detail=str(e))


# ---------------------------------------------------------------------------
# /pods
# ---------------------------------------------------------------------------

@router.get("/pods")
async def list_pods_endpoint(
    service: str | None = None,
    server_id: int | None = None,
    _: str = Depends(require_admin_session),
) -> dict:
    statuses = ("deploying", "online", "unhealthy", "restarting", "draining", "stopped")
    pods = await ops_db.list_pods(service=service, server_id=server_id, statuses=statuses)
    # Stitch on live dispatcher in_flight from the in-memory pool.
    out: list[dict] = []
    for p in pods:
        pd = dict(p)
        pd.pop("api_key_enc", None)
        pd.pop("extra_env_enc", None)
        pd["dispatcher_in_flight"] = ops_pool.in_flight(int(p["id"]))
        out.append(pd)
    return {"pods": out}


@router.post("/pods")
async def deploy_pod(body: PodDeployIn, _: str = Depends(require_admin_session)) -> dict:
    if not ops_crypto.is_configured():
        raise HTTPException(status_code=503, detail="OPS_FERNET_KEY not set on backend")
    if body.service not in ops_db.SERVICE_NAMES:
        raise HTTPException(status_code=400, detail=f"unknown service {body.service!r}; valid: {ops_db.SERVICE_NAMES}")
    _validate_name(body.name)
    _validate_env(body.extra_env)
    if body.port < 1024 or body.port > 65535:
        raise HTTPException(status_code=400, detail="port must be 1024-65535")

    server = await ops_db.get_server(body.server_id)
    if server is None or server.get("status") == "removed":
        raise HTTPException(status_code=404, detail="server not found")

    api_key = (body.api_key or "").strip() or secrets.token_urlsafe(32)

    # Insert the pod row up-front so the admin sees it as 'deploying'
    # while docker pull/run is running.
    pod_id = await ops_db.insert_pod(
        server_id=body.server_id,
        name=body.name,
        service=body.service,
        image=body.image,
        port=body.port,
        api_key_enc=ops_crypto.encrypt(api_key),
        extra_env_enc=ops_crypto.encrypt(json.dumps(body.extra_env)),
    )
    await ops_db.log_pod_event(pod_id, "deploy_started", f"{body.image} on {server['name']}")

    try:
        # 1. Pull
        digest = await ops_ssh.docker_pull(server, body.image)

        # 2. Build env: per-service known key + any extras the admin supplied.
        env = dict(body.extra_env)
        # Each Vocence service has its own env-var name for the bearer token.
        # Map the friendly api_key field to the right var name here so the
        # admin UI doesn't need to know.
        env_key_for_service = {
            "tts_streaming": "QWEN3_TTS_API_KEY",
            "voice_design": "QWEN3_VD_API_KEY",
            "voice_clone": "QWEN3_CLONE_API_KEY",
            "stt": "STT_API_KEY",
            "music": "MUSIC_API_KEY",
        }.get(body.service)
        if env_key_for_service:
            env.setdefault(env_key_for_service, api_key)

        # 3. Run — port mapping: host port (chosen by admin) -> container's
        # default. We pick the container port based on service convention so
        # the admin doesn't have to know the internal port number.
        container_port = {
            "tts_streaming": 8111,
            "voice_design": 8112,
            "voice_clone": 8113,
            "stt": 8114,
            "music": 8115,
        }.get(body.service, body.port)

        container_name = f"vocence-{body.service}-{pod_id}"
        container_id = await ops_ssh.docker_run(
            server,
            container_name=container_name,
            image=body.image,
            host_port=body.port,
            container_port=container_port,
            env=env,
        )

        await ops_db.update_pod(
            pod_id,
            container_id=container_id,
            image_digest=digest,
            status="deploying",  # health poller flips to 'online' once /healthz responds
        )
        await ops_db.log_pod_event(pod_id, "deploy_succeeded", f"container {container_id[:12]} started")

        # Kick the pool so the new pod is visible immediately (though its
        # status='deploying' means it won't get traffic until first healthz).
        await ops_pool.reload_pool()
    except ops_ssh.SshError as e:
        await ops_db.update_pod(pod_id, status="stopped")
        await ops_db.log_pod_event(pod_id, "deploy_failed", str(e))
        raise HTTPException(status_code=502, detail=f"deploy failed: {e}")

    return {"pod": await ops_db.get_pod(pod_id)}


@router.post("/pods/{pod_id}/stop")
async def stop_pod(pod_id: int, _: str = Depends(require_admin_session)) -> dict:
    pod, server = await _pod_and_server(pod_id)
    cid = pod.get("container_id")
    if cid:
        try:
            await ops_ssh.docker_stop(server, cid)
        except ops_ssh.SshError as e:
            _log.warning("pod %s stop failed: %s", pod_id, e)
    await ops_db.update_pod(pod_id, status="stopped")
    await ops_db.log_pod_event(pod_id, "stopped_manual")
    await ops_pool.reload_pool()
    return {"ok": True}


@router.post("/pods/{pod_id}/restart")
async def restart_pod(pod_id: int, _: str = Depends(require_admin_session)) -> dict:
    pod, server = await _pod_and_server(pod_id)
    cid = pod.get("container_id")
    if not cid:
        raise HTTPException(status_code=400, detail="pod has no container_id")
    try:
        await ops_ssh.docker_restart(server, cid)
    except ops_ssh.SshError as e:
        raise HTTPException(status_code=502, detail=str(e))
    await ops_db.update_pod(pod_id, status="restarting", consecutive_failures=0)
    await ops_db.log_pod_event(pod_id, "restarted_manual")
    return {"ok": True}


@router.post("/pods/{pod_id}/update")
async def update_pod_endpoint(pod_id: int, _: str = Depends(require_admin_session)) -> dict:
    """Rolling update: pull latest image, restart container. Container
    keeps its name + env so the run command is `docker stop + docker rm
    + docker run` under the hood."""
    pod, server = await _pod_and_server(pod_id)
    image = pod["image"]
    container_id = pod.get("container_id")

    try:
        new_digest = await ops_ssh.docker_pull(server, image)
        if container_id:
            await ops_ssh.docker_stop(server, container_id)
            await ops_ssh.docker_remove(server, container_id, force=True)

        # Reconstruct env: decrypt the per-pod api_key + extras and re-emit.
        api_key = ops_crypto.decrypt(pod.get("api_key_enc") or "")
        extra_env = json.loads(ops_crypto.decrypt(pod.get("extra_env_enc") or "") or "{}")

        env = dict(extra_env)
        env_key_for_service = {
            "tts_streaming": "QWEN3_TTS_API_KEY",
            "voice_design": "QWEN3_VD_API_KEY",
            "voice_clone": "QWEN3_CLONE_API_KEY",
            "stt": "STT_API_KEY",
            "music": "MUSIC_API_KEY",
        }.get(pod["service"])
        if env_key_for_service and api_key:
            env.setdefault(env_key_for_service, api_key)

        container_port = {
            "tts_streaming": 8111,
            "voice_design": 8112,
            "voice_clone": 8113,
            "stt": 8114,
            "music": 8115,
        }.get(pod["service"], int(pod["port"]))

        container_name = f"vocence-{pod['service']}-{pod_id}"
        new_cid = await ops_ssh.docker_run(
            server,
            container_name=container_name,
            image=image,
            host_port=int(pod["port"]),
            container_port=container_port,
            env=env,
        )
        await ops_db.update_pod(pod_id, container_id=new_cid, image_digest=new_digest, status="deploying")
        await ops_db.log_pod_event(pod_id, "update_applied", f"pulled digest {new_digest}")
        # Invalidate the Docker Hub cache so the update-detector sees the
        # new state on the next pass.
        ops_docker_hub.invalidate_cache(image)
    except ops_ssh.SshError as e:
        await ops_db.log_pod_event(pod_id, "update_failed", str(e))
        raise HTTPException(status_code=502, detail=str(e))

    return {"pod": await ops_db.get_pod(pod_id)}


@router.post("/pods/{pod_id}/drain")
async def drain_pod(pod_id: int, _: str = Depends(require_admin_session)) -> dict:
    pod = await ops_db.get_pod(pod_id)
    if pod is None:
        raise HTTPException(status_code=404, detail="pod not found")
    await ops_db.update_pod(pod_id, drain_requested=1, status="draining")
    await ops_db.log_pod_event(pod_id, "drain_requested")
    await ops_pool.reload_pool()
    return {"ok": True}


@router.delete("/pods/{pod_id}")
async def remove_pod(pod_id: int, _: str = Depends(require_admin_session)) -> dict:
    pod, server = await _pod_and_server(pod_id)
    cid = pod.get("container_id")
    if cid:
        try:
            await ops_ssh.docker_stop(server, cid)
            await ops_ssh.docker_remove(server, cid, force=True)
        except ops_ssh.SshError as e:
            _log.warning("pod %s remove: docker stop/rm failed: %s", pod_id, e)
    await ops_db.update_pod(pod_id, status="removed")
    await ops_db.log_pod_event(pod_id, "removed_manual")
    await ops_pool.reload_pool()
    return {"ok": True}


@router.get("/pods/{pod_id}/logs")
async def pod_logs(pod_id: int, tail: int = 200, _: str = Depends(require_admin_session)) -> dict:
    pod, server = await _pod_and_server(pod_id)
    cid = pod.get("container_id")
    if not cid:
        raise HTTPException(status_code=400, detail="pod has no container_id")
    try:
        logs = await ops_ssh.docker_logs(server, cid, tail=min(2000, max(1, int(tail))))
    except ops_ssh.SshError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"logs": logs}


# ---------------------------------------------------------------------------
# Dashboard / analytics
# ---------------------------------------------------------------------------

@router.get("/overview")
async def overview(_: str = Depends(require_admin_session)) -> dict:
    """Fleet summary tiles for the Studio dashboard."""
    servers = await ops_db.list_servers()
    pods_all = await ops_db.list_pods(statuses=(
        "deploying", "online", "unhealthy", "restarting", "draining",
    ))
    by_status: dict[str, int] = {}
    by_service: dict[str, int] = {}
    for p in pods_all:
        by_status[p["status"]] = by_status.get(p["status"], 0) + 1
        by_service[p["service"]] = by_service.get(p["service"], 0) + 1

    # Live inflight from the dispatcher (more accurate than DB cursor).
    snap = ops_pool.snapshot()
    total_inflight = sum(s["total_in_flight"] for s in snap.values())
    total_capacity = sum(s["global_cap"] for s in snap.values())

    return {
        "servers_total": len(servers),
        "servers_ready": sum(1 for s in servers if s["status"] == "ready"),
        "pods_total": len(pods_all),
        "pods_by_status": by_status,
        "pods_by_service": by_service,
        "dispatcher_inflight": total_inflight,
        "dispatcher_capacity_2N": total_capacity,
    }


@router.get("/dispatcher")
async def dispatcher_snapshot(_: str = Depends(require_admin_session)) -> dict:
    return {"services": ops_pool.snapshot()}


@router.get("/pods/{pod_id}/timeseries")
async def pod_timeseries(
    pod_id: int,
    range_hours: int = 24,
    _: str = Depends(require_admin_session),
) -> dict:
    """Per-minute requests/errors/latency for a single pod, last N hours."""
    pod = await ops_db.get_pod(pod_id)
    if pod is None:
        raise HTTPException(status_code=404, detail="pod not found")
    range_hours = min(720, max(1, range_hours))  # cap at 30d
    cutoff = int(time.time()) - range_hours * 3600
    from local_db import get_connection
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT minute_ts, requests_ok, requests_err_json, duration_ms_sum, duration_ms_count,
                   duration_ms_p95, max_inflight, bytes_sent, audio_ms
            FROM ops_pod_metrics_minute
            WHERE pod_id = ? AND minute_ts >= ?
            ORDER BY minute_ts ASC
            """,
            (pod_id, cutoff // 60),
        )).fetchall()
        return {
            "points": [
                {
                    "minute_ts": int(r["minute_ts"]),
                    "requests_ok": int(r["requests_ok"]),
                    "requests_err": json.loads(r["requests_err_json"] or "{}"),
                    "duration_ms_sum": float(r["duration_ms_sum"]),
                    "duration_ms_count": int(r["duration_ms_count"]),
                    "duration_ms_p95": float(r["duration_ms_p95"]),
                    "max_inflight": int(r["max_inflight"]),
                    "bytes_sent": int(r["bytes_sent"]),
                    "audio_ms": int(r["audio_ms"]),
                }
                for r in rows
            ],
        }
    finally:
        await conn.close()


@router.get("/events")
async def list_events(
    pod_id: int | None = None,
    kind: str | None = None,
    limit: int = 100,
    _: str = Depends(require_admin_session),
) -> dict:
    limit = min(500, max(1, limit))
    sql = "SELECT id, pod_id, kind, message, details_json, created_at FROM ops_pod_events WHERE 1=1"
    args: list[Any] = []
    if pod_id is not None:
        sql += " AND pod_id = ?"
        args.append(pod_id)
    if kind is not None:
        sql += " AND kind = ?"
        args.append(kind)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    from local_db import get_connection
    conn = await get_connection()
    try:
        rows = await (await conn.execute(sql, args)).fetchall()
        return {
            "events": [
                {
                    "id": int(r["id"]),
                    "pod_id": int(r["pod_id"]) if r["pod_id"] is not None else None,
                    "kind": r["kind"],
                    "message": r["message"],
                    "details": json.loads(r["details_json"]) if r["details_json"] else None,
                    "created_at": r["created_at"],
                }
                for r in rows
            ]
        }
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

async def _pod_and_server(pod_id: int) -> tuple[dict, dict]:
    pod = await ops_db.get_pod(pod_id)
    if pod is None:
        raise HTTPException(status_code=404, detail="pod not found")
    server = await ops_db.get_server(int(pod["server_id"]))
    if server is None:
        raise HTTPException(status_code=410, detail="parent server is gone")
    return pod, server
