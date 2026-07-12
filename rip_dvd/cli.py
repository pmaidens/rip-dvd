import argparse
from collections import deque
import os
from pathlib import Path
import subprocess
import sys
import time

from .core import (
    build_extra_plan as build_extra_plan_core,
    build_rip_plan as build_rip_plan_core,
    classify_title,
    concat_escape,
    default_extra_name,
    find_title,
    format_duration,
    parse_handbrake_progress,
    parse_title_numbers,
    pretty_from_label,
    quote_cmd,
    suggested_extra_titles,
)
from .external import ffmpeg_tool, resolve_movie_metadata, scan_dvd_titles
from .output import log, log_error, prompt, prompt_yes_no


DEFAULT_PRESET = "Fast 480p30"
DEFAULT_DEVICE = "/dev/sr0"
DEFAULT_LIBRARY = "/srv/media/Movies"


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


def execute_rip_plan(plan, dry_run=False, verbose=False):
    if dry_run or verbose:
        log("Command:")
        log(quote_cmd(plan.cmd))
    if dry_run:
        return 0

    plan.movie_dir.mkdir(parents=True, exist_ok=True)
    return stream_handbrake(plan.cmd, plan.output, verbose=verbose)


def execute_rip_plans(plans, dry_run=False, verbose=False):
    for index, plan in enumerate(plans, start=1):
        log(f"Rip {index} of {len(plans)}")
        code = execute_rip_plan(plan, dry_run=dry_run, verbose=verbose)
        if code != 0:
            if index < len(plans):
                log_error("Stopping remaining rips because this rip failed.")
            return code
    return 0


def extras_mode(device, library, preset, extra_title_numbers, name=None, year=None, dry_run=False, verbose=False):
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

    plan, code = build_rip_plan(
        device,
        library,
        preset,
        command="rip",
        name=name,
        year=year,
        verbose=verbose,
    )
    if code != 0:
        return code

    plans = [plan]
    for index, number in enumerate(extra_title_numbers, start=1):
        plans.append(
            build_extra_plan(
                device,
                preset,
                plan.movie_dir,
                number,
                title_info=find_title(scan, number),
                sequence=index,
            )
        )

    return execute_rip_plans(plans, dry_run=dry_run, verbose=verbose)


def interactive_mode(device, library, preset, verbose=False):
    if not sys.stdin.isatty():
        log_error("Interactive mode requires a terminal. Use 'rip-dvd rip', 'rip-dvd scan', 'rip-dvd title <number>', or 'rip-dvd extras --extras 2,3' for non-interactive use.")
        return 2
    if not Path(device).exists():
        log_error(f"DVD device not found: {device}")
        return 2

    log("DVD rip assistant")
    log(f"Device: {device}")
    log(f"Library: {library}")
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
    dry_run = prompt_yes_no("Preview command only; do not rip", default=False)

    plan, code = build_rip_plan(
        device,
        library,
        preset,
        command=command,
        selected_title_number=selected_title_number,
        name=name or None,
        year=year or None,
        verbose=verbose,
    )
    if code != 0:
        return code

    plans = [plan]
    if extra_title_numbers:
        for index, number in enumerate(extra_title_numbers, start=1):
            title_info = find_title(scan, number)
            default_name = default_extra_name(number, title_info=title_info, sequence=index)
            extra_name = prompt(f"Name for bonus title {number}; press Enter for suggested name", default=default_name)
            plans.append(
                build_extra_plan(
                    device,
                    preset,
                    plan.movie_dir,
                    number,
                    title_info=title_info,
                    extra_name=extra_name,
                    sequence=index,
                )
            )

    return execute_rip_plans(plans, dry_run=dry_run, verbose=verbose)


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


def stream_handbrake(cmd, output, verbose=False):
    if verbose:
        log("Running HandBrake in verbose mode:")
        log(quote_cmd(cmd))
    else:
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
                log(f"Ripping: {percent}% (ETA {eta})")
                last_rip_percent = percent
                saw_progress = True
            continue

        if progress.phase == "scan":
            if percent != last_scan_percent:
                log(f"Scanning titles: {percent}% (ETA about {scan_eta.estimate(progress.percent_value)})")
                last_scan_percent = percent
            continue

        if progress.phase == "preview":
            if percent != last_preview_percent:
                log(f"Scanning previews: {percent}% (ETA about {preview_eta.estimate(progress.percent_value)})")
                last_preview_percent = percent
            continue

    if buffer.strip():
        recent.append(buffer.strip())

    return_code = proc.wait()
    if return_code == 0:
        if not verbose and saw_progress and last_rip_percent != 100:
            log("Ripping: 100%")
        log(f"Done: {output}")
        return 0

    log_error(f"HandBrake failed with exit code {return_code}.")
    if not verbose:
        log_error("Recent HandBrake output:")
        for line in recent:
            log_error(line)
        log_error("Run again with --verbose for full HandBrake output.")
    return return_code


def main():
    parser = argparse.ArgumentParser(description="Rip DVD titles into the Jellyfin Movies folder.")
    parser.add_argument(
        "command",
        nargs="?",
        choices=["interactive", "rip", "scan", "title", "extras", "join"],
        default="interactive",
        help=(
            "Command to run. Default: interactive. Use 'rip' for the main feature, 'scan' to list DVD titles, "
            "'title <number>' to rip a specific title, 'extras --extras 2,3' to rip the main feature plus bonus titles, "
            "or 'join' to combine part files."
        ),
    )
    parser.add_argument("title_number", nargs="?", help="DVD title number to rip when using 'title', or first bonus title when using 'extras'.")
    parser.add_argument("parts", nargs="*", help="Part files to join when using the 'join' command.")
    parser.add_argument("--device", default=DEFAULT_DEVICE, help=f"DVD device, default {DEFAULT_DEVICE}")
    parser.add_argument("--library", default=DEFAULT_LIBRARY, help=f"Movie library root, default {DEFAULT_LIBRARY}")
    parser.add_argument("--name", help="Override movie title")
    parser.add_argument("--year", help="Override release year")
    parser.add_argument("--extras", help="Comma-separated bonus title numbers for the 'extras' command, for example: 2,3,4")
    parser.add_argument("--output", help="Output file for the 'join' command")
    parser.add_argument("--delete-parts", action="store_true", help="After a successful join, delete the original part files")
    parser.add_argument("--preset", default=DEFAULT_PRESET, help=f"HandBrake preset, default {DEFAULT_PRESET!r}")
    parser.add_argument("--dry-run", action="store_true", help="Show detected metadata and command without ripping")
    parser.add_argument("--verbose", "--debug", action="store_true", help="Print full raw HandBrake output for debugging")
    args = parser.parse_args()

    if args.command == "interactive":
        return interactive_mode(args.device, args.library, args.preset, verbose=args.verbose)

    if args.command == "scan":
        return scan_mode(args.device)

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

    plan, code = build_rip_plan(
        args.device,
        args.library,
        args.preset,
        command=args.command,
        selected_title_number=selected_title_number,
        name=args.name,
        year=args.year,
        verbose=args.verbose,
    )
    if code != 0:
        return code
    return execute_rip_plan(plan, dry_run=args.dry_run, verbose=args.verbose)
