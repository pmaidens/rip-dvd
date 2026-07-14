import datetime as dt
import sys


try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except AttributeError:
    pass


def timestamp():
    return dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")


def log(message, stream=sys.stdout):
    print(f"[{timestamp()}] {message}", file=stream)


def log_error(message):
    log(message, stream=sys.stderr)


def clamp_percent(value):
    return max(0, min(100, int(value)))


def truncate(value, width):
    if len(value) <= width:
        return value
    if width <= 3:
        return value[:width]
    return value[: width - 3] + "..."


def progress_bar(percent, width=24):
    percent = clamp_percent(percent)
    filled = round(width * (percent / 100))
    return "[" + ("#" * filled) + ("-" * (width - filled)) + "]"


class RipProgressDisplay:
    def __init__(self, labels, stream=sys.stdout, enabled=None, bar_width=24, label_width=34):
        self.labels = list(labels)
        self.stream = stream
        self.enabled = stream.isatty() if enabled is None else enabled
        self.bar_width = bar_width
        self.label_width = label_width
        self.rows = [
            {
                "label": label,
                "percent": 0,
                "status": "waiting",
                "detail": "",
            }
            for label in self.labels
        ]
        self.started = False

    def begin(self):
        if self.started or not self.rows:
            return
        self.started = True
        self.stream.write("Rip queue:\n")
        for row in self.rows:
            self.stream.write(self.format_row(row) + "\n")
        self.stream.flush()

    def update(self, index, percent, status, detail=""):
        if not self.started:
            self.begin()
        if not (0 <= index < len(self.rows)):
            return
        self.rows[index].update(
            {
                "percent": clamp_percent(percent),
                "status": status,
                "detail": detail,
            }
        )
        if self.enabled:
            self.redraw()

    def redraw(self):
        self.stream.write(f"\x1b[{len(self.rows)}A")
        for row in self.rows:
            self.stream.write("\r\x1b[2K" + self.format_row(row) + "\n")
        self.stream.flush()

    def finish(self):
        if not self.started:
            return
        if self.enabled:
            self.stream.flush()
            return
        self.stream.write("Rip results:\n")
        for row in self.rows:
            self.stream.write(self.format_row(row) + "\n")
        self.stream.flush()

    def format_row(self, row):
        label = truncate(row["label"], self.label_width).ljust(self.label_width)
        detail = f" {row['detail']}" if row["detail"] else ""
        return f"  {label} {progress_bar(row['percent'], self.bar_width)} {row['percent']:3d}% {row['status']}{detail}"


def prompt(message, default=None):
    suffix = f" [{default}]" if default else ""
    value = input(f"{message}{suffix}: ").strip()
    return value or default or ""


def prompt_yes_no(message, default=False):
    default_text = "Y/n" if default else "y/N"
    while True:
        value = input(f"{message} [{default_text}]: ").strip().lower()
        if not value:
            return default
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        print("Please answer y or n.")
