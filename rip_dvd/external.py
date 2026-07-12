import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.parse
import urllib.request

from .core import MovieMetadata, parse_lsdvd_output, pretty_from_label, sanitize_filename
from .output import log, log_error


METADATA_TIMEOUT_SECONDS = 30


def run(cmd, timeout=METADATA_TIMEOUT_SECONDS):
    executable = shutil.which(cmd[0])
    if not executable:
        return subprocess.CompletedProcess(cmd, 127, "", f"{cmd[0]} not found")
    cmd = [executable, *cmd[1:]]
    try:
        return subprocess.run(
            cmd,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = (exc.stderr or "") + f"\n{cmd[0]} timed out after {timeout} seconds"
        return subprocess.CompletedProcess(cmd, 124, stdout, stderr)


def ffmpeg_tool(name):
    bundled = Path("/usr/lib/jellyfin-ffmpeg") / name
    if bundled.exists():
        return str(bundled)
    return shutil.which(name) or name


def dvd_title_hint(device):
    candidates = []
    proc = run(["lsdvd", device])
    text = proc.stdout + "\n" + proc.stderr
    for line in text.splitlines():
        if "Disc Title:" not in line:
            continue
        candidates.append(line.split("Disc Title:", 1)[1].strip())

    proc = run(["blkid", "-o", "value", "-s", "LABEL", device])
    if proc.stdout.strip():
        candidates.append(proc.stdout.strip())

    for item in candidates:
        cleaned = pretty_from_label(item)
        if cleaned and cleaned.lower() not in {"unknown", "dvdvideo", "video_ts"}:
            return cleaned
    return ""


def scan_dvd_titles(device):
    proc = run(["lsdvd", device], timeout=90)
    text = proc.stdout + "\n" + proc.stderr
    return parse_lsdvd_output(text, returncode=proc.returncode)


def resolve_movie_metadata(device, name=None, year=None, fallback_title_suffix=""):
    log("Checking DVD metadata...")
    hint = dvd_title_hint(device)
    if os.environ.get("TMDB_API_KEY") and hint:
        log("Looking up title and year with TMDb...")
    lookup = tmdb_lookup(hint)

    resolved_title = name or (lookup or {}).get("title") or hint or f"DVD Rip {dt.datetime.now():%Y-%m-%d %H%M}"
    resolved_year = year or (lookup or {}).get("year") or ""
    if fallback_title_suffix and not name:
        resolved_title = f"{resolved_title} - {fallback_title_suffix}"

    return MovieMetadata(
        hint=hint,
        title=sanitize_filename(resolved_title),
        year=resolved_year,
    )


def tmdb_lookup(query):
    api_key = os.environ.get("TMDB_API_KEY", "").strip()
    if not api_key or not query:
        return None

    params = urllib.parse.urlencode({"api_key": api_key, "query": query, "include_adult": "false"})
    url = "https://api.themoviedb.org/3/search/movie?" + params
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "rip-dvd/1.0"})

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except Exception as exc:
        log_error(f"TMDb lookup failed: {exc}")
        return None

    results = data.get("results") or []
    if not results:
        return None

    best = results[0]
    title = best.get("title") or best.get("original_title") or query
    release_date = best.get("release_date") or ""
    result_year = release_date[:4] if release_date[:4].isdigit() else ""
    return {"title": title, "year": result_year}

