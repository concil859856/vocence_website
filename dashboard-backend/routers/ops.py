"""Vocence Studio /ops admin endpoints.

All routes here gate on ``require_admin_unlocked`` — two layers:
  1. ``require_admin_session`` (transitively): JWT email == ADMIN_EMAIL
  2. Valid ``X-Admin-Token`` from POST /auth/admin/unlock (separate password
     enforced by routers/admin_auth.py — see that module for details).

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
from routers.admin_auth import require_admin_unlocked

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
    gpu_index: int | None = Field(
        None,
        description="Physical GPU index to pin this pod to (0..N-1 where N "
                    "is the count from the server's nvidia-smi probe). NULL "
                    "= --gpus all (legacy / single-GPU hosts). Required when "
                    "co-locating multiple pods on the same multi-GPU server "
                    "so each one gets its own device.",
        ge=0,
        le=15,
    )


# ---------------------------------------------------------------------------
# /servers
# ---------------------------------------------------------------------------

@router.get("/servers")
async def list_servers_endpoint(_: str = Depends(require_admin_unlocked)) -> dict:
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
        # Parse the nvidia-smi probe blob into structured GPU rows so the
        # admin UI can render a "pick a GPU" picker without re-parsing
        # the JSON string client-side. Keep gpu_info_json for back-compat
        # with anything else reading the raw field.
        try:
            sd["gpus"] = json.loads(s.get("gpu_info_json") or "[]") or []
        except (ValueError, TypeError):
            sd["gpus"] = []
        sd["pods_summary"] = [
            {
                "id": p["id"],
                "name": p["name"],
                "service": p["service"],
                "port": p["port"],
                "status": p["status"],
                # gpu_index lets the UI show "GPU N — used by pod X"
                # in the deploy modal so admins can avoid collisions.
                "gpu_index": p.get("gpu_index"),
            }
            for p in pods
        ]
        out.append(sd)
    return {"servers": out}


async def _probe_server_background(server_id: int, name: str) -> None:
    """Background task: run probe_server, update status to ready/unreachable.
    Wrapped in catch-all so the task never silently dies — anything goes
    wrong, status becomes 'unreachable' with the error in ops_pod_events."""
    server = await ops_db.get_server(server_id)
    if server is None:
        return
    try:
        probe = await ops_ssh.probe_server(server)
        await ops_db.update_server_status(
            server_id,
            status="ready",
            last_seen_at=__import__("datetime").datetime.utcnow().isoformat() + "Z",
            docker_version=probe.get("docker_version"),
            gpu_info_json=json.dumps(probe.get("gpu_info", [])),
        )
        await ops_db.log_pod_event(None, "server_added", f"server {name} probed ok", probe)
    except ops_ssh.SshError as e:
        await ops_db.update_server_status(server_id, status="unreachable")
        await ops_db.log_pod_event(None, "server_probe_failed", f"server {name}: {e}")
    except Exception as e:  # noqa: BLE001 — last-resort guard so the row never sticks at 'pending'
        _log.exception("probe_server background task crashed for server %s", server_id)
        await ops_db.update_server_status(server_id, status="unreachable")
        await ops_db.log_pod_event(
            None,
            "server_probe_failed",
            f"server {name}: unexpected {type(e).__name__}: {e}",
        )


@router.post("/servers")
async def add_server(body: ServerIn, _: str = Depends(require_admin_unlocked)) -> dict:
    """Insert the server row + kick off the SSH probe in the background.

    Returns immediately (status='pending') so the browser doesn't wait
    20-30s for the SSH connect + nvidia-smi round trip — under SSH-tunnel
    or flaky-proxy conditions that wait often gets cut off, leaving the
    UI thinking the request failed even though the backend processed it.

    The frontend's 15s server-list refresh picks up the status flip to
    'ready' / 'unreachable' once the probe completes."""
    _validate_name(body.name)
    if not ops_crypto.is_configured() and body.ssh_private_key:
        raise HTTPException(status_code=503, detail="OPS_FERNET_KEY not set on backend — cannot store per-server SSH key")

    # Validate + normalize the SSH key BEFORE inserting the server row.
    # Saves the user from registering a server whose key is unusable —
    # they get a clean 400 with a fix-up hint instead of seeing the row
    # bounce to 'unreachable' minutes later.
    normalized_key: str | None = None
    if body.ssh_private_key:
        try:
            ops_ssh.validate_private_key(body.ssh_private_key)
            normalized_key = ops_ssh.normalize_private_key(body.ssh_private_key)
        except ops_ssh.SshError as e:
            raise HTTPException(status_code=400, detail=str(e))

    enc_key = ops_crypto.encrypt(normalized_key) if normalized_key else None

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

    # Fire the probe in the background. Don't await — the response can ship now.
    asyncio.create_task(_probe_server_background(server_id, body.name))

    server = await ops_db.get_server(server_id)
    srv = dict(server or {})
    srv.pop("ssh_private_key_enc", None)
    return {"server": srv, "probe": "scheduled"}


@router.delete("/servers/{server_id}")
async def remove_server(server_id: int, _: str = Depends(require_admin_unlocked)) -> dict:
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
async def reprobe_server(server_id: int, _: str = Depends(require_admin_unlocked)) -> dict:
    """Re-probe in the background (same shape as POST /servers — never blocks
    the response on the SSH round trip)."""
    server = await ops_db.get_server(server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="server not found")
    # Reset status so the UI shows it's in-flight; background task updates it.
    await ops_db.update_server_status(server_id, status="pending")
    asyncio.create_task(_probe_server_background(server_id, server.get("name") or str(server_id)))
    return {"server": await ops_db.get_server(server_id), "probe": "scheduled"}


# ---------------------------------------------------------------------------
# /pods
# ---------------------------------------------------------------------------

@router.get("/pods")
async def list_pods_endpoint(
    service: str | None = None,
    server_id: int | None = None,
    _: str = Depends(require_admin_unlocked),
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
async def deploy_pod(body: PodDeployIn, _: str = Depends(require_admin_unlocked)) -> dict:
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

    # Validate the GPU pin against the server's probed gpu_info, if any.
    # If the server has been probed we know how many GPUs it has and
    # whether the requested index exists. We do NOT block a deploy when
    # gpu_info_json is missing — the admin may have just added the
    # server and the probe is still running. The docker_run call will
    # surface "gpu device not found" at deploy time in that case.
    if body.gpu_index is not None and server.get("gpu_info_json"):
        try:
            available = json.loads(server["gpu_info_json"]) or []
            valid_indexes = {int(g.get("index")) for g in available if g.get("index") is not None}
            if body.gpu_index not in valid_indexes:
                raise HTTPException(
                    status_code=400,
                    detail=f"GPU {body.gpu_index} not found on server (available: {sorted(valid_indexes)})",
                )
        except (ValueError, TypeError, KeyError):
            # Malformed gpu_info_json — fall through. docker_run will
            # surface the error at deploy time.
            pass

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
        gpu_index=body.gpu_index,
    )
    await ops_db.log_pod_event(pod_id, "deploy_started", f"{body.image} on {server['name']}")

    try:
        # 1. Pull — skip if the image is already present locally (saves
        #    disk space on tight servers where the pull's temp snapshots
        #    would exhaust free space even when the image hasn't changed).
        if await ops_ssh.docker_image_exists(server, body.image):
            _log.info("image %s already present on %s; skipping pull", body.image, server["name"])
            digest = await ops_ssh.docker_image_digest(server, body.image)
            await ops_db.log_pod_event(pod_id, "pull_skipped", f"{body.image} already cached")
        else:
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
            "noise_remover": "NOISE_REMOVER_API_KEY",
            "dubbing": "NOISE_REMOVER_API_KEY",
            # Voice-agent-pipeline pods — each defines its own X-API-Key
            # env var name; the dispatcher proxies traffic to them with
            # the matching value as the header.
            "asr_streaming_rt": "ASR_API_KEY",
            "turn_detection": "TD_API_KEY",
            "knowledge_ingestion": "KN_API_KEY",
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
            "noise_remover": 8116,
            "dubbing": 8116,
            # The new asr-streaming-rt pod hosts BOTH /v1/transcribe (batch)
            # and /v1/stream (streaming WS) — see streaming_stt_spec.md. It
            # uses port 8117 to keep ``stt`` (8114) free as a fallback while
            # we migrate Studio + voicechat to the new pod.
            "asr_streaming_rt": 8117,
            "turn_detection": 8119,
            "knowledge_ingestion": 8118,
        }.get(body.service, body.port)

        container_name = f"vocence-{body.service}-{pod_id}"
        container_id = await ops_ssh.docker_run(
            server,
            container_name=container_name,
            image=body.image,
            host_port=body.port,
            container_port=container_port,
            env=env,
            gpu_index=body.gpu_index,
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
async def stop_pod(pod_id: int, _: str = Depends(require_admin_unlocked)) -> dict:
    pod, server = await _pod_and_server(pod_id)
    cid = pod.get("container_id")
    if cid:
        try:
            await ops_ssh.docker_stop(server, cid)
        except ops_ssh.SshError as e:
            _log.warning("pod %s stop failed: %s", pod_id, e)
        try:
            await ops_ssh.run_command(
                server,
                "for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do "
                "  cid=$(cat /proc/$pid/cgroup 2>/dev/null | grep -oP 'docker/\\K[a-f0-9]+' | head -1); "
                "  if [ -z \"$cid\" ] || ! docker inspect \"$cid\" >/dev/null 2>&1; then "
                "    kill -9 $pid 2>/dev/null && echo \"killed orphan GPU pid $pid\"; "
                "  fi; "
                "done",
                timeout=15, check=False,
            )
        except Exception:
            pass
    await ops_db.update_pod(pod_id, status="stopped")
    await ops_db.log_pod_event(pod_id, "stopped_manual")
    await ops_pool.reload_pool()
    return {"ok": True}


@router.post("/pods/{pod_id}/restart")
async def restart_pod(pod_id: int, _: str = Depends(require_admin_unlocked)) -> dict:
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
async def update_pod_endpoint(pod_id: int, _: str = Depends(require_admin_unlocked)) -> dict:
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
        # KEEP IN SYNC with the deploy-pod handler ~140 lines up. The two
        # tables diverged once (newer services were added to deploy but
        # not update), which meant clicking "Update" on a knowledge /
        # turn-detection / asr_streaming_rt pod silently re-launched it
        # WITHOUT the X-API-Key env var — the container's config loader
        # then exits with ``env var KN_API_KEY is required`` and the
        # pod restart-loops forever. Treat both tables as one source of
        # truth and add new services to BOTH at the same time.
        env_key_for_service = {
            "tts_streaming": "QWEN3_TTS_API_KEY",
            "voice_design": "QWEN3_VD_API_KEY",
            "voice_clone": "QWEN3_CLONE_API_KEY",
            "stt": "STT_API_KEY",
            "music": "MUSIC_API_KEY",
            "noise_remover": "NOISE_REMOVER_API_KEY",
            "dubbing": "NOISE_REMOVER_API_KEY",
            "asr_streaming_rt": "ASR_API_KEY",
            "turn_detection": "TD_API_KEY",
            "knowledge_ingestion": "KN_API_KEY",
        }.get(pod["service"])
        if env_key_for_service and api_key:
            env.setdefault(env_key_for_service, api_key)

        container_port = {
            "tts_streaming": 8111,
            "voice_design": 8112,
            "voice_clone": 8113,
            "stt": 8114,
            "music": 8115,
            "noise_remover": 8116,
            "dubbing": 8116,
            "asr_streaming_rt": 8117,
            "turn_detection": 8119,
            "knowledge_ingestion": 8118,
        }.get(pod["service"], int(pod["port"]))

        container_name = f"vocence-{pod['service']}-{pod_id}"
        # Preserve the pod's original GPU pin when redeploying — without
        # this an update would silently re-fall-back to --gpus all and
        # collide with other pods on the same multi-GPU host.
        existing_gpu_index = pod.get("gpu_index")
        new_cid = await ops_ssh.docker_run(
            server,
            container_name=container_name,
            image=image,
            host_port=int(pod["port"]),
            container_port=container_port,
            env=env,
            gpu_index=int(existing_gpu_index) if existing_gpu_index is not None else None,
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
async def drain_pod(pod_id: int, _: str = Depends(require_admin_unlocked)) -> dict:
    pod = await ops_db.get_pod(pod_id)
    if pod is None:
        raise HTTPException(status_code=404, detail="pod not found")
    await ops_db.update_pod(pod_id, drain_requested=1, status="draining")
    await ops_db.log_pod_event(pod_id, "drain_requested")
    await ops_pool.reload_pool()
    return {"ok": True}


@router.delete("/pods/{pod_id}")
async def remove_pod(pod_id: int, _: str = Depends(require_admin_unlocked)) -> dict:
    pod, server = await _pod_and_server(pod_id)
    cid = pod.get("container_id")
    if cid:
        try:
            await ops_ssh.docker_stop(server, cid)
            await ops_ssh.docker_remove(server, cid, force=True)
        except ops_ssh.SshError as e:
            _log.warning("pod %s remove: docker stop/rm failed: %s", pod_id, e)
        # Kill any orphaned GPU processes left by the container (vLLM's
        # multiprocessing spawn can leave CUDA processes that survive
        # docker stop, holding GPU memory hostage). Only kills processes
        # that no longer belong to a running container.
        try:
            await ops_ssh.run_command(
                server,
                "for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do "
                "  cid=$(cat /proc/$pid/cgroup 2>/dev/null | grep -oP 'docker/\\K[a-f0-9]+' | head -1); "
                "  if [ -z \"$cid\" ] || ! docker inspect \"$cid\" >/dev/null 2>&1; then "
                "    kill -9 $pid 2>/dev/null && echo \"killed orphan GPU pid $pid\"; "
                "  fi; "
                "done",
                timeout=15, check=False,
            )
        except Exception:
            pass
    await ops_db.update_pod(pod_id, status="removed")
    await ops_db.log_pod_event(pod_id, "removed_manual")
    await ops_pool.reload_pool()
    return {"ok": True}


@router.get("/pods/{pod_id}/logs")
async def pod_logs(pod_id: int, tail: int = 200, _: str = Depends(require_admin_unlocked)) -> dict:
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
async def overview(_: str = Depends(require_admin_unlocked)) -> dict:
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
async def dispatcher_snapshot(_: str = Depends(require_admin_unlocked)) -> dict:
    return {"services": ops_pool.snapshot()}


@router.get("/pods/{pod_id}/timeseries")
async def pod_timeseries(
    pod_id: int,
    range_hours: int = 24,
    _: str = Depends(require_admin_unlocked),
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
    _: str = Depends(require_admin_unlocked),
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
# Runtime % + fleet health score
# ---------------------------------------------------------------------------
#
# These endpoints answer the operator's "is the fleet healthy?" questions
# using existing telemetry — no new instrumentation needed:
#
#   • ``ops_pod_uptime_daily.online_seconds`` (already populated by the
#     metrics poller) gives per-pod online time per UTC day.
#   • Same table's ``requests_total`` / ``errors_total`` give per-day
#     success rate.
#   • ``ops_pod_metrics_minute.duration_ms_p95`` gives latency efficiency
#     over a short tail.
#
# Windows are 'day' (today so far), 'week' (last 7d), 'month' (last 30d).
# The denominator is clamped to ``min(window_seconds, age_of_pod)`` so a
# pod added yesterday doesn't report 14% week-uptime.

_WINDOW_DAYS = {"day": 1, "week": 7, "month": 30}
# Per-service p95 latency targets (ms). p95 at or below the target scores
# 100% on the latency component; linearly degrades to 0 at 4× target.
#
# These are NOT picked uniformly — they reflect what each service is
# actually expected to do:
#   • tts_streaming: TTFT-style streaming — sub-second is the whole point.
#   • stt: short audio (<60s) typical, batch model.
#   • voice_clone / voice_design: 5–30s per run is normal.
#   • dubbing / noise_remover: depends on input audio length.
#   • music: long-form generation, minutes per track.
#
# Unknown service names fall through to a 5 s default — generous enough
# that an un-tuned service isn't auto-flagged red, but tight enough that
# truly broken pods still score poorly.
_P95_TARGET_MS_DEFAULT = 5000
_P95_TARGET_MS_BY_SERVICE = {
    "tts_streaming": 1000,    # streaming TTS: sub-second TTFA is the point
    "stt":           5000,    # batch STT on short audio
    "voice_clone":  30000,    # ~10–30s per clone is normal
    "voice_design": 30000,    # similar
    "noise_remover": 60000,   # scales with input audio length
    "dubbing":      60000,    # historical name for noise_remover
    "music":       180000,    # music is minutes per track; this is generous
    # New voice-agent-pipeline pods:
    "asr_streaming_rt": 1500, # streaming STT: per-session, includes full-utterance commit time
    "turn_detection":    300, # CPU model inference per call; ~100ms typical
    "knowledge_ingestion": 150,  # per-turn /v1/query: embedding + LanceDB search
}


def _p95_target_ms_for(service: str | None) -> int:
    """Pick the right p95 target for a pod's service. Falls back to
    ``_P95_TARGET_MS_DEFAULT`` for unknown service names so adding a
    new service doesn't immediately mis-score it as critical."""
    if not service:
        return _P95_TARGET_MS_DEFAULT
    return _P95_TARGET_MS_BY_SERVICE.get(service, _P95_TARGET_MS_DEFAULT)


def _window_seconds(window: str) -> int:
    days = _WINDOW_DAYS.get(window, 7)
    return days * 86400


async def _pod_uptime_seconds(conn, pod_id: int, days: int) -> int:
    """Sum of online_seconds for a pod across the last N UTC days
    (today + previous days-1). Returns 0 for a pod with no rows."""
    cur = await conn.execute(
        f"""
        SELECT COALESCE(SUM(online_seconds), 0) AS s
        FROM ops_pod_uptime_daily
        WHERE pod_id = ?
          AND day >= date('now', '-{days - 1} days')
        """,
        (pod_id,),
    )
    row = await cur.fetchone()
    return int(row["s"] or 0)


async def _pod_requests_in_window(conn, pod_id: int, days: int) -> tuple[int, int]:
    """(requests_total, errors_total) summed across the window."""
    cur = await conn.execute(
        f"""
        SELECT COALESCE(SUM(requests_total), 0) AS req,
               COALESCE(SUM(errors_total), 0)   AS err
        FROM ops_pod_uptime_daily
        WHERE pod_id = ?
          AND day >= date('now', '-{days - 1} days')
        """,
        (pod_id,),
    )
    row = await cur.fetchone()
    return int(row["req"] or 0), int(row["err"] or 0)


async def _pod_recent_p95_ms(conn, pod_id: int, days: int) -> float | None:
    """Average of per-minute p95 over the window — a cheap stand-in for
    a true windowed p95 without a percentile op in SQLite. Better than
    p95-of-p95 because it doesn't double-tail."""
    cutoff = int(time.time()) - days * 86400
    cur = await conn.execute(
        """
        SELECT AVG(duration_ms_p95) AS p95
        FROM ops_pod_metrics_minute
        WHERE pod_id = ? AND minute_ts >= ?
          AND duration_ms_count > 0
        """,
        (pod_id, cutoff // 60),
    )
    row = await cur.fetchone()
    p = row["p95"]
    return float(p) if p is not None else None


def _age_seconds(deployed_at: str | None) -> int:
    """Seconds since the pod was deployed (or server created). Falls
    back to the full window if the timestamp can't be parsed — we'd
    rather slightly under-credit a borked row than divide by zero."""
    if not deployed_at:
        return _window_seconds("month")
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(deployed_at.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(1, int((datetime.now(tz=timezone.utc) - dt).total_seconds()))
    except Exception:  # noqa: BLE001
        return _window_seconds("month")


@router.get("/pods/runtime")
async def pods_runtime(
    window: str = "week",
    _: str = Depends(require_admin_unlocked),
) -> dict:
    """Per-pod runtime % over ``window`` (day | week | month).

    Denominator is clamped to ``min(window_seconds, pod_age_seconds)``
    so a freshly-added pod doesn't show 14% on the week chart. Excludes
    pods with status 'removed'."""
    if window not in _WINDOW_DAYS:
        raise HTTPException(status_code=400, detail="window must be day|week|month")
    days = _WINDOW_DAYS[window]
    window_sec = _window_seconds(window)
    from local_db import get_connection
    conn = await get_connection()
    try:
        cur = await conn.execute(
            """
            SELECT id, name, service, server_id, status, deployed_at
            FROM ops_pods
            WHERE status != 'removed'
            ORDER BY id ASC
            """
        )
        pods = await cur.fetchall()
        out = []
        for p in pods:
            online = await _pod_uptime_seconds(conn, int(p["id"]), days)
            denom = min(window_sec, _age_seconds(p["deployed_at"]))
            pct = round(100.0 * online / denom, 2) if denom > 0 else 0.0
            out.append({
                "pod_id": int(p["id"]),
                "name": p["name"],
                "service": p["service"],
                "server_id": int(p["server_id"]),
                "status": p["status"],
                "online_seconds": online,
                "window_seconds": denom,
                "uptime_pct": min(100.0, pct),
            })
        return {"window": window, "pods": out}
    finally:
        await conn.close()


@router.get("/servers/runtime")
async def servers_runtime(
    window: str = "week",
    _: str = Depends(require_admin_unlocked),
) -> dict:
    """Per-server runtime % over ``window``. Computed as the
    high-water-mark of any of the server's pods being online — if at
    least one pod was responding to healthz at a given minute, the
    server was reachable. This over-counts vs strict OR-of-pods (an
    exact join would need per-minute timeline reconstruction) but is
    accurate enough for the daily/weekly/monthly summary view.

    Servers with no pods report online_seconds=0. The denominator is
    clamped to server age, same as pods."""
    if window not in _WINDOW_DAYS:
        raise HTTPException(status_code=400, detail="window must be day|week|month")
    days = _WINDOW_DAYS[window]
    window_sec = _window_seconds(window)
    from local_db import get_connection
    conn = await get_connection()
    try:
        # Approximation: for each (server, day) take MAX(online_seconds)
        # across that server's pods. Sum across days for the window.
        cur = await conn.execute(
            f"""
            WITH per_server_day AS (
                SELECT p.server_id, u.day, MAX(u.online_seconds) AS max_seconds
                FROM ops_pod_uptime_daily u
                JOIN ops_pods p ON p.id = u.pod_id
                WHERE u.day >= date('now', '-{days - 1} days')
                GROUP BY p.server_id, u.day
            )
            SELECT s.id, s.name, s.host, s.status, s.created_at,
                   COALESCE(SUM(d.max_seconds), 0) AS online_seconds
            FROM ops_servers s
            LEFT JOIN per_server_day d ON d.server_id = s.id
            GROUP BY s.id
            ORDER BY s.name ASC
            """
        )
        rows = await cur.fetchall()
        out = []
        for r in rows:
            denom = min(window_sec, _age_seconds(r["created_at"]))
            online = int(r["online_seconds"] or 0)
            pct = round(100.0 * online / denom, 2) if denom > 0 else 0.0
            out.append({
                "server_id": int(r["id"]),
                "name": r["name"],
                "host": r["host"],
                "status": r["status"],
                "online_seconds": online,
                "window_seconds": denom,
                "uptime_pct": min(100.0, pct),
            })
        return {"window": window, "servers": out}
    finally:
        await conn.close()


@router.get("/fleet/health")
async def fleet_health(
    window: str = "week",
    _: str = Depends(require_admin_unlocked),
) -> dict:
    """Composite fleet-health score per pod + network mean over ``window``.

    Per-pod score (0..100):
        0.40 × uptime_pct
        0.40 × success_rate × 100
        0.20 × latency_efficiency × 100

    where:
        success_rate = 1 - (errors / max(requests, 1))
        latency_efficiency = 1 - clamp((p95 - target) / (3 × target), 0..1)

    The p95 target is **per-service** (``_P95_TARGET_MS_BY_SERVICE``) so
    that a music pod's 90-second p95 doesn't get scored on the same
    target as a streaming-TTS pod's 1-second p95. The pod's individual
    target is surfaced in the response so the UI can display it.

    Network mean = unweighted mean across pods with status != 'removed'.
    Pods with no traffic in the window contribute their uptime + a
    neutral 100% success / latency (we don't penalise idle pods)."""
    if window not in _WINDOW_DAYS:
        raise HTTPException(status_code=400, detail="window must be day|week|month")
    days = _WINDOW_DAYS[window]
    window_sec = _window_seconds(window)
    from local_db import get_connection
    conn = await get_connection()
    try:
        cur = await conn.execute(
            """
            SELECT id, name, service, server_id, status, deployed_at
            FROM ops_pods
            WHERE status != 'removed'
            ORDER BY id ASC
            """
        )
        pods = await cur.fetchall()
        scored: list[dict] = []
        for p in pods:
            pid = int(p["id"])
            target_ms = _p95_target_ms_for(p["service"])
            online = await _pod_uptime_seconds(conn, pid, days)
            denom = min(window_sec, _age_seconds(p["deployed_at"]))
            uptime_pct = min(100.0, 100.0 * online / denom) if denom > 0 else 0.0
            req, err = await _pod_requests_in_window(conn, pid, days)
            success_rate = (1.0 - err / req) if req > 0 else 1.0
            p95 = await _pod_recent_p95_ms(conn, pid, days)
            if p95 is None:
                latency_eff = 1.0
            else:
                ratio = max(0.0, (p95 - target_ms) / (3.0 * target_ms))
                latency_eff = max(0.0, 1.0 - min(1.0, ratio))
            score = round(
                0.40 * uptime_pct
                + 0.40 * success_rate * 100.0
                + 0.20 * latency_eff * 100.0,
                2,
            )
            scored.append({
                "pod_id": pid,
                "name": p["name"],
                "service": p["service"],
                "server_id": int(p["server_id"]),
                "status": p["status"],
                "uptime_pct": round(uptime_pct, 2),
                "success_rate": round(success_rate, 4),
                "p95_latency_ms": round(p95, 1) if p95 is not None else None,
                "p95_target_ms": target_ms,
                "latency_efficiency": round(latency_eff, 4),
                "score": score,
            })
        network_mean = (
            round(sum(p["score"] for p in scored) / len(scored), 2)
            if scored else None
        )
        return {
            "window": window,
            # Default target is a single number for compatibility with the
            # existing UI string; the per-pod ``p95_target_ms`` is the
            # accurate value for each row.
            "p95_target_ms": _P95_TARGET_MS_DEFAULT,
            "p95_targets_by_service": _P95_TARGET_MS_BY_SERVICE,
            "network_mean_score": network_mean,
            "active_pod_count": len(scored),
            "pods": scored,
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
