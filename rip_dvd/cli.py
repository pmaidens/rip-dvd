import argparse
from collections import deque
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import replace

from .core import (
    EncodeQueueItem,
    build_disc_archive_plan as build_disc_archive_plan_core,
    build_encode_plan,
    build_extra_plan as build_extra_plan_core,
    build_rip_plan as build_rip_plan_core,
    classify_title,
    concat_escape,
    default_extra_name,
    find_title,
    format_duration,
    parse_handbrake_progress,
    parse_title_numbers,
    partial_output_path,
    pretty_from_label,
    quote_cmd,
    suggested_extra_titles,
)
from .external import ffmpeg_tool, resolve_movie_metadata, scan_dvd_titles
from .output import RipProgressDisplay, log, log_error, prompt, prompt_yes_no


DEFAULT_PRESET = "Fast 480p30"
DEFAULT_DEVICE = "/dev/sr0"
DEFAULT_LIBRARY = "/srv/media/Movies"
DEFAULT_ORIGINALS_LIBRARY = "/srv/media/DVD Originals"


class EtaTracker:
    def __init__(self):
        self.started_at = None

    def estimate(self, percent):
        if self.started_at is None:
            self.started_at = time.monotonic()
        if percent <= 0:
            return "calculating"
        elapsed = time.monotonic() - self.started_at
        remaining = elapsed * ((100 - percent) / percent)
        return format_duration(remaining)


def print_title_summary(scan):
    disc_label = pretty_from_label(scan.disc_title) if scan.disc_title else "(unknown)"
    log(f"Disc title: {disc_label}")
    if not scan.titles:
        log("No DVD titles found.")
        return

    feature_count = sum(1 for title in scan.titles if title.seconds >= 3600)
    log("Titles found:")
    for title in sorted(scan.titles, key=lambda item: item.number):
        classification = classify_title(title.seconds, feature_count=feature_count)
        log(
            f"[{title.number:02d}] {format_duration(title.seconds):>8}  "
            f"chapters={title.chapters:>2}  audio={title.audio_streams:>2}  "
            f"subtitles={title.subtitles:>2}  {classification}"
        )


def scan_mode(device):
    if not Path(device).exists():
        log_error(f"DVD device not found: {device}")
        return 2

    log(f"Scanning DVD titles from {device}...")
    scan = scan_dvd_titles(device)
    if scan.returncode != 0 and not scan.titles:
        log_error("Could not scan DVD titles.")
        if scan.raw_output:
            log_error("Recent scanner output:")
            for line in scan.raw_output.splitlines()[-20:]:
                log_error(line)
        return scan.returncode or 1

    print_title_summary(scan)
    if not scan.titles:
        return 1

    log("This scan does not rip anything. Use it to decide which titles should become movies or extras.")
    return 0


def build_rip_plan(device, library, preset, command="rip", selected_title_number=None, name=None, year=None, verbose=False):
    if not Path(device).exists():
        log_error(f"DVD device not found: {device}")
        return None, 2

    fallback_suffix = f"Title {selected_title_number:02d}" if command == "title" else ""
    metadata = resolve_movie_metadata(
        device,
        name=name,
        year=year,
        fallback_title_suffix=fallback_suffix,
    )
    year_part = f" ({metadata.year})" if metadata.year else ""
    plan = build_rip_plan_core(
        device,
        library,
        preset,
        metadata,
        command=command,
        selected_title_number=selected_title_number,
    )

    log(f"Found title: {metadata.title}{year_part}")
    if metadata.hint and verbose:
        log(f"DVD label hint: {metadata.hint}")
    if not os.environ.get("TMDB_API_KEY") and verbose:
        log("TMDb lookup skipped; set TMDB_API_KEY to auto-fill title/year from the disc hint.")
    log(f"Output: {plan.output}")
    if command == "title":
        log(f"Selected DVD title: {selected_title_number}")
    return plan, 0


def build_extra_plan(device, preset, movie_dir, title_number, title_info=None, extra_name=None, sequence=None):
    plan = build_extra_plan_core(
        device,
        preset,
        movie_dir,
        title_number,
        title_info=title_info,
        extra_name=extra_name,
        sequence=sequence,
    )
    log(f"Extra title {title_number}: {plan.output.stem}")
    log(f"Output: {plan.output}")
    return plan


def stream_archive_command(cmd, verbose=False):
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=0,
        universal_newlines=True,
    )
    recent = deque(maxlen=30)
    buffer = ""
    last_segment = None

    while True:
        char = proc.stdout.read(1) if proc.stdout else ""
        if char == "":
            break
        if verbose:
            sys.stdout.write(char)
            sys.stdout.flush()
        buffer += char
        if char not in {"\r", "\n"}:
            continue

        segment = buffer.strip()
        buffer = ""
        if not segment:
            continue
        recent.append(segment)
        if not verbose and segment != last_segment:
            log(f"Archive progress: {segment}")
            last_segment = segment

    if buffer.strip():
        segment = buffer.strip()
        recent.append(segment)
        if not verbose and segment != last_segment:
            log(f"Archive progress: {segment}")

    return proc.wait(), list(recent)


def execute_archive_plan(plan, dry_run=False, verbose=False, existing_verified=False):
    if dry_run or verbose:
        log("Archive command:")
        log(quote_cmd(plan.cmd))

    if plan.output.exists():
        if not existing_verified:
            log_error(f"Refusing to reuse an unverified original backup: {plan.output}")
            return 2
        log(f"Verified original backup already exists; leaving it unchanged: {plan.output}")
        return 0
    if dry_run:
        return 0

    partial_output = partial_output_path(plan.output)
    plan.output.parent.mkdir(parents=True, exist_ok=True)
    if partial_output.exists():
        stale_path = failed_output_path(partial_output)
        partial_output.rename(stale_path)
        log_error(f"Stale partial disc archive moved to: {stale_path}")
    log("Archiving the full original disc before any encoding work...")
    log(f"Original backup: {plan.output}")

    returncode, recent = stream_archive_command(plan.cmd, verbose=verbose)
    if returncode != 0:
        log_error(f"Disc archive failed with exit code {returncode}.")
        if recent and not verbose:
            log_error("Recent archive output:")
            for line in recent:
                log_error(line)
        if partial_output.exists():
            failed_path = failed_output_path(partial_output)
            partial_output.rename(failed_path)
            log_error(f"Partial original backup moved to: {failed_path}")
        return returncode

    if not partial_output.exists() or partial_output.stat().st_size == 0:
        log_error("Disc archive command reported success but did not create a non-empty backup.")
        if partial_output.exists():
            failed_path = failed_output_path(partial_output)
            partial_output.rename(failed_path)
            log_error(f"Empty original backup moved to: {failed_path}")
        return 1

    os.replace(partial_output, plan.output)
    fsync_directory(plan.output.parent)
    log(f"Original backup saved: {plan.output}")
    return 0


def queue_job(source, output, preset, metadata_path, label, title_number):
    return EncodeQueueItem(
        source=Path(source),
        output=Path(output),
        preset=preset,
        metadata_path=Path(metadata_path),
        label=label,
        title_number=int(title_number) if title_number is not None else None,
    )


def queue_job_to_json(job):
    return {
        "label": job.label,
        "source": str(job.source),
        "output": str(job.output),
        "preset": job.preset,
        "selection": "main_feature" if job.title_number is None else "title",
        "title_number": job.title_number,
    }


def scan_identity(scan):
    return {
        "disc_title": scan.disc_title.strip(),
        "titles": [
            {
                "number": title.number,
                "seconds": title.seconds,
                "chapters": title.chapters,
                "audio_streams": title.audio_streams,
                "subtitles": title.subtitles,
            }
            for title in sorted(scan.titles, key=lambda item: item.number)
        ],
    }


def disc_fingerprint(scan):
    payload = json.dumps(scan_identity(scan), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def metadata_fingerprint(data):
    try:
        stored = data.get("disc_fingerprint")
        if stored:
            return stored
        if "disc_title" not in data or not data.get("titles"):
            return None
        identity = {
            "disc_title": str(data.get("disc_title") or "").strip(),
            "titles": [
                {
                    "number": int(item.get("number", 0)),
                    "seconds": int(item.get("seconds", 0)),
                    "chapters": int(item.get("chapters", 0)),
                    "audio_streams": int(item.get("audio_streams", 0)),
                    "subtitles": int(item.get("subtitles", 0)),
                }
                for item in sorted(data["titles"], key=lambda item: int(item.get("number", 0)))
            ],
        }
    except (AttributeError, TypeError, ValueError):
        return None
    payload = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def atomic_write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        temp_path = None
        fsync_directory(path.parent)
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass


def validate_archive_identity(archive_plan, scan):
    archive_exists = archive_plan.output.exists()
    metadata_exists = archive_plan.metadata_path.exists()
    if not archive_exists and not metadata_exists:
        return False, 0
    if not metadata_exists:
        log_error(f"Original backup exists without queue metadata: {archive_plan.output}")
        log_error("Refusing to attach this disc to an archive whose identity cannot be verified.")
        return False, 2

    data = read_queue_metadata(archive_plan.metadata_path)
    if data is None:
        log_error("Refusing to reuse or replace an archive with unreadable queue metadata.")
        return False, 2

    expected = disc_fingerprint(scan)
    actual = metadata_fingerprint(data)
    if actual != expected:
        log_error(f"The disc in {archive_plan.output.parent} does not match the inserted disc.")
        log_error("Choose a different --name/--year or originals library path; the existing backup was not changed.")
        return False, 2

    recorded_source = data.get("source")
    if recorded_source and Path(recorded_source) != archive_plan.output:
        log_error(f"Queue metadata points to a different original backup: {recorded_source}")
        return False, 2
    if archive_exists and data.get("archive_status", "ready") not in {"ready", "archiving"}:
        log_error(f"Original backup is not marked ready: {archive_plan.output}")
        return False, 2

    return archive_exists, 0


def write_queue_metadata(archive_plan, metadata, jobs, scan=None, archive_status="ready"):
    archive_plan.metadata_path.parent.mkdir(parents=True, exist_ok=True)
    existing = {}
    if archive_plan.metadata_path.exists():
        try:
            existing = json.loads(archive_plan.metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise OSError(f"could not preserve existing queue metadata: {exc}") from exc
        if not isinstance(existing, dict):
            raise ValueError("existing queue metadata top-level value must be an object")

    fingerprint = disc_fingerprint(scan) if scan else None
    existing_fingerprint = metadata_fingerprint(existing) if existing else None
    if existing_fingerprint and fingerprint and existing_fingerprint != fingerprint:
        raise ValueError("existing queue metadata belongs to a different disc")

    jobs_by_output = {}
    existing_jobs = existing.get("jobs", [])
    if not isinstance(existing_jobs, list):
        raise ValueError("existing queue metadata has an invalid jobs list")
    for item in existing_jobs:
        if not isinstance(item, dict):
            raise ValueError("existing queue metadata has an invalid job")
        output = item.get("output")
        if output:
            jobs_by_output[output] = item
    for job in jobs:
        jobs_by_output[str(job.output)] = queue_job_to_json(job)

    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    data = {
        "schema_version": 2,
        "archive_status": archive_status,
        "created_at": existing.get("created_at") or now,
        "updated_at": now,
        "source": str(archive_plan.output),
        "movie_dir": str(archive_plan.movie_dir),
        "title": metadata.title,
        "year": metadata.year,
        "disc_hint": metadata.hint,
        "disc_title": scan.disc_title if scan else "",
        "disc_fingerprint": fingerprint,
        "titles": [
            {
                "number": title.number,
                "duration_text": title.duration_text,
                "seconds": title.seconds,
                "chapters": title.chapters,
                "audio_streams": title.audio_streams,
                "subtitles": title.subtitles,
            }
            for title in (scan.titles if scan else [])
        ],
        "jobs": list(jobs_by_output.values()),
    }
    atomic_write_json(archive_plan.metadata_path, data)
    log(f"Encode queue metadata: {archive_plan.metadata_path}")


def read_queue_metadata(metadata_path):
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("top-level value must be an object")
        return data
    except (OSError, ValueError) as exc:
        log_error(f"Could not read queue metadata {metadata_path}: {exc}")
        return None


def discover_encode_jobs(originals_library):
    queue_root = Path(originals_library)
    if not queue_root.exists():
        return []

    jobs = []
    for metadata_path in sorted(queue_root.rglob("*.rip-dvd.json")):
        data = read_queue_metadata(metadata_path)
        if not data:
            continue

        if data.get("archive_status", "ready") != "ready":
            log(f"Archive is not ready for encoding yet: {metadata_path}")
            continue

        source = Path(data.get("source") or metadata_path.with_suffix(".iso"))
        if not source.exists():
            log_error(f"Original backup is missing for queue metadata: {source}")
            continue

        raw_jobs = data.get("jobs", [])
        if not isinstance(raw_jobs, list):
            log_error(f"Skipping invalid jobs list in {metadata_path}")
            continue
        for raw_job in raw_jobs:
            try:
                output = Path(raw_job["output"])
                if "title_number" not in raw_job:
                    raise KeyError("title_number")
                raw_title_number = raw_job["title_number"]
                if raw_title_number is None:
                    if raw_job.get("selection") != "main_feature":
                        raise ValueError("null title without main_feature selection")
                    title_number = None
                else:
                    title_number = int(raw_title_number)
            except (AttributeError, KeyError, TypeError, ValueError):
                log_error(f"Skipping invalid encode job in {metadata_path}")
                continue
            if output.exists():
                continue
            jobs.append(
                queue_job(
                    source,
                    output,
                    raw_job.get("preset") or DEFAULT_PRESET,
                    metadata_path,
                    raw_job.get("label") or output.stem,
                    title_number,
                )
            )
    return jobs


def idle_command(cmd):
    wrapped = list(cmd)
    ionice = shutil.which("ionice")
    if ionice:
        wrapped = [ionice, "-c", "3", *wrapped]
    nice = shutil.which("nice")
    if nice:
        wrapped = [nice, "-n", "19", *wrapped]
    return wrapped


def failed_output_path(path):
    path = Path(path)
    candidate = path.with_suffix(path.suffix + ".failed")
    if not candidate.exists():
        return candidate
    for index in range(1, 1000):
        candidate = path.with_suffix(path.suffix + f".failed.{index}")
        if not candidate.exists():
            return candidate
    return path.with_suffix(path.suffix + f".failed.{int(time.time())}")


def fsync_directory(path):
    directory_fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def encode_lock_path(output):
    output = Path(output)
    return output.with_name(f".{output.name}.rip-dvd.lock")


def progress_label(plan, index, total):
    if total == 1:
        return plan.output.stem
    if index == 0:
        prefix = "Movie"
    else:
        prefix = f"Extra {index}"
    return f"{prefix}: {plan.output.stem}"


def execute_rip_plan(plan, dry_run=False, verbose=False, progress_display=None, progress_index=0):
    if dry_run or verbose:
        log("Command:")
        log(quote_cmd(plan.cmd))
    if dry_run:
        return 0

    own_progress = None
    if progress_display is None and not verbose:
        own_progress = RipProgressDisplay([progress_label(plan, 0, 1)])
        progress_display = own_progress
        progress_display.begin()

    plan.movie_dir.mkdir(parents=True, exist_ok=True)
    code = stream_handbrake(plan.cmd, plan.output, verbose=verbose, progress_display=progress_display, progress_index=progress_index)
    if code == 0 and own_progress is not None:
        own_progress.finish()
        log(f"Done: {plan.output}")
    return code


def execute_rip_plans(plans, dry_run=False, verbose=False):
    if not plans:
        return 0

    progress = None
    if not dry_run and not verbose:
        labels = [progress_label(plan, index, len(plans)) for index, plan in enumerate(plans)]
        progress = RipProgressDisplay(labels)
        progress.begin()

    for index, plan in enumerate(plans, start=1):
        if progress is None:
            log(f"Rip {index} of {len(plans)}")
        else:
            progress.update(index - 1, 0, "starting")
        code = execute_rip_plan(
            plan,
            dry_run=dry_run,
            verbose=verbose,
            progress_display=progress,
            progress_index=index - 1,
        )
        if code != 0:
            if index < len(plans):
                log_error("Stopping remaining rips because this rip failed.")
            return code
    if progress is not None:
        progress.finish()
        log("All rips complete.")
    return 0


def execute_encode_job(job, dry_run=False, verbose=False, progress_display=None, progress_index=0, idle=True):
    job.output.parent.mkdir(parents=True, exist_ok=True)
    lock_path = encode_lock_path(job.output)
    with lock_path.open("a+", encoding="utf-8") as lock_handle:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log(f"Encode is already running for: {job.output}")
            return None
        try:
            return execute_encode_job_locked(
                job,
                dry_run=dry_run,
                verbose=verbose,
                progress_display=progress_display,
                progress_index=progress_index,
                idle=idle,
            )
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def execute_encode_job_locked(job, dry_run=False, verbose=False, progress_display=None, progress_index=0, idle=True):
    final_output = job.output
    partial_output = partial_output_path(final_output)
    if final_output.exists():
        log(f"Encode output already exists; leaving it unchanged: {final_output}")
        return 0

    if partial_output.exists() and not dry_run:
        stale_path = failed_output_path(partial_output)
        partial_output.rename(stale_path)
        log_error(f"Stale partial encode moved to: {stale_path}")

    plan = build_encode_plan(job.source, partial_output, job.preset, job.title_number)
    if idle:
        plan = replace(plan, cmd=idle_command(plan.cmd))
    if dry_run or verbose:
        log(f"Final output after successful encode: {final_output}")

    code = execute_rip_plan(
        plan,
        dry_run=dry_run,
        verbose=verbose,
        progress_display=progress_display,
        progress_index=progress_index,
    )
    if dry_run:
        return code
    if code != 0:
        if partial_output.exists():
            failed_path = failed_output_path(partial_output)
            partial_output.rename(failed_path)
            log_error(f"Partial encode moved to: {failed_path}")
        return code
    if not partial_output.exists():
        log_error(f"HandBrake reported success but did not create its output: {partial_output}")
        return 1
    if final_output.exists():
        failed_path = failed_output_path(partial_output)
        partial_output.rename(failed_path)
        log_error(f"Final output appeared while encoding; it was not overwritten: {final_output}")
        log_error(f"Completed competing encode moved to: {failed_path}")
        return 2

    os.replace(partial_output, final_output)
    fsync_directory(final_output.parent)
    log(f"Encoded file published: {final_output}")
    return 0


def scan_for_archive(device, scan=None):
    if scan is not None:
        return scan, 0

    log("Scanning disc titles for the encode queue...")
    scan = scan_dvd_titles(device)
    if scan.returncode != 0 and not scan.titles:
        log_error("Could not scan DVD titles.")
        if scan.raw_output:
            log_error("Recent scanner output:")
            for line in scan.raw_output.splitlines()[-20:]:
                log_error(line)
        return scan, scan.returncode or 1
    if not scan.titles:
        log_error("No DVD titles found.")
        return scan, 1
    return scan, 0


def archive_mode(
    device,
    library,
    originals_library,
    preset,
    command="rip",
    selected_title_number=None,
    extra_title_numbers=None,
    name=None,
    year=None,
    dry_run=False,
    verbose=False,
    scan=None,
    extra_names=None,
):
    if not Path(device).exists():
        log_error(f"DVD device not found: {device}")
        return 2

    scan, code = scan_for_archive(device, scan=scan)
    if code != 0:
        return code

    available = {title.number for title in scan.titles}
    if command == "title":
        main_title = selected_title_number
    else:
        main_title = None

    if main_title is not None and main_title not in available:
        log_error(f"Title {main_title} was not found in the scan.")
        print_title_summary(scan)
        return 2

    extra_title_numbers = extra_title_numbers or []
    missing = [number for number in extra_title_numbers if number not in available]
    if missing:
        log_error(f"Title number(s) not found in scan: {', '.join(str(number) for number in missing)}")
        print_title_summary(scan)
        return 2

    fallback_suffix = f"Title {selected_title_number:02d}" if command == "title" else ""
    metadata = resolve_movie_metadata(
        device,
        name=name,
        year=year,
        fallback_title_suffix=fallback_suffix,
    )
    year_part = f" ({metadata.year})" if metadata.year else ""
    archive_plan = build_disc_archive_plan_core(device, library, originals_library, metadata)

    main_plan = build_rip_plan_core(
        device,
        library,
        preset,
        metadata,
        command="title" if main_title is not None else "rip",
        selected_title_number=main_title,
    )

    jobs = [
        queue_job(
            archive_plan.output,
            main_plan.output,
            preset,
            archive_plan.metadata_path,
            f"Movie: {main_plan.output.stem}",
            main_title,
        )
    ]
    for index, number in enumerate(extra_title_numbers, start=1):
        extra_plan = build_extra_plan_core(
            device,
            preset,
            main_plan.movie_dir,
            number,
            title_info=find_title(scan, number),
            extra_name=(extra_names or {}).get(number),
            sequence=index,
        )
        jobs.append(
            queue_job(
                archive_plan.output,
                extra_plan.output,
                preset,
                archive_plan.metadata_path,
                f"Extra {index}: {extra_plan.output.stem}",
                number,
            )
        )

    log(f"Found title: {metadata.title}{year_part}")
    if metadata.hint and verbose:
        log(f"DVD label hint: {metadata.hint}")
    if not os.environ.get("TMDB_API_KEY") and verbose:
        log("TMDb lookup skipped; set TMDB_API_KEY to auto-fill title/year from the disc hint.")
    log(f"Original backup: {archive_plan.output}")
    log("Queued encode output(s):")
    for job in jobs:
        selection = f"title {job.title_number}" if job.title_number is not None else "HandBrake main feature"
        log(f"  {selection}: {job.output}")

    existing_verified, code = validate_archive_identity(archive_plan, scan)
    if code != 0:
        return code
    if not dry_run and not existing_verified:
        try:
            write_queue_metadata(
                archive_plan,
                metadata,
                jobs,
                scan=scan,
                archive_status="archiving",
            )
        except (OSError, ValueError) as exc:
            log_error(f"Could not save archive recovery metadata: {exc}")
            return 1
    code = execute_archive_plan(
        archive_plan,
        dry_run=dry_run,
        verbose=verbose,
        existing_verified=existing_verified,
    )
    if code != 0:
        return code
    if dry_run:
        return 0

    try:
        write_queue_metadata(archive_plan, metadata, jobs, scan=scan)
    except (OSError, ValueError) as exc:
        log_error(f"Could not save encode queue metadata: {exc}")
        log_error(f"The original backup was kept unchanged at: {archive_plan.output}")
        return 1
    log("Disc archive complete. Encoding was queued but not started.")
    log(f"Run 'rip-dvd encode --originals-library {originals_library}' to process pending encodes.")
    return 0


def encode_mode(originals_library, dry_run=False, verbose=False, watch=False, interval=300, limit=None, idle=True):
    if idle:
        try:
            os.nice(10)
        except OSError:
            pass

    processed = 0
    while True:
        if limit is not None and processed >= limit:
            return 0
        jobs = discover_encode_jobs(originals_library)
        if limit is not None:
            jobs = jobs[: max(0, limit - processed)]

        if not jobs:
            if watch:
                log(f"No pending encodes. Checking again in {interval}s.")
                time.sleep(interval)
                continue
            log("No pending encodes.")
            return 0

        labels = [job.label for job in jobs]
        progress = None
        if not dry_run and not verbose:
            progress = RipProgressDisplay(labels)
            progress.begin()

        batch_processed = 0
        for index, job in enumerate(jobs):
            log(f"Encoding from original backup: {job.source}")
            code = execute_encode_job(
                job,
                dry_run=dry_run,
                verbose=verbose,
                progress_display=progress,
                progress_index=index,
                idle=idle,
            )
            if code is None:
                continue
            if code != 0:
                return code
            processed += 1
            batch_processed += 1
            if limit is not None and processed >= limit:
                return 0

        if progress is not None:
            progress.finish()
            if batch_processed:
                log("Pending encodes complete.")

        if not watch:
            return 0
        if batch_processed == 0:
            log(f"Pending encodes are busy in another process. Checking again in {interval}s.")
            time.sleep(interval)


def queue_mode(originals_library):
    queue_root = Path(originals_library)
    if not queue_root.exists():
        log(f"No originals library found: {queue_root}")
        return 0

    metadata_paths = sorted(queue_root.rglob("*.rip-dvd.json"))
    if not metadata_paths:
        log(f"No queue metadata found under: {queue_root}")
        return 0

    pending = 0
    complete = 0
    missing_source = 0
    for metadata_path in metadata_paths:
        data = read_queue_metadata(metadata_path)
        if not data:
            continue
        source = Path(data.get("source") or metadata_path.with_suffix(".iso"))
        archive_status = data.get("archive_status", "ready")
        source_status = "source ok" if source.exists() else "source missing"
        if archive_status != "ready":
            source_status = f"archive {archive_status}"
        if not source.exists():
            missing_source += 1
        title = data.get("title") or source.stem
        year = f" ({data.get('year')})" if data.get("year") else ""
        log(f"{title}{year}: {source_status}")
        raw_jobs = data.get("jobs", [])
        if not isinstance(raw_jobs, list):
            log_error(f"Skipping invalid jobs list in {metadata_path}")
            continue
        for raw_job in raw_jobs:
            if not isinstance(raw_job, dict):
                log_error(f"Skipping invalid encode job in {metadata_path}")
                continue
            raw_output = raw_job.get("output")
            if not raw_output:
                log_error(f"Skipping invalid encode job in {metadata_path}")
                continue
            output = Path(raw_output)
            if output.exists():
                status = "done"
                complete += 1
            else:
                status = "pending"
                pending += 1
            label = raw_job.get("label") or output.stem
            raw_title_number = raw_job.get("title_number")
            selection = f"title {raw_title_number}" if raw_title_number is not None else "HandBrake main feature"
            log(f"  [{status}] {selection}: {label}")
            log(f"          {output}")

    log(f"Queue summary: {pending} pending, {complete} done, {missing_source} missing source backups.")
    return 0


def extras_mode(device, library, originals_library, preset, extra_title_numbers, name=None, year=None, dry_run=False, verbose=False):
    if not Path(device).exists():
        log_error(f"DVD device not found: {device}")
        return 2
    if not extra_title_numbers:
        log_error("extras requires at least one bonus title number, for example: rip-dvd extras --extras 2,3,4")
        return 2

    log("Scanning disc to validate selected bonus titles...")
    scan = scan_dvd_titles(device)
    if scan.returncode != 0 and not scan.titles:
        log_error("Could not scan DVD titles.")
        if scan.raw_output:
            log_error("Recent scanner output:")
            for line in scan.raw_output.splitlines()[-20:]:
                log_error(line)
        return scan.returncode or 1

    available = {title.number for title in scan.titles}
    missing = [number for number in extra_title_numbers if number not in available]
    if missing:
        log_error(f"Title number(s) not found in scan: {', '.join(str(number) for number in missing)}")
        print_title_summary(scan)
        return 2

    return archive_mode(
        device,
        library,
        originals_library,
        preset,
        command="rip",
        extra_title_numbers=extra_title_numbers,
        name=name,
        year=year,
        dry_run=dry_run,
        verbose=verbose,
        scan=scan,
    )


def interactive_mode(device, library, originals_library, preset, verbose=False):
    if not sys.stdin.isatty():
        log_error("Interactive mode requires a terminal. Use 'rip-dvd rip', 'rip-dvd scan', 'rip-dvd title <number>', or 'rip-dvd extras --extras 2,3' for non-interactive use.")
        return 2
    if not Path(device).exists():
        log_error(f"DVD device not found: {device}")
        return 2

    log("DVD rip assistant")
    log(f"Device: {device}")
    log(f"Library: {library}")
    log(f"Original backups: {originals_library}")
    log("Scanning disc so you can choose how to proceed...")
    scan = scan_dvd_titles(device)
    if scan.returncode != 0 and not scan.titles:
        log_error("Could not scan DVD titles.")
        if scan.raw_output:
            log_error("Recent scanner output:")
            for line in scan.raw_output.splitlines()[-20:]:
                log_error(line)
        return scan.returncode or 1

    print_title_summary(scan)

    print()
    print("What do you want to do?")
    print("  1. Rip the main feature automatically")
    print("  2. Rip the main feature plus selected bonus titles")
    print("  3. Rip a specific DVD title")
    print("  4. Scan only and exit")
    print("  5. Quit")

    while True:
        choice = prompt("Choose", default="1")
        if choice in {"1", "2", "3", "4", "5"}:
            break
        print("Choose 1, 2, 3, 4, or 5.")

    if choice == "4":
        log("Scan complete. No rip started.")
        return 0
    if choice == "5":
        log("No rip started.")
        return 0

    selected_title_number = None
    extra_title_numbers = []
    command = "rip"
    if choice == "2":
        suggestions = suggested_extra_titles(scan)
        default_extras = ",".join(str(title.number) for title in suggestions)
        if suggestions:
            log("Suggested bonus titles:")
            for title in suggestions:
                log(f"[{title.number:02d}] {format_duration(title.seconds)}  {classify_title(title.seconds)}")
        else:
            log("No obvious bonus titles were found. You can still enter title numbers from the scan.")

        available = {title.number for title in scan.titles}
        while True:
            raw = prompt("Bonus title numbers to rip, comma-separated; press Enter for suggested list or type none", default=default_extras)
            try:
                extra_title_numbers = parse_title_numbers(raw)
            except ValueError as exc:
                print(str(exc))
                continue
            missing = [number for number in extra_title_numbers if number not in available]
            if not missing:
                break
            print(f"Title number(s) not found in scan: {', '.join(str(number) for number in missing)}")
    elif choice == "3":
        available = {title.number for title in scan.titles}
        while True:
            raw = prompt("DVD title number to rip")
            try:
                selected_title_number = int(raw)
            except ValueError:
                print("Enter a numeric title number.")
                continue
            if selected_title_number in available:
                break
            print(f"Title {selected_title_number} was not found in the scan.")
        command = "title"

    name = prompt("Movie/title name override; leave blank to auto-detect")
    year = prompt("Year override; leave blank to auto-detect")
    dry_run = prompt_yes_no("Preview archive and queue only; do not rip", default=False)

    extra_names = {}
    if extra_title_numbers:
        for index, number in enumerate(extra_title_numbers, start=1):
            title_info = find_title(scan, number)
            default_name = default_extra_name(number, title_info=title_info, sequence=index)
            extra_name = prompt(f"Name for bonus title {number}; press Enter for suggested name", default=default_name)
            extra_names[number] = extra_name

    return archive_mode(
        device,
        library,
        originals_library,
        preset,
        command=command,
        selected_title_number=selected_title_number,
        extra_title_numbers=extra_title_numbers,
        name=name or None,
        year=year or None,
        dry_run=dry_run,
        verbose=verbose,
        scan=scan,
        extra_names=extra_names,
    )


def probe_media(path):
    probe = ffmpeg_tool("ffprobe")
    from .external import run

    return run(
        [
            probe,
            "-hide_banner",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size",
            "-of",
            "default=nw=1",
            str(path),
        ],
        timeout=60,
    )


def join_mode(parts, output, delete_parts=False, verbose=False):
    if len(parts) < 2:
        log_error("join requires at least two part files.")
        return 2
    if not output:
        log_error("join requires --output.")
        return 2

    part_paths = [Path(part).expanduser().resolve() for part in parts]
    missing = [str(path) for path in part_paths if not path.exists()]
    if missing:
        log_error("Missing part file(s):")
        for path in missing:
            log_error(f"  {path}")
        return 2

    output_path = Path(output).expanduser().resolve()
    if output_path.exists():
        log_error(f"Output already exists: {output_path}")
        log_error("Move it or choose a different --output path.")
        return 2

    output_path.parent.mkdir(parents=True, exist_ok=True)
    concat_list = output_path.with_suffix(output_path.suffix + ".concat.txt")
    concat_list.write_text("".join(f"file '{concat_escape(path)}'\n" for path in part_paths))

    cmd = [
        ffmpeg_tool("ffmpeg"),
        "-hide_banner",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_list),
        "-c",
        "copy",
        str(output_path),
    ]

    log("Joining part files without re-encoding...")
    for index, path in enumerate(part_paths, start=1):
        log(f"Part {index}: {path}")
    log(f"Output: {output_path}")
    if verbose:
        log("Command:")
        log(quote_cmd(cmd))

    proc = subprocess.run(cmd, text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        concat_list.unlink()
    except OSError:
        pass

    if proc.returncode != 0:
        log_error(f"ffmpeg concat failed with exit code {proc.returncode}.")
        log_error("Recent ffmpeg output:")
        for line in proc.stdout.splitlines()[-30:]:
            log_error(line)
        if output_path.exists():
            failed_path = output_path.with_suffix(output_path.suffix + ".failed")
            output_path.rename(failed_path)
            log_error(f"Partial output moved to: {failed_path}")
        log_error("The parts were not deleted.")
        return proc.returncode

    log("Join complete.")
    probe = probe_media(output_path)
    if probe.returncode == 0 and probe.stdout.strip():
        for line in probe.stdout.strip().splitlines():
            log(f"Joined file {line}")
    else:
        log("Joined file created, but ffprobe could not verify duration/size.")

    if delete_parts:
        log("--delete-parts was provided; deleting original part files.")
        for path in part_paths:
            path.unlink()
            log(f"Deleted: {path}")
    else:
        log("Original part files were left in place. Use --delete-parts to remove them after joining.")

    return 0


def stream_handbrake(cmd, output, verbose=False, progress_display=None, progress_index=0):
    if verbose:
        progress_display = None

    if verbose:
        log("Running HandBrake in verbose mode:")
        log(quote_cmd(cmd))
    elif progress_display is None:
        log("Scanning DVD and starting encoder...")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=0,
        universal_newlines=True,
    )

    recent = deque(maxlen=30)
    buffer = ""
    last_scan_percent = None
    last_preview_percent = None
    last_rip_percent = None
    scan_eta = EtaTracker()
    preview_eta = EtaTracker()
    rip_eta = EtaTracker()
    saw_progress = False

    while True:
        char = proc.stdout.read(1) if proc.stdout else ""
        if char == "" and proc.poll() is not None:
            break
        if char == "":
            continue

        if verbose:
            sys.stdout.write(char)
            sys.stdout.flush()

        buffer += char
        if char not in {"\r", "\n"}:
            continue

        segment = buffer.strip()
        buffer = ""
        if not segment:
            continue

        recent.append(segment)
        progress = parse_handbrake_progress(segment)
        if progress is None:
            continue

        percent = int(progress.percent_value)
        if progress.phase == "rip":
            if percent != last_rip_percent:
                eta = format_duration(progress.eta_seconds) if progress.eta_seconds is not None else rip_eta.estimate(progress.percent_value)
                if progress_display is not None:
                    progress_display.update(progress_index, percent, "ripping", f"ETA {eta}")
                else:
                    log(f"Ripping: {percent}% (ETA {eta})")
                last_rip_percent = percent
                saw_progress = True
            continue

        if progress.phase == "scan":
            if percent != last_scan_percent:
                eta = scan_eta.estimate(progress.percent_value)
                if progress_display is not None:
                    progress_display.update(progress_index, percent, "scanning", f"ETA about {eta}")
                else:
                    log(f"Scanning titles: {percent}% (ETA about {eta})")
                last_scan_percent = percent
            continue

        if progress.phase == "preview":
            if percent != last_preview_percent:
                eta = preview_eta.estimate(progress.percent_value)
                if progress_display is not None:
                    progress_display.update(progress_index, percent, "previews", f"ETA about {eta}")
                else:
                    log(f"Scanning previews: {percent}% (ETA about {eta})")
                last_preview_percent = percent
            continue

    if buffer.strip():
        recent.append(buffer.strip())

    return_code = proc.wait()
    if return_code == 0:
        if not verbose and saw_progress and last_rip_percent != 100:
            if progress_display is not None:
                progress_display.update(progress_index, 100, "done")
            else:
                log("Ripping: 100%")
        elif progress_display is not None:
            progress_display.update(progress_index, 100, "done")
        if progress_display is None:
            log(f"Done: {output}")
        return 0

    if progress_display is not None:
        progress_display.update(progress_index, max(last_rip_percent or last_preview_percent or last_scan_percent or 0, 0), "failed")
        progress_display.finish()
    log_error(f"HandBrake failed with exit code {return_code}.")
    if output.exists():
        failed_path = failed_output_path(output)
        output.rename(failed_path)
        log_error(f"Partial output moved to: {failed_path}")
    if not verbose:
        log_error("Recent HandBrake output:")
        for line in recent:
            log_error(line)
        log_error("Run again with --verbose for full HandBrake output.")
    return return_code


def main():
    parser = argparse.ArgumentParser(description="Archive DVDs first, then encode queued titles into the Jellyfin Movies folder.")
    parser.add_argument(
        "command",
        nargs="?",
        choices=["interactive", "rip", "scan", "title", "extras", "queue", "encode", "join"],
        default="interactive",
        help=(
            "Command to run. Default: interactive. Use 'rip' for the main feature, 'scan' to list DVD titles, "
            "'title <number>' to rip a specific title, 'extras --extras 2,3' to rip the main feature plus bonus titles, "
            "'queue' to inspect archive/encode state, 'encode' to process pending encodes, or 'join' to combine part files."
        ),
    )
    parser.add_argument("title_number", nargs="?", help="DVD title number to rip when using 'title', or first bonus title when using 'extras'.")
    parser.add_argument("parts", nargs="*", help="Part files to join when using the 'join' command.")
    parser.add_argument("--device", default=DEFAULT_DEVICE, help=f"DVD device, default {DEFAULT_DEVICE}")
    parser.add_argument("--library", default=DEFAULT_LIBRARY, help=f"Movie library root, default {DEFAULT_LIBRARY}")
    parser.add_argument("--originals-library", default=DEFAULT_ORIGINALS_LIBRARY, help=f"Original DVD backup root, default {DEFAULT_ORIGINALS_LIBRARY!r}")
    parser.add_argument("--name", help="Override movie title")
    parser.add_argument("--year", help="Override release year")
    parser.add_argument("--extras", help="Comma-separated bonus title numbers for the 'extras' command, for example: 2,3,4")
    parser.add_argument("--output", help="Output file for the 'join' command")
    parser.add_argument("--delete-parts", action="store_true", help="After a successful join, delete the original part files")
    parser.add_argument("--preset", default=DEFAULT_PRESET, help=f"HandBrake preset, default {DEFAULT_PRESET!r}")
    parser.add_argument("--dry-run", action="store_true", help="Show detected metadata and command without ripping")
    parser.add_argument("--watch", action="store_true", help="With 'encode', keep watching for new pending encode jobs")
    parser.add_argument("--interval", type=int, default=300, help="Seconds between queue checks when using 'encode --watch'")
    parser.add_argument("--limit", type=int, help="With 'encode', process at most this many pending jobs")
    parser.add_argument("--normal-priority", action="store_true", help="With 'encode', do not lower CPU/I/O priority")
    parser.add_argument("--verbose", "--debug", action="store_true", help="Print full raw HandBrake output for debugging")
    args = parser.parse_args()

    if args.command == "interactive":
        return interactive_mode(args.device, args.library, args.originals_library, args.preset, verbose=args.verbose)

    if args.command == "scan":
        return scan_mode(args.device)

    if args.command == "queue":
        return queue_mode(args.originals_library)

    if args.command == "encode":
        return encode_mode(
            args.originals_library,
            dry_run=args.dry_run,
            verbose=args.verbose,
            watch=args.watch,
            interval=args.interval,
            limit=args.limit,
            idle=not args.normal_priority,
        )

    if args.command == "join":
        if args.title_number is not None:
            args.parts.insert(0, args.title_number)
        return join_mode(args.parts, args.output, delete_parts=args.delete_parts, verbose=args.verbose)

    if args.command == "extras":
        raw_extra_values = []
        if args.extras:
            raw_extra_values.append(args.extras)
        if args.title_number:
            raw_extra_values.append(args.title_number)
        raw_extra_values.extend(args.parts)
        try:
            extra_title_numbers = parse_title_numbers(",".join(raw_extra_values))
        except ValueError as exc:
            parser.error(str(exc))
        return extras_mode(
            args.device,
            args.library,
            args.originals_library,
            args.preset,
            extra_title_numbers,
            name=args.name,
            year=args.year,
            dry_run=args.dry_run,
            verbose=args.verbose,
        )

    if args.command == "title" and args.title_number is None:
        parser.error("the 'title' command requires a title number, for example: rip-dvd title 3")
    if args.command == "title":
        try:
            selected_title_number = int(args.title_number)
        except ValueError:
            parser.error("the 'title' command requires a numeric title number, for example: rip-dvd title 3")
    else:
        selected_title_number = None

    return archive_mode(
        args.device,
        args.library,
        args.originals_library,
        args.preset,
        command=args.command,
        selected_title_number=selected_title_number,
        name=args.name,
        year=args.year,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )
