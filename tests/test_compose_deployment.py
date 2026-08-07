import json
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def compose_config(
    *profiles: str,
    files: tuple[str, ...] = (),
) -> dict[str, object]:
    if shutil.which("docker") is None:
        raise unittest.SkipTest("Docker Compose is unavailable")
    command = ["docker", "compose"]
    for file in files:
        command.extend(["--file", file])
    for profile in profiles:
        command.extend(["--profile", profile])
    command.extend(["config", "--format", "json"])
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        cwd=ROOT,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


def run_compose_script(
    script_name: str,
    *,
    environment: dict[str, str] | None = None,
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    with tempfile.TemporaryDirectory() as directory:
        temporary = pathlib.Path(directory)
        calls = temporary / "calls"
        docker = temporary / "docker"
        docker.write_text(
            "#!/bin/sh\n"
            "if [ \"$*\" = 'compose config --environment' ]; then\n"
            "  if [ -n \"${DOCKER_COMPOSE_ENVIRONMENT:-}\" ]; then\n"
            "    printf '%s\\n' \"$DOCKER_COMPOSE_ENVIRONMENT\"\n"
            "  else\n"
            "    [ -z \"${RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS:-}\" ] || "
            "printf 'RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS=%s\\n' "
            "\"$RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS\"\n"
            "    [ -z \"${RIP_DVD_BACKUP_HOST_PATH:-}\" ] || "
            "printf 'RIP_DVD_BACKUP_HOST_PATH=%s\\n' "
            "\"$RIP_DVD_BACKUP_HOST_PATH\"\n"
            "  fi\n"
            "  exit 0\n"
            "fi\n"
            "printf '%s|%s|%s\\n' \"$PWD\" \"${RIP_DVD_BACKUP_HOST_PATH:-}\" \"$*\" "
            '>> \"$DOCKER_CALL_LOG\"\n'
        )
        docker.chmod(0o755)
        result = subprocess.run(
            ["sh", str(ROOT / "scripts" / script_name)],
            capture_output=True,
            check=False,
            cwd=temporary,
            env={
                "DOCKER_CALL_LOG": str(calls),
                "PATH": f"{temporary}:/usr/bin:/bin",
                **(environment or {}),
            },
            text=True,
        )
        return result, calls.read_text().splitlines() if calls.exists() else []


def run_worker_entrypoint(
    *,
    ionice_class: str,
    nice_level: str,
    ionice_exit: int = 0,
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    with tempfile.TemporaryDirectory() as directory:
        temporary = pathlib.Path(directory)
        calls = temporary / "calls"
        for command in ("ionice", "nice"):
            executable = temporary / command
            exit_status = ionice_exit if command == "ionice" else 0
            executable.write_text(
                f"#!/bin/sh\nprintf '{command}|%s\\n' \"$*\" >> \"$CALL_LOG\"\n"
                f"exit {exit_status}\n"
            )
            executable.chmod(0o755)

        result = subprocess.run(
            [
                "sh",
                str(ROOT / "docker" / "worker-priority-entrypoint.sh"),
                "node",
                "worker.js",
            ],
            capture_output=True,
            check=False,
            env={
                "CALL_LOG": str(calls),
                "PATH": f"{temporary}:/usr/bin:/bin",
                "RIP_DVD_WORKER_IONICE_CLASS": ionice_class,
                "RIP_DVD_WORKER_IONICE_LEVEL": "7",
                "RIP_DVD_WORKER_NICE_LEVEL": nice_level,
            },
            text=True,
        )
        return result, calls.read_text().splitlines() if calls.exists() else []


class ComposeDeploymentTests(unittest.TestCase):
    def test_runtime_roles_have_exact_mount_device_and_image_boundaries(self) -> None:
        services = compose_config()["services"]

        expected = {
            "web": {
                "mounts": [
                    ("/data", False),
                    ("/media/movies", True),
                    ("/media/originals", True),
                ],
                "devices": None,
                "target": "web",
            },
            "archive-worker": {
                "mounts": [("/data", False), ("/media/originals", False)],
                "devices": [
                    {
                        "source": "/dev/sr0",
                        "target": "/dev/sr0",
                        "permissions": "r",
                    }
                ],
                "target": "archive-worker",
            },
            "encode-worker": {
                "mounts": [
                    ("/data", False),
                    ("/media/movies", False),
                    ("/media/originals", True),
                ],
                "devices": None,
                "target": "encode-worker",
            },
        }

        for service_name, boundary in expected.items():
            service = services[service_name]
            self.assertEqual(
                [
                    (volume["target"], volume.get("read_only", False))
                    for volume in service["volumes"]
                ],
                boundary["mounts"],
            )
            self.assertEqual(service.get("devices"), boundary["devices"])
            self.assertEqual(service["build"]["target"], boundary["target"])

        self.assertEqual(services["archive-worker"]["group_add"], ["24"])

    def test_reviewed_hardware_override_can_expose_multiple_optical_drives(
        self,
    ) -> None:
        archive = compose_config(
            files=("compose.yaml", "compose.hardware.example.yaml")
        )["services"]["archive-worker"]

        self.assertEqual(
            archive["devices"],
            [
                {"source": "/dev/sr0", "target": "/dev/sr0", "permissions": "r"},
                {"source": "/dev/sr1", "target": "/dev/sr1", "permissions": "r"},
            ],
        )
        self.assertEqual(archive["group_add"], ["24"])

    def test_build_script_builds_every_deployable_image_from_the_repo(self) -> None:
        result, calls = run_compose_script("compose-build.sh")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                f"{ROOT}||compose --profile maintenance build migrate backup web archive-worker encode-worker"
            ],
        )

    def test_migration_script_runs_the_one_shot_migrator(self) -> None:
        result, calls = run_compose_script("compose-migrate.sh")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                f"{ROOT}||compose --profile maintenance run --rm --no-deps migrate"
            ],
        )

    def test_start_script_migrates_before_starting_runtime_services(self) -> None:
        result, calls = run_compose_script("compose-start.sh")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                f"{ROOT}||compose --profile maintenance run --rm --no-deps migrate",
                f"{ROOT}||compose up --detach --no-build web archive-worker encode-worker",
            ],
        )

    def test_start_script_can_enable_verified_native_linux_io_weights(self) -> None:
        result, calls = run_compose_script(
            "compose-start.sh",
            environment={"RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS": "1"},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                f"{ROOT}||compose --profile maintenance run --rm --no-deps migrate",
                f"{ROOT}||compose --file compose.yaml --file compose.linux-priority.yaml up --detach --no-build web archive-worker encode-worker",
            ],
        )

    def test_start_script_reads_io_weight_mode_from_compose_dotenv(self) -> None:
        result, calls = run_compose_script(
            "compose-start.sh",
            environment={
                "DOCKER_COMPOSE_ENVIRONMENT": (
                    "RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS=1"
                ),
            },
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                f"{ROOT}||compose --profile maintenance run --rm --no-deps migrate",
                f"{ROOT}||compose --file compose.yaml --file compose.linux-priority.yaml up --detach --no-build web archive-worker encode-worker",
            ],
        )

    def test_start_script_rejects_invalid_io_weight_mode_before_migration(self) -> None:
        result, calls = run_compose_script(
            "compose-start.sh",
            environment={"RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS": "sometimes"},
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be 0 or 1", result.stderr)
        self.assertEqual(calls, [])

    def test_stop_script_preserves_containers_networks_and_volumes(self) -> None:
        result, calls = run_compose_script("compose-stop.sh")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                f"{ROOT}||compose stop --timeout 30 archive-worker encode-worker web"
            ],
        )

    def test_backup_script_prepares_an_explicit_host_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backup_directory = pathlib.Path(directory) / "sqlite-backups"
            result, calls = run_compose_script(
                "compose-backup.sh",
                environment={
                    "RIP_DVD_BACKUP_HOST_PATH": str(backup_directory),
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(backup_directory.is_dir())
            self.assertEqual(
                calls,
                [
                    f"{ROOT}|{backup_directory.resolve()}|compose --profile maintenance run --rm --no-deps backup"
                ],
            )

    def test_backup_script_reads_destination_from_compose_dotenv(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backup_directory = pathlib.Path(directory) / "sqlite backups"
            result, calls = run_compose_script(
                "compose-backup.sh",
                environment={
                    "DOCKER_COMPOSE_ENVIRONMENT": (
                        f"RIP_DVD_BACKUP_HOST_PATH={backup_directory}"
                    ),
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(backup_directory.is_dir())
            self.assertEqual(
                calls,
                [
                    f"{ROOT}|{backup_directory.resolve()}|compose --profile maintenance run --rm --no-deps backup"
                ],
            )

    def test_maintenance_services_mount_only_the_state_they_operate_on(self) -> None:
        config = compose_config("maintenance")
        services = config["services"]

        migrate = services["migrate"]
        self.assertEqual(
            migrate["volumes"],
            [
                {
                    "type": "volume",
                    "source": "rip-dvd-data",
                    "target": "/data",
                    "volume": {},
                }
            ],
        )

        backup = services["backup"]
        self.assertEqual(
            backup["volumes"],
            [
                {
                    "type": "volume",
                    "source": "rip-dvd-data",
                    "target": "/data",
                    "volume": {},
                },
                {
                    "type": "bind",
                    "source": str(ROOT / "backups"),
                    "target": "/backups",
                    "bind": {"create_host_path": True},
                },
            ],
        )
        self.assertNotIn("devices", migrate)
        self.assertNotIn("devices", backup)

    def test_workers_have_role_ordered_cpu_io_and_process_priorities(self) -> None:
        services = compose_config()["services"]
        web = services["web"]
        archive = services["archive-worker"]
        encode = services["encode-worker"]

        self.assertNotIn("cpu_shares", web)
        self.assertNotIn("blkio_config", web)
        self.assertNotIn("RIP_DVD_WORKER_NICE_LEVEL", web["environment"])

        self.assertEqual(archive["cpu_shares"], 512)
        self.assertNotIn("blkio_config", archive)
        self.assertEqual(archive["environment"]["RIP_DVD_WORKER_NICE_LEVEL"], "10")
        self.assertEqual(archive["environment"]["RIP_DVD_WORKER_IONICE_CLASS"], "2")
        self.assertEqual(archive["environment"]["RIP_DVD_WORKER_IONICE_LEVEL"], "7")

        self.assertEqual(encode["cpu_shares"], 128)
        self.assertNotIn("blkio_config", encode)
        self.assertEqual(encode["environment"]["RIP_DVD_WORKER_NICE_LEVEL"], "19")
        self.assertEqual(encode["environment"]["RIP_DVD_WORKER_IONICE_CLASS"], "3")
        self.assertEqual(encode["environment"]["RIP_DVD_WORKER_IONICE_LEVEL"], "7")

        native_linux = compose_config(
            files=("compose.yaml", "compose.linux-priority.yaml")
        )["services"]
        self.assertEqual(native_linux["archive-worker"]["blkio_config"]["weight"], 500)
        self.assertEqual(native_linux["encode-worker"]["blkio_config"]["weight"], 100)

    def test_worker_entrypoint_applies_configured_process_priorities(self) -> None:
        result, priority_calls = run_worker_entrypoint(
            ionice_class="2",
            nice_level="10",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(priority_calls[0], r"^ionice\|-c 2 -n 7 -p [0-9]+$")
        self.assertEqual(priority_calls[1], "nice|-n 10 node worker.js")

    def test_worker_entrypoint_keeps_running_when_host_ionice_is_unsupported(
        self,
    ) -> None:
        result, priority_calls = run_worker_entrypoint(
            ionice_class="3",
            nice_level="19",
            ionice_exit=73,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("continuing with CPU nice priority only", result.stderr)
        self.assertEqual(priority_calls[-1], "nice|-n 19 node worker.js")

    def test_deployment_documentation_covers_host_setup_and_state_recovery(
        self,
    ) -> None:
        readme = (ROOT / "README.md").read_text()
        environment_example = (ROOT / ".env.example").read_text()

        for script in (
            "scripts/compose-build.sh",
            "scripts/compose-migrate.sh",
            "scripts/compose-start.sh",
            "scripts/compose-stop.sh",
            "scripts/compose-backup.sh",
        ):
            self.assertIn(script, readme)
        for expectation in (
            "Never run `docker compose down --volumes`",
            "SQLite online backup API",
            "Stop all three runtime services before restoring",
            "UID/GID 1000",
            "`/dev/sr0`",
            "compose.hardware.example.yaml",
            "RIP_DVD_OPTICAL_DEVICE_GID",
            "read-only",
            "`cpu_shares`",
            "`blkio_config.weight`",
            "I/O scheduler",
        ):
            self.assertIn(expectation, readme)

        for setting in (
            "RIP_DVD_BACKUP_HOST_PATH=./backups",
            "RIP_DVD_OPTICAL_DEVICE_GID=24",
            "RIP_DVD_ARCHIVE_CPU_SHARES=512",
            "RIP_DVD_ARCHIVE_NICE_LEVEL=10",
            "RIP_DVD_ENCODE_CPU_SHARES=128",
            "RIP_DVD_ENCODE_NICE_LEVEL=19",
        ):
            self.assertIn(setting, environment_example)

    @unittest.skipUnless(shutil.which("sqlite3"), "sqlite3 is unavailable")
    def test_backup_tool_captures_committed_wal_state_in_a_verified_snapshot(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            database_path = root / "rip-dvd.sqlite"
            backup_directory = root / "backups"
            backup_directory.mkdir()

            database = sqlite3.connect(database_path)
            self.addCleanup(database.close)
            self.assertEqual(
                database.execute("PRAGMA journal_mode = WAL").fetchone(), ("wal",)
            )
            database.execute("CREATE TABLE archive_jobs (id TEXT PRIMARY KEY)")
            database.execute("INSERT INTO archive_jobs VALUES ('archive-job-18')")
            database.commit()

            result = subprocess.run(
                ["sh", str(ROOT / "docker" / "backup-sqlite.sh")],
                capture_output=True,
                check=False,
                env={
                    "PATH": (
                        f"{pathlib.Path(shutil.which('sqlite3')).parent}:/usr/bin:/bin"
                    ),
                    "RIP_DVD_BACKUP_DIRECTORY": str(backup_directory),
                    "RIP_DVD_DATABASE_PATH": str(database_path),
                },
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            backups = list(backup_directory.glob("rip-dvd-*.sqlite"))
            self.assertEqual(len(backups), 1)
            with sqlite3.connect(backups[0]) as snapshot:
                self.assertEqual(
                    snapshot.execute("PRAGMA integrity_check").fetchone(), ("ok",)
                )
                self.assertEqual(
                    snapshot.execute("SELECT id FROM archive_jobs").fetchone(),
                    ("archive-job-18",),
                )
            self.assertEqual(list(backup_directory.glob("*.partial")), [])

    def test_deployment_tools_image_is_separate_from_the_web_runtime(self) -> None:
        dockerfile = (ROOT / "docker" / "runtime.Dockerfile").read_text()
        web_runtime = dockerfile.split("FROM runtime-base AS web", 1)[1].split(
            "FROM runtime-base AS worker-runtime-base", 1
        )[0]
        deployment_runtime = dockerfile.split(
            "FROM runtime-base AS deployment-tools", 1
        )[1].split("FROM runtime-base AS web", 1)[0]
        archive_runtime = dockerfile.split(
            "FROM worker-runtime-base AS archive-worker", 1
        )[1].split("FROM worker-runtime-base AS encode-worker", 1)[0]
        encode_runtime = dockerfile.split(
            "FROM worker-runtime-base AS encode-worker", 1
        )[1]

        self.assertNotIn("sqlite3", web_runtime)
        self.assertNotIn("lsdvd", web_runtime)
        self.assertNotIn("handbrake-cli", web_runtime)
        self.assertIn("sqlite3", deployment_runtime)
        self.assertIn("scripts/migrate-database.mjs", deployment_runtime)
        self.assertIn("scripts/backup-sqlite.sh", deployment_runtime)
        self.assertIn("USER node", deployment_runtime)
        self.assertIn("lsdvd util-linux", archive_runtime)
        self.assertNotIn("handbrake-cli", archive_runtime)
        self.assertIn("handbrake-cli ffmpeg util-linux", encode_runtime)
        self.assertNotIn("lsdvd", encode_runtime)


if __name__ == "__main__":
    unittest.main()
