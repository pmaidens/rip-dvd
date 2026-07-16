import json
import fcntl
from pathlib import Path
from io import StringIO
import tempfile
import unittest
from unittest.mock import patch

from rip_dvd.cli import (
    archive_mode,
    atomic_write_json,
    disc_fingerprint,
    discover_encode_jobs,
    execute_archive_plan,
    execute_encode_job,
    encode_lock_path,
    failed_output_path,
    partial_output_path,
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

    def test_failed_output_path_does_not_overwrite_existing_failed_file(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "Movie.mkv"
            output.with_suffix(".mkv.failed").write_bytes(b"old failure")

            self.assertEqual(failed_output_path(output), output.with_suffix(".mkv.failed.1"))


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
