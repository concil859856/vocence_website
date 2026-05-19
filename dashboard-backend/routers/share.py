"""Public share + embed pages for playbooks.

Two routes, both mounted at the FastAPI app root (no /api prefix):

  GET /p/{playbook_id}        → OG-tagged landing page
  GET /embed/p/{playbook_id}  → iframe-friendly mini-player

The landing page exists so that pasting a Vocence playbook link into
Discord / Slack / Facebook / LinkedIn / X renders a rich preview card
instead of a bare URL. The page also serves a visible fallback for
human visitors (cover + title + "Open in Vocence" CTA) and a JS
redirect to the canonical SPA URL so the share-link round-trip feels
fast for clickers.

The embed page is what X's Player Card iframe loads (subject to X
whitelist approval — see frontend doc). It's a self-contained mini
player: cover, title, creator, sequential HTML5 audio playback of all
the playbook's tracks.

Both endpoints only honour PUBLIC playbooks. Private playbooks return
404 so we don't leak titles via shared URLs the owner didn't intend.
"""

from __future__ import annotations

import html
import json
import os
from typing import Iterable

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from local_db import get_connection

router = APIRouter(tags=["share"])

# Canonical site URL the share landing redirects humans to and that
# we use to build the embed/twitter:player URL. Override via env in
# staging/production deployments where the public hostname differs.
PUBLIC_SITE_URL = os.environ.get("PUBLIC_SITE_URL", "https://www.vocence.ai").rstrip("/")
# Sites that should fetch our share pages (Discord/Slack/X/etc.) all
# benefit from a short shared cache. 5 min is short enough that an
# edited title propagates quickly on a re-share, long enough to absorb
# burst traffic from a viral link.
_SHARE_CACHE_CONTROL = "public, max-age=300, s-maxage=300"


def _format_minutes(total_seconds: float) -> str:
    minutes = int(round(total_seconds / 60))
    if minutes < 60:
        return f"{minutes} min"
    h, m = divmod(minutes, 60)
    return f"{h}h" if m == 0 else f"{h}h {m}m"


def _build_description(track_count: int, total_seconds: float, creator: str) -> str:
    """Human-friendly one-liner shown in the Discord/Slack/X preview
    card and in the page <meta description>."""
    plural = "" if track_count == 1 else "s"
    return f"{track_count} track{plural} · {_format_minutes(total_seconds)} · by {creator}"


def _absolute(url: str | None) -> str | None:
    """Promote a possibly-relative URL to an absolute one rooted at
    PUBLIC_SITE_URL. Discord/Slack/X scrapers need absolute URLs in
    og:audio + og:image; the embed iframe (loaded from the backend
    origin) also needs absolute audio src or it resolves against the
    backend host and 404s. Most real tracks already have absolute R2
    URLs, but sample tracks point to /samples/... on the SPA host."""
    if not url:
        return url
    if url.startswith(("http://", "https://", "//")):
        return url
    return f"{PUBLIC_SITE_URL}{url if url.startswith('/') else '/' + url}"


def _audio_mime_for_url(url: str) -> str:
    """Best-effort MIME for og:audio. We don't store MIME per track,
    so we infer from the file extension. Defaults to audio/mpeg
    because that's what every major platform's OG audio scraper
    expects when the type is ambiguous."""
    lowered = url.lower().split("?", 1)[0]
    if lowered.endswith(".mp3"):
        return "audio/mpeg"
    if lowered.endswith(".wav"):
        return "audio/wav"
    if lowered.endswith(".ogg") or lowered.endswith(".oga"):
        return "audio/ogg"
    if lowered.endswith(".m4a") or lowered.endswith(".aac"):
        return "audio/mp4"
    if lowered.endswith(".flac"):
        return "audio/flac"
    return "audio/mpeg"


@router.get("/p/{playbook_id}", response_class=HTMLResponse)
async def share_landing(playbook_id: int) -> HTMLResponse:
    """OG-tagged landing page. Bots read the meta tags and render rich
    previews; humans see a brief landing card and get JS-redirected to
    the SPA. Only public playbooks; private/non-existent → 404."""
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            """
            SELECT p.id, p.title, p.description, p.cover_image_url, p.visibility,
                   u.name AS user_name, u.picture AS user_picture
            FROM playbooks p
            JOIN auth_users u ON u.id = p.user_id
            WHERE p.id = ?
            """,
            (playbook_id,),
        )).fetchone()
        if not pb or (pb["visibility"] or "private") != "public":
            raise HTTPException(status_code=404, detail="Playbook not found")

        first_track = await (await conn.execute(
            """
            SELECT audio_url FROM playbook_tracks
            WHERE playbook_id = ? ORDER BY position ASC LIMIT 1
            """,
            (playbook_id,),
        )).fetchone()

        counts = await (await conn.execute(
            """
            SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS dur
            FROM playbook_tracks WHERE playbook_id = ?
            """,
            (playbook_id,),
        )).fetchone()
    finally:
        await conn.close()

    title = (pb["title"] or "Untitled Playbook").strip()
    creator = (pb["user_name"] or "Anonymous").strip()
    track_count = int(counts["n"] or 0)
    total_sec = float(counts["dur"] or 0)
    description = _build_description(track_count, total_sec, creator)
    # Promote any relative track/cover URLs (sample-deck assets live on
    # the SPA host) to absolute so external scrapers can fetch them.
    cover = _absolute(pb["cover_image_url"])
    first_audio = _absolute(first_track["audio_url"]) if first_track else None

    spa_url = f"{PUBLIC_SITE_URL}/studio/playbooks/{playbook_id}"
    embed_url = f"{PUBLIC_SITE_URL}/embed/p/{playbook_id}"

    e = html.escape
    # Per-tag fragments. We omit og:image when no cover is set so
    # platforms fall back to their default unfurl rather than show a
    # broken image — better default behavior than serving a placeholder.
    og_image_tags = (
        f'<meta property="og:image" content="{e(cover)}">\n'
        f'<meta name="twitter:image" content="{e(cover)}">'
        if cover else ""
    )
    audio_tags = (
        f'<meta property="og:audio" content="{e(first_audio)}">\n'
        f'<meta property="og:audio:type" content="{_audio_mime_for_url(first_audio)}">'
        if first_audio else ""
    )

    # JSON-encode the SPA URL so we can safely interpolate into the
    # JS redirect without worrying about quotes in the URL.
    spa_url_js = json.dumps(spa_url)

    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(title)} · Vocence</title>
  <meta name="description" content="{e(description)}">

  <!-- Open Graph — Discord, Slack, Facebook, LinkedIn, iMessage, Telegram, WhatsApp -->
  <meta property="og:title" content="{e(title)}">
  <meta property="og:description" content="{e(description)}">
  <meta property="og:url" content="{e(spa_url)}">
  <meta property="og:type" content="music.playlist">
  <meta property="og:site_name" content="Vocence">
  {og_image_tags}
  {audio_tags}

  <!-- Twitter / X Player Card — requires whitelist approval (see /devnotes) -->
  <meta name="twitter:card" content="player">
  <meta name="twitter:site" content="@vocence">
  <meta name="twitter:title" content="{e(title)}">
  <meta name="twitter:description" content="{e(description)}">
  <meta name="twitter:player" content="{e(embed_url)}">
  <meta name="twitter:player:width" content="500">
  <meta name="twitter:player:height" content="320">

  <!-- Canonical (SPA URL) — search engines, bookmarks -->
  <link rel="canonical" href="{e(spa_url)}">

  <style>
    html, body {{ margin: 0; padding: 0; background: #07080A; color: #F5F7FF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }}
    body {{ min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }}
    .card {{ max-width: 480px; text-align: center; }}
    .cover, .cover-fallback {{ width: 280px; height: 280px; border-radius: 16px; margin: 0 auto 24px; display: block; box-shadow: 0 16px 40px rgba(0,0,0,0.55); }}
    .cover {{ object-fit: cover; }}
    .cover-fallback {{ background: linear-gradient(135deg, #1c1d21, #111215); display: flex; align-items: center; justify-content: center; color: #3a3b3f; font-size: 32px; }}
    h1 {{ font-size: 28px; line-height: 1.2; margin: 0 0 8px; word-break: break-word; }}
    .creator {{ color: #A7B0B7; font-size: 14px; margin: 0 0 6px; }}
    .stats {{ color: #666; font-size: 13px; margin: 0 0 28px; }}
    a.cta {{ display: inline-flex; align-items: center; gap: 8px; background: #DFFF00; color: #07080A; padding: 14px 28px; border-radius: 999px; font-weight: 700; text-decoration: none; font-size: 14px; }}
    a.cta:hover {{ filter: brightness(1.05); }}
    .brand {{ position: absolute; top: 20px; left: 20px; font-size: 12px; color: #A7B0B7; letter-spacing: 0.18em; text-transform: uppercase; }}
  </style>
</head>
<body>
  <div class="brand">Vocence</div>
  <div class="card">
    {('<img class="cover" src="' + e(cover) + '" alt="">') if cover else '<div class="cover-fallback">♪</div>'}
    <h1>{e(title)}</h1>
    <p class="creator">by {e(creator)}</p>
    <p class="stats">{e(description)}</p>
    <a class="cta" href="{e(spa_url)}">Open in Vocence →</a>
  </div>
  <script>
    // Redirect humans to the SPA after a beat. Bots that don't run JS
    // see the visible card above plus the OG metadata and render their
    // preview without redirecting.
    setTimeout(function() {{ try {{ location.replace({spa_url_js}); }} catch (_) {{}} }}, 150);
  </script>
</body>
</html>"""

    return HTMLResponse(content=body, headers={"Cache-Control": _SHARE_CACHE_CONTROL})


def _tracks_for_embed(rows: Iterable) -> list[dict[str, str]]:
    """Shape the track rows into the minimal JSON the embed player
    needs. Title only used as a now-playing label; subtitle dropped
    because the embed is space-constrained. URLs are absolute so
    the iframe (loaded from the backend origin) can fetch them
    without resolving against the wrong host."""
    out: list[dict[str, str]] = []
    for r in rows:
        url = _absolute(r["audio_url"])
        if not url:
            continue
        out.append({"url": url, "title": r["title"] or "Track"})
    return out


@router.get("/embed/p/{playbook_id}", response_class=HTMLResponse)
async def embed_player(playbook_id: int) -> HTMLResponse:
    """Iframe-friendly mini-player. Used by X's Player Card and any
    third party that wants to embed a Vocence playbook (Notion, blog
    posts, Discord rich embeds, etc.). Cover on the left, title and
    sequential HTML5 audio playback on the right.

    Public playbooks only — embedding a private playbook would be a
    leak of intent (the owner hadn't shared it). 404 to match the
    share landing behaviour for private/missing playbooks."""
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            """
            SELECT p.id, p.title, p.cover_image_url, p.visibility,
                   u.name AS user_name
            FROM playbooks p
            JOIN auth_users u ON u.id = p.user_id
            WHERE p.id = ?
            """,
            (playbook_id,),
        )).fetchone()
        if not pb or (pb["visibility"] or "private") != "public":
            raise HTTPException(status_code=404, detail="Playbook not found")

        track_rows = await (await conn.execute(
            """
            SELECT audio_url, title FROM playbook_tracks
            WHERE playbook_id = ? ORDER BY position ASC
            """,
            (playbook_id,),
        )).fetchall()
    finally:
        await conn.close()

    title = (pb["title"] or "Untitled Playbook").strip()
    creator = (pb["user_name"] or "Anonymous").strip()
    cover = _absolute(pb["cover_image_url"])
    tracks = _tracks_for_embed(track_rows)

    e = html.escape
    tracks_js = json.dumps(tracks)
    open_url = f"{PUBLIC_SITE_URL}/studio/playbooks/{playbook_id}"

    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(title)} — Vocence player</title>
  <style>
    html, body {{ margin: 0; padding: 0; background: #0B0D10; color: #F5F7FF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; height: 100%; }}
    body {{ display: flex; align-items: stretch; }}
    .wrap {{ display: flex; width: 100%; height: 320px; min-height: 100%; }}
    .art {{ width: 320px; height: 320px; flex-shrink: 0; background: linear-gradient(135deg, #1c1d21, #111215); position: relative; overflow: hidden; }}
    .art img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
    .art-fallback {{ display: flex; align-items: center; justify-content: center; height: 100%; color: #3a3b3f; font-size: 48px; }}
    .meta {{ flex: 1; min-width: 0; padding: 18px 20px; display: flex; flex-direction: column; justify-content: space-between; }}
    .meta-top {{ min-width: 0; }}
    .label {{ text-transform: uppercase; letter-spacing: 0.18em; font-size: 10px; color: #A7B0B7; font-weight: 600; }}
    h1 {{ margin: 6px 0 4px; font-size: 22px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }}
    .creator {{ color: #A7B0B7; font-size: 13px; margin: 0 0 12px; }}
    .now-playing {{ color: #DFFF00; font-size: 12px; min-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
    audio {{ width: 100%; margin-top: 12px; }}
    .footer {{ display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }}
    .footer a {{ color: #A7B0B7; text-decoration: none; font-size: 12px; }}
    .footer a:hover {{ color: #fff; }}
    .footer .brand {{ color: #DFFF00; font-weight: 700; letter-spacing: 0.18em; font-size: 11px; }}
    @media (max-width: 480px) {{
      .wrap {{ flex-direction: column; height: auto; }}
      .art {{ width: 100%; height: 220px; }}
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="art">
      {('<img src="' + e(cover) + '" alt="">') if cover else '<div class="art-fallback">♪</div>'}
    </div>
    <div class="meta">
      <div class="meta-top">
        <div class="label">Playbook</div>
        <h1>{e(title)}</h1>
        <p class="creator">by {e(creator)}</p>
        <div class="now-playing" id="now-playing">{f"{len(tracks)} track" + ("s" if len(tracks) != 1 else "")}</div>
        <audio id="player" controls preload="metadata"></audio>
      </div>
      <div class="footer">
        <a href="{e(open_url)}" target="_blank" rel="noopener">Open full playbook ↗</a>
        <span class="brand">VOCENCE</span>
      </div>
    </div>
  </div>
  <script>
    // Sequential playback: when one track ends, advance to the next.
    // No autoplay — browsers (and X) block it without a user gesture
    // anyway, and starting silent is the safer default for an iframe
    // embedded in someone else's feed.
    var TRACKS = {tracks_js};
    var audio = document.getElementById('player');
    var label = document.getElementById('now-playing');
    var idx = 0;

    function load(i) {{
      if (!TRACKS[i]) return;
      audio.src = TRACKS[i].url;
      label.textContent = (i + 1) + '/' + TRACKS.length + ' · ' + TRACKS[i].title;
    }}

    if (TRACKS.length > 0) {{
      load(0);
      audio.addEventListener('ended', function() {{
        idx++;
        if (idx < TRACKS.length) {{ load(idx); audio.play(); }}
      }});
    }} else {{
      label.textContent = 'No tracks';
      audio.style.display = 'none';
    }}
  </script>
</body>
</html>"""

    # Allow iframe embedding from anywhere. The default X-Frame-Options
    # / frame-ancestors restrictions would block X / Discord / Notion
    # from showing this. We accept the (small) clickjacking risk
    # because the embed has no logged-in surface — it can't do anything
    # beyond playing public audio.
    return HTMLResponse(
        content=body,
        headers={
            "Cache-Control": _SHARE_CACHE_CONTROL,
            # Explicitly clear restrictive defaults so iframes work.
            "Content-Security-Policy": "frame-ancestors *",
        },
    )
