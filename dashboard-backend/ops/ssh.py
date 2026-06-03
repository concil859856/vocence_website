"""Async SSH wrapper for remote Docker control on rented GPU boxes.

The dashboard-backend uses this to actually execute ``docker pull`` /
``docker run`` / ``docker stop`` / ``docker logs`` on the rented machines
the admin has registered. One persistent SSH connection per server is
cached so most commands skip the ~200 ms handshake.

Key resolution:
  1. If the server row has ``ssh_private_key_enc`` set → decrypt + use it.
  2. Otherwise fall back to the platform-wide key at the path in
     ``OPS_SSH_PRIVATE_KEY_PATH`` env var.

``known_hosts`` is disabled — rented GPU boxes have ephemeral host
fingerprints, and the security model assumes the operator is the one who
just rented the box (i.e. they trust the IP they typed in). Don't ship
this to a non-rented-GPU context without revisiting.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import tempfile
from dataclasses import dataclass
from typing import Any

import asyncssh

from . import crypto
from . import db

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class SshError(RuntimeError):
    """Wraps any failure: auth, transport, command exit-code, timeout."""


class CommandFailed(SshError):
    def __init__(self, cmd: str, exit_code: int, stdout: str, stderr: str) -> None:
        msg = f"command failed (exit={exit_code}): {cmd}\nstderr: {stderr.strip()[:500]}"
        super().__init__(msg)
        self.cmd = cmd
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr


@dataclass
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int


# ---------------------------------------------------------------------------
# Connection cache
# ---------------------------------------------------------------------------

_CONN_LOCK = asyncio.Lock()
_CONNECTIONS: dict[int, "asyncssh.SSHClientConnection"] = {}
_LOCKS: dict[int, asyncio.Lock] = {}


def _server_lock(server_id: int) -> asyncio.Lock:
    # Per-server lock so commands to the same box serialize cleanly without
    # cross-server head-of-line blocking.
    lk = _LOCKS.get(server_id)
    if lk is None:
        lk = asyncio.Lock()
        _LOCKS[server_id] = lk
    return lk


def normalize_private_key(raw: str) -> str:
    """Best-effort normalisation of user-pasted SSH private keys.

    The UI textarea sometimes loses the ``-----BEGIN/END...-----`` wrapper
    lines (e.g. user copy-pasted only the base64 body, or the form
    stripped them). asyncssh refuses to load such input with the unhelpful
    'Invalid private key' error. We:
      1. trim whitespace
      2. if it already has BEGIN/END markers, leave it alone
      3. otherwise sniff the body for known magic numbers and wrap it
         with the matching headers
      4. ensure the file ends with a newline (some loaders require it)
    """
    s = (raw or "").strip()
    if not s:
        return s
    if "-----BEGIN" in s and "-----END" in s:
        return s if s.endswith("\n") else s + "\n"

    # Strip any incidental whitespace from the body lines.
    body = "".join(line.strip() for line in s.splitlines())

    # Detect the key type from the base64 payload magic.
    header_footer = None
    try:
        import base64 as _b64
        decoded = _b64.b64decode(body, validate=False)
        if decoded.startswith(b"openssh-key-v1\0"):
            header_footer = ("-----BEGIN OPENSSH PRIVATE KEY-----",
                             "-----END OPENSSH PRIVATE KEY-----")
        # PKCS1 (legacy RSA) and PKCS8 are normally pasted with the
        # wrappers; if someone gives us the body only we don't know which
        # — bail out and let asyncssh's error message surface.
    except Exception:
        pass

    if header_footer is None:
        return s + ("\n" if not s.endswith("\n") else "")

    # Rewrap body in 70-char lines per PEM convention.
    wrapped_body = "\n".join(body[i:i + 70] for i in range(0, len(body), 70))
    return f"{header_footer[0]}\n{wrapped_body}\n{header_footer[1]}\n"


def validate_private_key(raw: str) -> None:
    """Raise SshError with a user-friendly message if ``raw`` (after
    ``normalize_private_key``) is not parseable as a private key. Used at
    +Add Server time so the row is never created with an unusable key."""
    pem = normalize_private_key(raw)
    if not pem:
        raise SshError("SSH private key is empty")
    try:
        # asyncssh's loader is the source of truth.
        asyncssh.import_private_key(pem)
    except asyncssh.KeyImportError as e:
        raise SshError(
            f"SSH private key could not be parsed: {e}. Common cause: "
            f"the '-----BEGIN/END OPENSSH PRIVATE KEY-----' wrapper lines "
            f"are missing from the paste. Copy the FULL contents of the "
            f"file, headers included."
        ) from e
    except Exception as e:  # noqa: BLE001 — any parse failure is a 400
        raise SshError(f"SSH private key could not be parsed: {type(e).__name__}: {e}") from e


def _resolve_client_keys(server: dict) -> list[str] | None:
    """Return a list of asyncssh client_keys (file paths OR raw key strings).
    Per-server key wins; platform key is the fallback."""
    enc = server.get("ssh_private_key_enc")
    if enc:
        try:
            pem = crypto.decrypt(enc)
        except Exception as e:
            raise SshError(f"server {server['id']}: SSH key decrypt failed: {e}") from e
        # Auto-wrap header-less paste before handing to asyncssh.
        pem = normalize_private_key(pem)
        # asyncssh accepts the PEM contents directly as a string in client_keys.
        # Write to a tempfile because asyncssh's loader is more forgiving on
        # files than on strings for some key formats.
        fd, path = tempfile.mkstemp(prefix=f"ops_ssh_{server['id']}_", suffix=".key")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(pem)
            os.chmod(path, 0o600)
        except Exception:
            try:
                os.unlink(path)
            except OSError:
                pass
            raise
        return [path]

    platform_path = (os.environ.get("OPS_SSH_PRIVATE_KEY_PATH") or "").strip()
    if not platform_path:
        raise SshError(
            f"server {server['id']}: no SSH key — set OPS_SSH_PRIVATE_KEY_PATH "
            "or attach a per-server key on the server row."
        )
    if not os.path.exists(platform_path):
        raise SshError(
            f"OPS_SSH_PRIVATE_KEY_PATH points at {platform_path!r} which doesn't exist"
        )
    return [platform_path]


async def _open_connection(server: dict) -> "asyncssh.SSHClientConnection":
    """Open a new SSH connection. Caller already holds the per-server lock."""
    client_keys = _resolve_client_keys(server)
    try:
        return await asyncio.wait_for(
            asyncssh.connect(
                host=server["host"],
                port=int(server.get("ssh_port") or 22),
                username=server.get("ssh_user") or "root",
                client_keys=client_keys,
                # Disabling host-key verification is OK for ephemeral rental
                # boxes; the operator is the one who just rented the IP.
                known_hosts=None,
                connect_timeout=15,
            ),
            timeout=20,
        )
    except asyncio.TimeoutError as e:
        raise SshError(f"server {server['id']}: SSH connect timed out") from e
    except (OSError, asyncssh.Error) as e:
        raise SshError(f"server {server['id']}: SSH connect failed: {e}") from e


async def _get_connection(server: dict) -> "asyncssh.SSHClientConnection":
    """Return a live SSH connection for ``server``, opening one if needed.
    Closed/broken connections are transparently replaced."""
    sid = int(server["id"])
    async with _server_lock(sid):
        conn = _CONNECTIONS.get(sid)
        if conn is not None and not conn.is_closed():
            return conn
        # No cached conn or it died — open a fresh one.
        conn = await _open_connection(server)
        _CONNECTIONS[sid] = conn
        return conn


async def close_connection(server_id: int) -> None:
    """Drop the cached connection for one server (used on server-remove and
    after an SSH error so the next command reconnects clean)."""
    async with _server_lock(server_id):
        conn = _CONNECTIONS.pop(server_id, None)
        if conn is not None and not conn.is_closed():
            try:
                conn.close()
                await asyncio.wait_for(conn.wait_closed(), timeout=2)
            except Exception:
                pass


async def close_all() -> None:
    """Tear down every cached connection. Call from app shutdown."""
    for sid in list(_CONNECTIONS.keys()):
        await close_connection(sid)


# ---------------------------------------------------------------------------
# Command runner
# ---------------------------------------------------------------------------

async def run_command(
    server: dict,
    cmd: str,
    *,
    timeout: float = 60.0,
    check: bool = True,
) -> CommandResult:
    """Execute ``cmd`` on ``server`` over the cached SSH connection.

    Raises ``CommandFailed`` when ``check=True`` (default) and exit code is
    non-zero. Pass ``check=False`` to get the raw CommandResult instead —
    useful for commands like ``docker inspect`` that may legitimately fail
    with exit 1 when a container doesn't exist."""
    conn = await _get_connection(server)
    try:
        proc = await asyncio.wait_for(
            conn.run(cmd, check=False),
            timeout=timeout,
        )
    except asyncio.TimeoutError as e:
        # Drop the connection — it may be wedged.
        await close_connection(int(server["id"]))
        raise SshError(f"command timed out after {timeout}s: {cmd}") from e
    except (OSError, asyncssh.Error) as e:
        await close_connection(int(server["id"]))
        raise SshError(f"SSH command failed transport-layer: {e}") from e

    exit_code = int(proc.exit_status or 0)
    stdout = proc.stdout if isinstance(proc.stdout, str) else (proc.stdout.decode() if proc.stdout else "")
    stderr = proc.stderr if isinstance(proc.stderr, str) else (proc.stderr.decode() if proc.stderr else "")
    if check and exit_code != 0:
        raise CommandFailed(cmd, exit_code, stdout, stderr)
    return CommandResult(stdout=stdout, stderr=stderr, exit_code=exit_code)


# ---------------------------------------------------------------------------
# Server-probe helpers (called at "+ Add Server" time)
# ---------------------------------------------------------------------------

async def probe_server(server: dict) -> dict:
    """SSH in, verify docker is installed + GPU is visible. Returns a dict
    with ``docker_version`` and ``gpu_info`` (nvidia-smi JSON)."""
    # docker --version
    docker_ver_res = await run_command(server, "docker --version", check=False, timeout=15)
    if docker_ver_res.exit_code != 0:
        raise SshError(
            "docker is not installed on this host. SSH in and run "
            "`curl -fsSL https://get.docker.com | sh` first."
        )
    docker_version = docker_ver_res.stdout.strip()

    # nvidia-smi -- get GPU info as JSON (one row per GPU)
    gpu_info: list[dict] = []
    nv = await run_command(
        server,
        "nvidia-smi --query-gpu=index,name,memory.total,memory.used,driver_version "
        "--format=csv,noheader,nounits",
        check=False,
        timeout=15,
    )
    if nv.exit_code == 0:
        for line in nv.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 5:
                gpu_info.append({
                    "index": int(parts[0]),
                    "name": parts[1],
                    "memory_total_mib": int(parts[2]) if parts[2].isdigit() else None,
                    "memory_used_mib": int(parts[3]) if parts[3].isdigit() else None,
                    "driver_version": parts[4],
                })
    else:
        _log.warning("server %s: nvidia-smi failed: %s", server.get("id"), nv.stderr.strip()[:200])

    return {
        "docker_version": docker_version,
        "gpu_info": gpu_info,
    }


# ---------------------------------------------------------------------------
# Docker primitives
# ---------------------------------------------------------------------------

async def docker_image_exists(server: dict, image: str) -> bool:
    """Check if a Docker image is already pulled on the remote server."""
    res = await run_command(
        server,
        f"docker image inspect {shlex.quote(image)}",
        timeout=15,
        check=False,
    )
    return res.exit_code == 0


async def docker_image_digest(server: dict, image: str) -> str:
    """Get the local digest of an already-pulled image (no network pull)."""
    res = await run_command(
        server,
        f"docker inspect --format='{{{{index .RepoDigests 0}}}}' {shlex.quote(image)}",
        timeout=15,
        check=False,
    )
    digest = res.stdout.strip().strip("'\"")
    if "@" in digest:
        digest = digest.split("@", 1)[1]
    if not digest.startswith("sha256:"):
        res2 = await run_command(
            server,
            f"docker inspect --format='{{{{.Id}}}}' {shlex.quote(image)}",
            timeout=15, check=False,
        )
        digest = res2.stdout.strip().strip("'\"")
    return digest


async def docker_pull(server: dict, image: str, *, timeout: float = 600.0) -> str:
    """``docker pull`` then return the local digest (sha256:...) of the
    pulled image. The digest is what we record on the pod row to detect
    'image updated upstream'."""
    await run_command(server, f"docker pull {shlex.quote(image)}", timeout=timeout)
    # `docker inspect` returns a JSON array; grab the first matching image.
    res = await run_command(
        server,
        f"docker inspect --format='{{{{index .RepoDigests 0}}}}' {shlex.quote(image)}",
        timeout=15,
        check=False,
    )
    digest = res.stdout.strip().strip("'\"")
    # RepoDigests format: "namespace/repo@sha256:...". Extract just the hash.
    if "@" in digest:
        digest = digest.split("@", 1)[1]
    if not digest.startswith("sha256:"):
        # Some images don't have a RepoDigests entry (locally built, etc).
        # Fall back to the image ID.
        res2 = await run_command(
            server,
            f"docker inspect --format='{{{{.Id}}}}' {shlex.quote(image)}",
            timeout=15, check=False,
        )
        digest = res2.stdout.strip().strip("'\"")
    return digest


async def docker_run(
    server: dict,
    *,
    container_name: str,
    image: str,
    host_port: int,
    container_port: int,
    env: dict[str, str],
    gpu_index: int | None = None,
    extra_args: list[str] | None = None,
    timeout: float = 60.0,
) -> str:
    """Start a container detached. Returns the container ID (full sha256).

    Always passes ``--restart=unless-stopped`` so a host reboot brings the
    pod back automatically without needing systemd or compose.

    GPU isolation:
      * ``gpu_index=None``  → ``--gpus all`` (legacy / single-GPU hosts).
        Container sees every GPU; framework picks cuda:0 by default.
      * ``gpu_index=N``     → ``--gpus '"device=N"'``. Container sees only
        physical GPU N (which appears as cuda:0 inside the container).
        Use this when co-locating multiple pods on a multi-GPU server —
        otherwise they all pile onto cuda:0 and immediately OOM.

    nvidia-container-toolkit handles the device-handle reference
    counting; multiple containers can pin different GPUs on the same
    host without fighting over /dev/nvidia*.
    """
    # Build env flags. Each value is shell-quoted; keys are restricted to
    # [A-Z_][A-Z0-9_]+ at the caller (validated in routers/ops.py) so we
    # don't need to quote them here.
    env_flags: list[str] = []
    for k, v in env.items():
        env_flags.append(f"-e {k}={shlex.quote(v)}")

    extras = " ".join(extra_args or [])

    if gpu_index is None:
        gpu_flag = "--gpus all"
    else:
        # Outer single-quotes for the shell, inner double-quotes required
        # by Docker's CLI parser for the device= form.
        gpu_flag = f"--gpus '\"device={int(gpu_index)}\"'"

    cmd = (
        "docker run -d "
        f"{gpu_flag} "
        "--restart=unless-stopped "
        f"--name {shlex.quote(container_name)} "
        f"-p {host_port}:{container_port} "
        f"-v ops_hf_cache:/cache/hf "  # shared HF model cache so re-deploys skip the 3.4 GB pull
        + " ".join(env_flags) + " "
        + extras + " "
        + shlex.quote(image)
    )
    res = await run_command(server, cmd, timeout=timeout)
    container_id = res.stdout.strip()
    if not container_id:
        raise SshError(f"docker run returned empty container id (cmd: {cmd})")
    return container_id


async def docker_stop(
    server: dict,
    container_id: str,
    *,
    grace_seconds: int = 30,
    timeout: float = 60.0,
) -> None:
    """Graceful stop: sends SIGTERM, waits up to ``grace_seconds`` for
    clean shutdown, then SIGKILL. Defaults are tuned for streaming TTS
    pods — long enough for in-flight WSes to drain, short enough not to
    block the admin UI."""
    await run_command(
        server,
        f"docker stop -t {int(grace_seconds)} {shlex.quote(container_id)}",
        timeout=timeout,
        check=False,  # already-stopped containers exit 1; we don't care
    )


async def docker_remove(server: dict, container_id: str, *, force: bool = False, timeout: float = 30.0) -> None:
    flag = "-f " if force else ""
    await run_command(
        server,
        f"docker rm {flag}{shlex.quote(container_id)}",
        timeout=timeout,
        check=False,
    )


async def docker_restart(
    server: dict,
    container_id: str,
    *,
    grace_seconds: int = 10,
    timeout: float = 60.0,
) -> None:
    await run_command(
        server,
        f"docker restart -t {int(grace_seconds)} {shlex.quote(container_id)}",
        timeout=timeout,
    )


async def docker_inspect(server: dict, container_id: str) -> dict | None:
    """Returns the docker inspect JSON for the container, or None if it
    doesn't exist anymore (e.g. user removed it out-of-band)."""
    res = await run_command(
        server,
        f"docker inspect {shlex.quote(container_id)}",
        timeout=15,
        check=False,
    )
    if res.exit_code != 0:
        return None
    try:
        arr = json.loads(res.stdout)
        return arr[0] if arr else None
    except (json.JSONDecodeError, IndexError):
        return None


async def docker_logs(
    server: dict,
    container_id: str,
    *,
    tail: int = 200,
    timeout: float = 30.0,
) -> str:
    res = await run_command(
        server,
        f"docker logs --tail {int(tail)} {shlex.quote(container_id)} 2>&1",
        timeout=timeout,
        check=False,
    )
    return res.stdout


async def docker_ps_running(server: dict) -> list[dict]:
    """List the containers currently running on the host. Useful for
    reconciling our pods table against reality (e.g. user killed a pod
    via SSH directly)."""
    res = await run_command(
        server,
        "docker ps --format '{{json .}}'",
        timeout=15,
        check=False,
    )
    out: list[dict] = []
    for line in res.stdout.strip().splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


# ---------------------------------------------------------------------------
# Convenience: invalidate the cached connection if a server row was edited
# (host or SSH creds changed) so the next command reconnects with new info.
# ---------------------------------------------------------------------------

async def reload_server(server_id: int) -> None:
    await close_connection(server_id)
