import argparse
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import select
import stat
import sys


CUTOVER_INTENT_LOCK = ".rip-dvd-legacy-queue.intent.lock"
QUEUE_GATE_LOCK = ".rip-dvd-legacy-queue.lock"
ORPHAN_PATTERNS = (
    ".rip-dvd-legacy-queue.lock.*.owner",
    ".rip-dvd-legacy-queue.owner.*.tmp",
    ".rip-dvd-legacy-queue.shared.*",
)


def _open_lock(path):
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise OSError(f"Legacy queue lock is not a regular file: {path}")
    return descriptor


@contextmanager
def legacy_queue_command_lease(originals_library):
    queue_root = Path(originals_library)
    queue_root.mkdir(parents=True, exist_ok=True)
    intent_descriptor = _open_lock(queue_root / CUTOVER_INTENT_LOCK)
    gate_descriptor = _open_lock(queue_root / QUEUE_GATE_LOCK)
    try:
        # Every entrant passes through the intent lock exclusively, so a queued
        # cutover cannot be bypassed by a stream of new shared gate holders.
        fcntl.flock(intent_descriptor, fcntl.LOCK_EX)
        try:
            fcntl.flock(gate_descriptor, fcntl.LOCK_SH)
        finally:
            fcntl.flock(intent_descriptor, fcntl.LOCK_UN)
        try:
            yield
        finally:
            fcntl.flock(gate_descriptor, fcntl.LOCK_UN)
    finally:
        os.close(gate_descriptor)
        os.close(intent_descriptor)


def _write_state(state_directory, name, contents=""):
    path = state_directory / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        if contents:
            os.write(descriptor, contents.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _scavenge_orphan(path):
    try:
        descriptor = _open_lock(path)
    except (FileNotFoundError, OSError):
        return
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        inspected = os.fstat(descriptor)
        try:
            current = path.lstat()
        except FileNotFoundError:
            return
        if (inspected.st_dev, inspected.st_ino) == (current.st_dev, current.st_ino):
            path.unlink()
    finally:
        os.close(descriptor)


def _scavenge_owner_artifacts(queue_root):
    for pattern in ORPHAN_PATTERNS:
        for path in queue_root.glob(pattern):
            _scavenge_orphan(path)


def hold_cutover(originals_library, state_directory):
    queue_root = Path(originals_library)
    state_root = Path(state_directory)
    queue_root.mkdir(parents=True, exist_ok=True)
    intent_descriptor = _open_lock(queue_root / CUTOVER_INTENT_LOCK)
    gate_descriptor = _open_lock(queue_root / QUEUE_GATE_LOCK)
    try:
        fcntl.flock(intent_descriptor, fcntl.LOCK_EX)
        _write_state(state_root, "intent-ready")
        fcntl.flock(gate_descriptor, fcntl.LOCK_EX)
        _scavenge_owner_artifacts(queue_root)
        _write_state(state_root, "ready")
        while not (state_root / "release").exists():
            readable, _, _ = select.select([sys.stdin], [], [], 0.05)
            if readable and not sys.stdin.buffer.read(1):
                break
        fcntl.flock(gate_descriptor, fcntl.LOCK_UN)
        fcntl.flock(intent_descriptor, fcntl.LOCK_UN)
        _write_state(state_root, "released")
    except BaseException as error:
        try:
            _write_state(state_root, "error", str(error))
        except OSError:
            pass
        raise
    finally:
        os.close(gate_descriptor)
        os.close(intent_descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("hold-cutover",))
    parser.add_argument("originals_library")
    parser.add_argument("state_directory")
    arguments = parser.parse_args(argv)
    if arguments.command == "hold-cutover":
        hold_cutover(arguments.originals_library, arguments.state_directory)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
