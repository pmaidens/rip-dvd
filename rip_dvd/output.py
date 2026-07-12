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

