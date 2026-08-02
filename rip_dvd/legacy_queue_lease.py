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


def _acquire_exclusive_or_abort(descriptor, state_root, abort_sentinel):
    while not (state_root / abort_sentinel).exists():
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            select.select([], [], [], 0.05)
    return False


def _validate_protocol(raw_protocol):
    fields = raw_protocol.split("|")
    if not fields or fields[0] != "1":
        raise ValueError("Unsupported legacy queue cutover protocol version")
    sentinels = {}
    for field in fields[1:]:
        name, separator, value = field.partition("=")
        if not separator or name in sentinels:
            raise ValueError("Malformed legacy queue cutover protocol manifest")
        sentinels[name] = value
    if (
        set(sentinels) != {
            "abort",
            "error",
            "intentReady",
            "ready",
            "release",
            "released",
            "workerError",
        }
        or not all(value and Path(value).name == value for value in sentinels.values())
        or len(set(sentinels.values())) != len(sentinels)
    ):
        raise ValueError("Malformed legacy queue cutover protocol manifest")
    return sentinels


def hold_cutover(originals_library, state_directory, sentinels):
    queue_root = Path(originals_library)
    state_root = Path(state_directory)
    queue_root.mkdir(parents=True, exist_ok=True)
    intent_descriptor = _open_lock(queue_root / CUTOVER_INTENT_LOCK)
    gate_descriptor = _open_lock(queue_root / QUEUE_GATE_LOCK)
    intent_acquired = False
    gate_acquired = False
    try:
        intent_acquired = _acquire_exclusive_or_abort(
            intent_descriptor,
            state_root,
            sentinels["abort"],
        )
        if not intent_acquired:
            return
        _write_state(state_root, sentinels["intentReady"])
        gate_acquired = _acquire_exclusive_or_abort(
            gate_descriptor,
            state_root,
            sentinels["abort"],
        )
        if not gate_acquired:
            return
        _scavenge_owner_artifacts(queue_root)
        _write_state(state_root, sentinels["ready"])
        while not (state_root / sentinels["release"]).exists():
            readable, _, _ = select.select([sys.stdin], [], [], 0.05)
            if readable and not sys.stdin.buffer.read(1):
                break
    except BaseException as error:
        try:
            _write_state(state_root, sentinels["error"], str(error))
        except OSError:
            pass
        raise
    finally:
        if gate_acquired:
            fcntl.flock(gate_descriptor, fcntl.LOCK_UN)
        if intent_acquired:
            fcntl.flock(intent_descriptor, fcntl.LOCK_UN)
        os.close(gate_descriptor)
        os.close(intent_descriptor)
        try:
            _write_state(state_root, sentinels["released"])
        except FileExistsError:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("hold-cutover",))
    parser.add_argument("originals_library")
    parser.add_argument("state_directory")
    parser.add_argument("--protocol", required=True)
    arguments = parser.parse_args(argv)
    if arguments.command == "hold-cutover":
        hold_cutover(
            arguments.originals_library,
            arguments.state_directory,
            _validate_protocol(arguments.protocol),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
