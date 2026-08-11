import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from rip_dvd.legacy_queue_lease import (
    CUTOVER_INTENT_LOCK,
    QUEUE_GATE_LOCK,
    _scavenge_orphan,
    legacy_queue_command_lease,
)


class LegacyQueueLeaseTests(unittest.TestCase):
    def protocol_manifest(self, version=1, ready_sentinel="ready"):
        protocol_path = (
            Path(__file__).resolve().parents[1]
            / "rip_dvd"
            / "legacy_queue_cutover_protocol.json"
        )
        protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
        protocol["version"] = version
        protocol["sentinels"]["ready"] = ready_sentinel
        return json.dumps(
            protocol,
            separators=(",", ":"),
        )

    def test_cutover_helper_consumes_the_authoritative_protocol_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state_root = root / "state"
            state_root.mkdir()
            child = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "rip_dvd.legacy_queue_lease",
                    "hold-cutover",
                    str(root),
                    str(state_root),
                    "--protocol",
                    self.protocol_manifest(),
                ],
                stdin=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 2
                while (
                    not (state_root / "ready").exists()
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.01)
                self.assertTrue((state_root / "intent-ready").exists())
                self.assertTrue((state_root / "ready").exists())
                self.assertIsNotNone(child.stdin)
                child.stdin.close()
                child.wait(timeout=2)
                self.assertEqual(child.returncode, 0)
                self.assertTrue((state_root / "released").exists())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=1)
                if child.stdin is not None and not child.stdin.closed:
                    child.stdin.close()
                if child.stderr is not None:
                    child.stderr.close()

    def test_cutover_helper_rejects_an_incompatible_protocol_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state_root = root / "state"
            state_root.mkdir()

            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "rip_dvd.legacy_queue_lease",
                    "hold-cutover",
                    str(root),
                    str(state_root),
                    "--protocol",
                    self.protocol_manifest(version=2),
                ],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unsupported legacy queue cutover protocol", result.stderr)

    def test_cutover_helper_rejects_protocol_drift_at_the_python_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state_root = root / "state"
            state_root.mkdir()

            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "rip_dvd.legacy_queue_lease",
                    "hold-cutover",
                    str(root),
                    str(state_root),
                    "--protocol",
                    self.protocol_manifest(ready_sentinel="renamed-ready"),
                ],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not match the authoritative contract", result.stderr)

    def test_kernel_releases_a_crashed_command_lease(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            child = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    """import fcntl, pathlib, sys, time
root = pathlib.Path(sys.argv[1])
intent = (root / sys.argv[2]).open("a+")
gate = (root / sys.argv[3]).open("a+")
fcntl.flock(intent, fcntl.LOCK_EX)
fcntl.flock(gate, fcntl.LOCK_SH)
fcntl.flock(intent, fcntl.LOCK_UN)
print("ready", flush=True)
time.sleep(60)
""",
                    str(root),
                    CUTOVER_INTENT_LOCK,
                    QUEUE_GATE_LOCK,
                ],
                stdout=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertIsNotNone(child.stdout)
                self.assertEqual(child.stdout.readline().strip(), "ready")
                child.kill()
                child.wait(timeout=1)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=1)
                if child.stdout is not None:
                    child.stdout.close()

            intent = (root / CUTOVER_INTENT_LOCK).open("r+")
            gate = (root / QUEUE_GATE_LOCK).open("r+")
            try:
                fcntl.flock(intent, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                gate.close()
                intent.close()

    def test_kernel_lease_ignores_cross_namespace_pid_collision_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            gate_path = root / QUEUE_GATE_LOCK
            gate_path.write_text(
                json.dumps({"schemaVersion": 1, "pid": os.getpid()}),
                encoding="utf-8",
            )

            with legacy_queue_command_lease(root):
                contender = gate_path.open("r+")
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(
                            contender,
                            fcntl.LOCK_EX | fcntl.LOCK_NB,
                        )
                finally:
                    contender.close()

    def test_coordination_inodes_are_stable_across_lease_recovery(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with legacy_queue_command_lease(root):
                initial = {
                    name: (root / name).stat().st_ino
                    for name in (CUTOVER_INTENT_LOCK, QUEUE_GATE_LOCK)
                }

            with legacy_queue_command_lease(root):
                recovered = {
                    name: (root / name).stat().st_ino
                    for name in (CUTOVER_INTENT_LOCK, QUEUE_GATE_LOCK)
                }

            self.assertEqual(recovered, initial)

    def test_orphan_scavenging_does_not_unlink_an_aba_successor(self):
        with tempfile.TemporaryDirectory() as temp:
            owner_path = Path(temp) / ".rip-dvd-legacy-queue.shared.orphan"
            owner_path.write_text("original", encoding="utf-8")
            original_lstat = Path.lstat

            def replace_before_validation(path):
                path.unlink()
                path.write_text("successor", encoding="utf-8")
                return original_lstat(path)

            with patch.object(Path, "lstat", replace_before_validation):
                _scavenge_orphan(owner_path)

            self.assertEqual(owner_path.read_text(encoding="utf-8"), "successor")


if __name__ == "__main__":
    unittest.main()
