from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
from typing import List, Optional


@dataclass(frozen=True)
class DvdTitle:
    number: int
    duration_text: str
    seconds: int
    chapters: int
    audio_streams: int
    subtitles: int


@dataclass(frozen=True)
class DvdScan:
    returncode: int
    disc_title: str
    titles: List[DvdTitle]
    raw_output: str


@dataclass(frozen=True)
class MovieMetadata:
    hint: str
    title: str
    year: str


@dataclass(frozen=True)
class RipPlan:
    cmd: List[str]
    output: Path
    movie_dir: Path


@dataclass(frozen=True)
class HandBrakeProgress:
    phase: str
    percent_value: float
    eta_seconds: Optional[int] = None


def quote_cmd(cmd):
    return " ".join(subprocess.list2cmdline([part]) for part in cmd)


def format_duration(seconds):
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def parse_duration(value):
    match = re.match(r"^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$", value.strip())
    if not match:
        return 0
    hours, minutes, seconds = (int(part) for part in match.groups())
    return (hours * 3600) + (minutes * 60) + seconds


def classify_title(seconds, feature_count=0):
    minutes = seconds / 60
    if minutes >= 60:
        if feature_count > 1:
            return "possible feature / double feature"
        return "likely main feature"
    if minutes >= 30:
        return "possible episode / long bonus"
    if minutes >= 15:
        return "possible bonus feature / mini-movie"
    if minutes >= 2:
        return "possible short / trailer / extra"
    return "likely menu / junk"


def sanitize_filename(value):
    value = re.sub(r"[\\/:*?\"<>|]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value or "DVD Rip"


def pretty_from_label(label):
    label = label.strip()
    label = re.sub(r"[_\.]+", " ", label)
    label = re.sub(r"\s+", " ", label).strip()
    if not label:
        return ""
    if label.isupper() or label.islower():
        small = {"a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"}
        words = []
        for i, word in enumerate(label.lower().split()):
            words.append(word if i and word in small else word.capitalize())
        return " ".join(words)
    return label


def parse_lsdvd_output(text, returncode=0):
    titles = []
    disc_title = ""

    for line in text.splitlines():
        disc_match = re.search(r"Disc Title:\s*(.+)", line, re.I)
        if disc_match:
            disc_title = disc_match.group(1).strip()
            continue

        title_match = re.search(
            r"Title:\s*(\d+),\s*Length:\s*([0-9:.]+)\s*Chapters:\s*(\d+).*?"
            r"Audio streams:\s*(\d+),\s*Subpictures:\s*(\d+)",
            line,
        )
        if not title_match:
            continue

        number, duration_text, chapters, audio_streams, subtitles = title_match.groups()
        titles.append(
            DvdTitle(
                number=int(number),
                duration_text=duration_text,
                seconds=parse_duration(duration_text),
                chapters=int(chapters),
                audio_streams=int(audio_streams),
                subtitles=int(subtitles),
            )
        )

    return DvdScan(
        returncode=returncode,
        disc_title=disc_title,
        titles=titles,
        raw_output=text.strip(),
    )


def find_title(scan, number):
    for title in scan.titles:
        if title.number == number:
            return title
    return None


def suggested_extra_titles(scan):
    titles = sorted(scan.titles, key=lambda item: item.number)
    return [title for title in titles if 120 <= title.seconds < 3600]


def parse_title_numbers(value):
    if not value:
        return []
    if value.strip().lower() in {"none", "no", "n", "-"}:
        return []

    numbers = []
    seen = set()
    for part in re.split(r"[\s,]+", value.strip()):
        if not part:
            continue
        if not re.fullmatch(r"\d+", part):
            raise ValueError(f"invalid title number: {part}")
        number = int(part)
        if number not in seen:
            numbers.append(number)
            seen.add(number)
    return numbers


def default_extra_name(title_number, title_info=None, sequence=None):
    index = sequence if sequence is not None else title_number
    seconds = title_info.seconds if title_info else 0
    chapters = title_info.chapters if title_info else 0

    if seconds >= 30 * 60:
        label = "Long Bonus"
    elif seconds >= 15 * 60:
        label = "Mini-Movie"
    elif seconds >= 5 * 60:
        label = "Bonus Feature"
    elif seconds >= 2 * 60:
        label = "Short Extra"
    else:
        label = "DVD Clip"

    details = []
    if seconds:
        details.append(format_duration(seconds))
    if chapters > 1:
        details.append(f"{chapters} chapters")

    suffix = f" - {', '.join(details)}" if details else ""
    return f"{label} {index:02d}{suffix}"


def build_rip_plan(device, library, preset, metadata, command="rip", selected_title_number=None):
    title = metadata.title
    resolved_year = metadata.year
    year_part = f" ({resolved_year})" if resolved_year else ""
    movie_dir = Path(library) / f"{title}{year_part}"
    output = movie_dir / f"{title}{year_part}.mkv"

    if command == "title":
        cmd = [
            "HandBrakeCLI",
            "--title",
            str(selected_title_number),
            "-i",
            device,
            "-o",
            str(output),
            "--preset",
            preset,
        ]
    else:
        cmd = ["HandBrakeCLI", "--main-feature", "-i", device, "-o", str(output), "--preset", preset]

    return RipPlan(cmd=cmd, output=output, movie_dir=movie_dir)


def build_extra_plan(device, preset, movie_dir, title_number, title_info=None, extra_name=None, sequence=None):
    default_name = default_extra_name(title_number, title_info=title_info, sequence=sequence)
    safe_name = sanitize_filename(extra_name or default_name)
    output = Path(movie_dir) / "extras" / f"{safe_name}.mkv"
    cmd = [
        "HandBrakeCLI",
        "--title",
        str(title_number),
        "-i",
        device,
        "-o",
        str(output),
        "--preset",
        preset,
    ]
    return RipPlan(cmd=cmd, output=output, movie_dir=output.parent)


def concat_escape(path):
    return str(path).replace("'", "'\\''")


def parse_handbrake_progress(segment):
    rip_match = re.search(r"Encoding:\s+task\s+\d+\s+of\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%", segment)
    if rip_match:
        eta_seconds = None
        handbrake_eta = re.search(r"ETA\s+([0-9]+)h([0-9]+)m([0-9]+)s", segment)
        if handbrake_eta:
            hours, minutes, seconds = (int(part) for part in handbrake_eta.groups())
            eta_seconds = (hours * 3600) + (minutes * 60) + seconds
        return HandBrakeProgress("rip", float(rip_match.group(1)), eta_seconds)

    scan_match = re.search(r"Scanning title\s+\d+\s+of\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%", segment)
    if scan_match:
        return HandBrakeProgress("scan", float(scan_match.group(1)))

    preview_match = re.search(
        r"Scanning title\s+\d+\s+of\s+\d+,\s+preview\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%",
        segment,
    )
    if preview_match:
        return HandBrakeProgress("preview", float(preview_match.group(1)))

    return None

