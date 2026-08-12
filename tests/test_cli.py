import json
import fcntl
import os
from pathlib import Path
from io import StringIO
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from rip_dvd.cli import (
    archive_mode,
    atomic_write_json,
    disc_fingerprint,
    discover_encode_jobs,
    encode_mode,
    execute_archive_plan,
    execute_encode_job,
    encode_lock_path,
    failed_output_path,
    main,
    partial_output_path,
    queue_mode,
    queue_job,
    validate_archive_identity,
    write_queue_metadata,
)
from rip_dvd.core import DiscArchivePlan, MovieMetadata, build_disc_archive_plan, parse_lsdvd_output


def sample_scan(disc_title="SAMPLE_MOVIE", main_seconds="01:35:11.000"):
    return parse_lsdvd_output(
        f"""
Disc Title: {disc_title}
Title: 01, Length: {main_seconds} Chapters: 12, Cells: 12, Audio streams: 2, Subpictures: 3
Title: 02, Length: 00:04:05.000 Chapters: 1, Cells: 1, Audio streams: 1, Subpictures: 0
""",
        returncode=0,
    )


class EncodeQueueDiscoveryTests(unittest.TestCase):
    def test_discover_encode_jobs_uses_sidecar_and_skips_completed_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "Originals" / "Film" / "Film.iso"
            pending_output = root / "Movies" / "Film" / "Film.mkv"
            completed_output = root / "Movies" / "Film" / "extras" / "Trailer.mkv"
            metadata_path = source.with_suffix(".rip-dvd.json")

            source.parent.mkdir(parents=True)
            source.write_bytes(b"iso")
            completed_output.parent.mkdir(parents=True)
            completed_output.write_bytes(b"done")
            partial_output_path(pending_output).write_bytes(b"interrupted")
            metadata_path.write_text(
                json.dumps(
                    {
                        "source": str(source),
                        "jobs": [
                            {
                                "label": "Movie: Film",
                                "output": str(pending_output),
                                "preset": "Fast 480p30",
                                "title_number": 1,
                            },
                            {
                                "label": "Extra 1: Trailer",
                                "output": str(completed_output),
                                "preset": "Fast 480p30",
                                "title_number": 2,
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            jobs = discover_encode_jobs(root / "Originals")

            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0].source, source)
            self.assertEqual(jobs[0].output, pending_output)
            self.assertEqual(jobs[0].title_number, 1)

    def test_discover_encode_jobs_skips_corrupted_sidecars(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            metadata_path = root / "Broken.rip-dvd.json"
            metadata_path.write_text("{not-json", encoding="utf-8")

            self.assertEqual(discover_encode_jobs(root), [])

    def test_discover_encode_jobs_skips_valid_json_with_invalid_shape(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            metadata_path = root / "Broken.rip-dvd.json"
            metadata_path.write_text("[]", encoding="utf-8")

            self.assertEqual(discover_encode_jobs(root), [])

    def test_sqlite_cutover_retires_the_legacy_encode_queue(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "Film.iso"
            output = root / "Film.mkv"
            source.write_bytes(b"iso")
            (root / "Film.rip-dvd.json").write_text(
                json.dumps(
                    {
                        "source": str(source),
                        "jobs": [
                            {
                                "label": "Movie: Film",
                                "output": str(output),
                                "selection": "main_feature",
                                "title_number": None,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (root / ".rip-dvd-sqlite-catalog").write_text("{}\n", encoding="utf-8")
            errors = []

            with patch("rip_dvd.cli.log_error", side_effect=errors.append):
                jobs = discover_encode_jobs(root)
                code = encode_mode(root, dry_run=True, idle=False)
                queue_code = queue_mode(root)

            self.assertEqual(jobs, [])
            self.assertEqual(code, 2)
            self.assertEqual(queue_code, 2)
            self.assertTrue(any("SQLite catalog" in message for message in errors))

    def test_sqlite_cutover_refuses_every_legacy_queue_command_without_touching_sidecars(self):
        command_arguments = (
            ["interactive"],
            ["rip"],
            ["title", "1"],
            ["extras", "--extras", "2"],
            ["queue"],
            ["encode", "--normal-priority"],
        )

        for arguments in command_arguments:
            with self.subTest(command=arguments[0]), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                originals = root / "Originals"
                originals.mkdir()
                existing_sidecar = originals / "Existing.rip-dvd.json"
                existing_sidecar.write_bytes(b'{"sentinel":true}\n')
                (originals / ".rip-dvd-sqlite-catalog").write_text(
                    "{}\n", encoding="utf-8"
                )
                sidecars_before = {
                    path.relative_to(originals): path.read_bytes()
                    for path in originals.rglob("*.rip-dvd.json")
                }
                errors = []
                argv = [
                    "rip-dvd",
                    *arguments,
                    "--device",
                    str(root / "missing-device"),
                    "--library",
                    str(root / "Movies"),
                    "--originals-library",
                    str(originals),
                ]

                with patch.object(sys, "argv", argv):
                    with patch("rip_dvd.cli.log_error", side_effect=errors.append):
                        with patch("rip_dvd.cli.scan_dvd_titles") as scan:
                            with patch("rip_dvd.cli.execute_archive_plan") as archive:
                                code = main()

                sidecars_after = {
                    path.relative_to(originals): path.read_bytes()
                    for path in originals.rglob("*.rip-dvd.json")
                }
                self.assertEqual(code, 2)
                self.assertTrue(any("SQLite catalog" in message for message in errors))
                self.assertEqual(sidecars_after, sidecars_before)
                scan.assert_not_called()
                archive.assert_not_called()

    def test_sqlite_cutover_still_allows_read_only_disc_scanning(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            originals = root / "Originals"
            device = root / "dvd-device"
            originals.mkdir()
            device.write_bytes(b"device")
            (originals / ".rip-dvd-sqlite-catalog").write_text(
                "{}\n", encoding="utf-8"
            )
            argv = [
                "rip-dvd",
                "scan",
                "--device",
                str(device),
                "--originals-library",
                str(originals),
            ]
            messages = []

            with patch.object(sys, "argv", argv):
                with patch("rip_dvd.cli.log", side_effect=messages.append):
                    with patch("rip_dvd.cli.scan_dvd_titles", return_value=sample_scan()) as scan:
                        code = main()

            self.assertEqual(code, 0)
            scan.assert_called_once_with(str(device))
            self.assertIn("Feature-length candidate", "\n".join(messages))
            self.assertIn("Short or extra candidate", "\n".join(messages))

    def test_failed_output_path_does_not_overwrite_existing_failed_file(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "Movie.mkv"
            output.with_suffix(".mkv.failed").write_bytes(b"old failure")

            self.assertEqual(failed_output_path(output), output.with_suffix(".mkv.failed.1"))


class LegacyQueueCutoverRaceTests(unittest.TestCase):
    def test_reused_live_pid_does_not_keep_a_crashed_lease_alive(self):
        with tempfile.TemporaryDirectory() as temp:
            originals = Path(temp)
            (originals / ".rip-dvd-legacy-queue.lock").write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "pid": os.getpid(),
                    "role": "cutover",
                }),
                encoding="utf-8",
            )

            self.assertEqual(encode_mode(originals, dry_run=True, idle=False), 0)

    def test_crashed_cutover_lease_is_reclaimed_before_and_after_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            originals = Path(temp)
            lock = originals / ".rip-dvd-legacy-queue.lock"
            lock.write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "pid": 999_999,
                    "role": "cutover",
                }),
                encoding="utf-8",
            )

            self.assertEqual(encode_mode(originals, dry_run=True, idle=False), 0)
            self.assertTrue(lock.exists())

            (originals / ".rip-dvd-sqlite-catalog").write_text(
                "{}\n", encoding="utf-8"
            )
            lock.write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "pid": 999_999,
                    "role": "cutover",
                }),
                encoding="utf-8",
            )
            self.assertEqual(encode_mode(originals, dry_run=True, idle=False), 2)
            self.assertTrue(lock.exists())

    def test_encode_watch_releases_its_lease_between_iterations(self):
        with tempfile.TemporaryDirectory() as temp:
            originals = Path(temp)
            lock = originals / ".rip-dvd-legacy-queue.lock"

            class WatchStopped(Exception):
                pass

            def stop_between_iterations(_interval):
                intent = (originals / ".rip-dvd-legacy-queue.intent.lock").open("a+")
                gate = lock.open("a+")
                try:
                    fcntl.flock(intent, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    fcntl.flock(gate, fcntl.LOCK_UN)
                    fcntl.flock(intent, fcntl.LOCK_UN)
                    gate.close()
                    intent.close()
                raise WatchStopped()

            with patch("rip_dvd.cli.time.sleep", side_effect=stop_between_iterations):
                with self.assertRaises(WatchStopped):
                    encode_mode(
                        originals,
                        dry_run=True,
                        watch=True,
                        interval=1,
                        idle=False,
                    )

    def start_cutover_contender(self, originals, command_started):
        marker = originals / ".rip-dvd-sqlite-catalog"
        lock = originals / ".rip-dvd-legacy-queue.lock"
        intent = originals / ".rip-dvd-legacy-queue.intent.lock"
        attempted = threading.Event()

        def publish_cutover():
            command_started.wait()
            attempted.set()
            with intent.open("a+") as intent_file, lock.open("a+") as gate_file:
                fcntl.flock(intent_file, fcntl.LOCK_EX)
                fcntl.flock(gate_file, fcntl.LOCK_EX)
                marker.write_text("{}\n", encoding="utf-8")
                fcntl.flock(gate_file, fcntl.LOCK_UN)
                fcntl.flock(intent_file, fcntl.LOCK_UN)

        contender = threading.Thread(target=publish_cutover)
        contender.start()
        return contender, attempted, marker

    def marker_appeared_before_release(self, marker, attempted):
        self.assertTrue(attempted.wait(timeout=1))
        deadline = time.monotonic() + 0.2
        while time.monotonic() < deadline and not marker.exists():
            time.sleep(0.005)
        return marker.exists()

    def test_in_flight_archive_finishes_before_cutover_is_published(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            device = root / "dvd-device"
            originals = root / "Originals"
            device.write_bytes(b"device")
            originals.mkdir()
            command_started = threading.Event()
            allow_finish = threading.Event()
            result = []
            metadata = MovieMetadata(hint="Race", title="Race Movie", year="2001")

            def fake_archive(plan, **kwargs):
                command_started.set()
                allow_finish.wait()
                plan.output.parent.mkdir(parents=True, exist_ok=True)
                plan.output.write_bytes(b"archive")
                return 0

            def run_archive():
                result.append(
                    archive_mode(
                        device,
                        root / "Movies",
                        originals,
                        "Fast 480p30",
                        scan=sample_scan(),
                    )
                )

            with patch("rip_dvd.cli.resolve_movie_metadata", return_value=metadata):
                with patch("rip_dvd.cli.execute_archive_plan", side_effect=fake_archive):
                    command = threading.Thread(target=run_archive)
                    command.start()
                    contender, attempted, marker = self.start_cutover_contender(
                        originals, command_started
                    )
                    marker_during_archive = self.marker_appeared_before_release(
                        marker, attempted
                    )
                    allow_finish.set()
                    command.join(timeout=2)
                    contender.join(timeout=2)

            self.assertFalse(marker_during_archive)
            self.assertEqual(result, [0])
            self.assertTrue(marker.exists())
            sidecar = (
                originals
                / "Race Movie (2001)"
                / "Race Movie (2001).rip-dvd.json"
            )
            self.assertEqual(
                json.loads(sidecar.read_text(encoding="utf-8"))["archive_status"],
                "ready",
            )

    def test_in_flight_encode_finishes_before_cutover_is_published(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            originals = root / "Originals"
            source = originals / "Race Movie.iso"
            output = root / "Movies" / "Race Movie.mkv"
            originals.mkdir()
            source.write_bytes(b"archive")
            (originals / "Race Movie.rip-dvd.json").write_text(
                json.dumps(
                    {
                        "source": str(source),
                        "jobs": [
                            {
                                "label": "Movie: Race Movie",
                                "output": str(output),
                                "selection": "main_feature",
                                "title_number": None,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            command_started = threading.Event()
            allow_finish = threading.Event()
            result = []

            def fake_encode(job, **kwargs):
                command_started.set()
                allow_finish.wait()
                job.output.parent.mkdir(parents=True, exist_ok=True)
                job.output.write_bytes(b"encode")
                return 0

            def run_encode():
                result.append(encode_mode(originals, idle=False))

            with patch("rip_dvd.cli.execute_encode_job", side_effect=fake_encode):
                command = threading.Thread(target=run_encode)
                command.start()
                contender, attempted, marker = self.start_cutover_contender(
                    originals, command_started
                )
                marker_during_encode = self.marker_appeared_before_release(
                    marker, attempted
                )
                allow_finish.set()
                command.join(timeout=2)
                contender.join(timeout=2)

            self.assertFalse(marker_during_encode)
            self.assertEqual(result, [0])
            self.assertEqual(output.read_bytes(), b"encode")
            self.assertTrue(marker.exists())


class ArchiveIdentityTests(unittest.TestCase):
    def make_plan(self, root):
        metadata = MovieMetadata(hint="Sample", title="Sample Movie", year="2001")
        return build_disc_archive_plan("/dev/sr0", root / "Movies", root / "Originals", metadata)

    def test_existing_archive_is_reused_only_when_disc_fingerprint_matches(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.make_plan(root)
            plan.output.parent.mkdir(parents=True)
            plan.output.write_bytes(b"iso")
            plan.metadata_path.write_text(
                json.dumps(
                    {
                        "schema_version": 2,
                        "archive_status": "ready",
                        "source": str(plan.output),
                        "disc_fingerprint": disc_fingerprint(sample_scan()),
                        "jobs": [],
                    }
                ),
                encoding="utf-8",
            )

            verified, code = validate_archive_identity(plan, sample_scan())

            self.assertTrue(verified)
            self.assertEqual(code, 0)

    def test_existing_archive_is_refused_when_disc_fingerprint_differs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.make_plan(root)
            plan.output.parent.mkdir(parents=True)
            plan.output.write_bytes(b"iso")
            plan.metadata_path.write_text(
                json.dumps(
                    {
                        "schema_version": 2,
                        "archive_status": "ready",
                        "source": str(plan.output),
                        "disc_fingerprint": disc_fingerprint(sample_scan("OTHER_DISC")),
                        "jobs": [],
                    }
                ),
                encoding="utf-8",
            )

            verified, code = validate_archive_identity(plan, sample_scan())

            self.assertFalse(verified)
            self.assertNotEqual(code, 0)

    def test_existing_archive_is_refused_when_sidecar_is_corrupt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.make_plan(root)
            plan.output.parent.mkdir(parents=True)
            plan.output.write_bytes(b"iso")
            plan.metadata_path.write_text("{not-json", encoding="utf-8")

            verified, code = validate_archive_identity(plan, sample_scan())

            self.assertFalse(verified)
            self.assertNotEqual(code, 0)

    def test_schema_one_title_map_can_verify_an_existing_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.make_plan(root)
            scan = sample_scan()
            plan.output.parent.mkdir(parents=True)
            plan.output.write_bytes(b"iso")
            plan.metadata_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "source": str(plan.output),
                        "disc_title": scan.disc_title,
                        "titles": [
                            {
                                "number": title.number,
                                "duration_text": title.duration_text,
                                "seconds": title.seconds,
                                "chapters": title.chapters,
                                "audio_streams": title.audio_streams,
                                "subtitles": title.subtitles,
                            }
                            for title in scan.titles
                        ],
                        "jobs": [],
                    }
                ),
                encoding="utf-8",
            )

            verified, code = validate_archive_identity(plan, scan)

            self.assertTrue(verified)
            self.assertEqual(code, 0)


class QueueMetadataTests(unittest.TestCase):
    def test_atomic_write_failure_preserves_previous_sidecar(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "queue.json"
            path.write_text('{"old": true}\n', encoding="utf-8")

            with patch("rip_dvd.cli.os.replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    atomic_write_json(path, {"new": True})

            self.assertEqual(path.read_text(encoding="utf-8"), '{"old": true}\n')
            self.assertEqual(list(path.parent.glob(f".{path.name}.*.tmp")), [])

    def test_write_queue_metadata_records_ready_archive_and_fingerprint(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            metadata = MovieMetadata(hint="Sample", title="Sample Movie", year="2001")
            plan = build_disc_archive_plan("/dev/sr0", root / "Movies", root / "Originals", metadata)
            job = queue_job(
                plan.output,
                root / "Movies" / "Sample Movie (2001)" / "Sample Movie (2001).mkv",
                "Fast 480p30",
                plan.metadata_path,
                "Movie: Sample Movie",
                None,
            )

            write_queue_metadata(plan, metadata, [job], scan=sample_scan())
            data = json.loads(plan.metadata_path.read_text(encoding="utf-8"))

            self.assertEqual(data["schema_version"], 2)
            self.assertEqual(data["archive_status"], "ready")
            self.assertEqual(data["disc_fingerprint"], disc_fingerprint(sample_scan()))
            self.assertEqual(data["jobs"][0]["selection"], "main_feature")
            self.assertIsNone(data["jobs"][0]["title_number"])


class ArchiveExecutionTests(unittest.TestCase):
    def test_archive_progress_is_streamed_while_dd_runs(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "Film.iso"
            plan = DiscArchivePlan(
                cmd=["dd", "if=/dev/sr0", f"of={partial_output_path(output)}"],
                output=output,
                metadata_path=output.with_suffix(".rip-dvd.json"),
                movie_dir=Path(temp) / "Movies" / "Film",
            )

            class FakeProcess:
                stdout = StringIO("2048 bytes copied\r4096 bytes copied\n")

                def wait(self):
                    partial_output_path(output).write_bytes(b"iso")
                    return 0

            messages = []
            with patch("rip_dvd.cli.subprocess.Popen", return_value=FakeProcess()):
                with patch("rip_dvd.cli.log", side_effect=messages.append):
                    code = execute_archive_plan(plan)

            self.assertEqual(code, 0)
            self.assertTrue(any("2048 bytes copied" in message for message in messages))
            self.assertTrue(any("4096 bytes copied" in message for message in messages))
            self.assertEqual(output.read_bytes(), b"iso")
            self.assertFalse(partial_output_path(output).exists())


class EncodeExecutionTests(unittest.TestCase):
    def test_successful_encode_is_published_atomically_from_partial_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            final_output = root / "Movies" / "Film" / "Film.mkv"
            job = queue_job(root / "Originals" / "Film.iso", final_output, "Fast 480p30", root / "queue.json", "Film", None)

            def fake_execute(plan, **kwargs):
                self.assertEqual(plan.output, partial_output_path(final_output))
                self.assertFalse(final_output.exists())
                plan.output.parent.mkdir(parents=True, exist_ok=True)
                plan.output.write_bytes(b"complete encode")
                return 0

            with patch("rip_dvd.cli.execute_rip_plan", side_effect=fake_execute):
                code = execute_encode_job(job, idle=False)

            self.assertEqual(code, 0)
            self.assertEqual(final_output.read_bytes(), b"complete encode")
            self.assertFalse(partial_output_path(final_output).exists())

    def test_failed_encode_never_creates_final_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            final_output = root / "Movies" / "Film" / "Film.mkv"
            job = queue_job(root / "Originals" / "Film.iso", final_output, "Fast 480p30", root / "queue.json", "Film", 1)

            def fake_execute(plan, **kwargs):
                plan.output.parent.mkdir(parents=True, exist_ok=True)
                plan.output.write_bytes(b"partial")
                return 9

            with patch("rip_dvd.cli.execute_rip_plan", side_effect=fake_execute):
                code = execute_encode_job(job, idle=False)

            self.assertEqual(code, 9)
            self.assertFalse(final_output.exists())
            partial = partial_output_path(final_output)
            self.assertTrue(partial.with_suffix(partial.suffix + ".failed").exists())

    def test_concurrent_encoder_cannot_touch_an_active_partial_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            final_output = root / "Movies" / "Film" / "Film.mkv"
            final_output.parent.mkdir(parents=True)
            job = queue_job(root / "Originals" / "Film.iso", final_output, "Fast 480p30", root / "queue.json", "Film", 1)

            with encode_lock_path(final_output).open("a+", encoding="utf-8") as lock_handle:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch("rip_dvd.cli.execute_rip_plan") as execute:
                    code = execute_encode_job(job, idle=False)

            self.assertIsNone(code)
            execute.assert_not_called()
            self.assertFalse(final_output.exists())


class ArchiveModeTests(unittest.TestCase):
    def test_archive_mode_queues_handbrake_main_feature_and_selected_extras(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            device = root / "dvd-device"
            device.write_bytes(b"device")
            metadata = MovieMetadata(hint="Sample", title="Sample Movie", year="2001")

            def fake_archive(plan, **kwargs):
                plan.output.parent.mkdir(parents=True, exist_ok=True)
                plan.output.write_bytes(b"iso")
                return 0

            with patch("rip_dvd.cli.resolve_movie_metadata", return_value=metadata):
                with patch("rip_dvd.cli.execute_archive_plan", side_effect=fake_archive):
                    code = archive_mode(
                        device,
                        root / "Movies",
                        root / "Originals",
                        "Fast 480p30",
                        extra_title_numbers=[2],
                        scan=sample_scan(),
                    )

            sidecar = root / "Originals" / "Sample Movie (2001)" / "Sample Movie (2001).rip-dvd.json"
            data = json.loads(sidecar.read_text(encoding="utf-8"))
            self.assertEqual(code, 0)
            self.assertEqual(data["jobs"][0]["selection"], "main_feature")
            self.assertIsNone(data["jobs"][0]["title_number"])
            self.assertEqual(data["jobs"][1]["title_number"], 2)

    def test_failed_archive_leaves_recoverable_non_ready_queue_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            device = root / "dvd-device"
            device.write_bytes(b"device")
            metadata = MovieMetadata(hint="Sample", title="Sample Movie", year="2001")

            with patch("rip_dvd.cli.resolve_movie_metadata", return_value=metadata):
                with patch("rip_dvd.cli.execute_archive_plan", return_value=9):
                    code = archive_mode(
                        device,
                        root / "Movies",
                        root / "Originals",
                        "Fast 480p30",
                        scan=sample_scan(),
                    )

            sidecar = root / "Originals" / "Sample Movie (2001)" / "Sample Movie (2001).rip-dvd.json"
            data = json.loads(sidecar.read_text(encoding="utf-8"))
            self.assertEqual(code, 9)
            self.assertEqual(data["archive_status"], "archiving")
            self.assertEqual(discover_encode_jobs(root / "Originals"), [])

    def test_published_archive_recovers_if_ready_metadata_update_was_interrupted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            device = root / "dvd-device"
            device.write_bytes(b"device")
            metadata = MovieMetadata(hint="Sample", title="Sample Movie", year="2001")
            plan = build_disc_archive_plan(device, root / "Movies", root / "Originals", metadata)
            job = queue_job(
                plan.output,
                root / "Movies" / "Sample Movie (2001)" / "Sample Movie (2001).mkv",
                "Fast 480p30",
                plan.metadata_path,
                "Movie: Sample Movie",
                None,
            )
            plan.output.parent.mkdir(parents=True)
            plan.output.write_bytes(b"complete iso")
            write_queue_metadata(plan, metadata, [job], scan=sample_scan(), archive_status="archiving")

            with patch("rip_dvd.cli.resolve_movie_metadata", return_value=metadata):
                code = archive_mode(
                    device,
                    root / "Movies",
                    root / "Originals",
                    "Fast 480p30",
                    scan=sample_scan(),
                )

            data = json.loads(plan.metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(code, 0)
            self.assertEqual(data["archive_status"], "ready")
            self.assertEqual(plan.output.read_bytes(), b"complete iso")


if __name__ == "__main__":
    unittest.main()
