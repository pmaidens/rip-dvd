import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def run_smoke_with_docker_stub(
    stub_body: str,
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    with tempfile.TemporaryDirectory() as directory:
        temporary = pathlib.Path(directory)
        calls = temporary / "calls"
        docker = temporary / "docker"
        docker.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALL_LOG"\n' + stub_body
        )
        docker.chmod(0o755)
        environment = {
            **os.environ,
            "COMPOSE_PROJECT_NAME": "fresh-test-project",
            "DOCKER_CALL_LOG": str(calls),
            "PATH": f"{temporary}:{os.environ['PATH']}",
        }

        result = subprocess.run(
            ["sh", str(ROOT / "scripts" / "smoke-compose-workers.sh"), "named"],
            capture_output=True,
            check=False,
            env=environment,
            text=True,
        )
        return result, calls.read_text().splitlines()


def resolved_project_name(calls: list[str]) -> str:
    prefix = "ps --all --quiet --filter label=com.docker.compose.project="
    return calls[0].removeprefix(prefix)


class RuntimeScaffoldTests(unittest.TestCase):
    def test_compose_runtime_paths_are_fixed_to_persistent_mounts(self) -> None:
        compose = (ROOT / "compose.yaml").read_text()

        expected_paths = {
            "RIP_DVD_DATABASE_PATH": "/data/rip-dvd.sqlite",
            "RIP_DVD_MEDIA_LIBRARY_PATH": "/media/movies",
            "RIP_DVD_ORIGINALS_LIBRARY_PATH": "/media/originals",
        }
        for variable, path in expected_paths.items():
            self.assertIn(f"{variable}: {path}", compose)
            self.assertNotIn(f"${{{variable}", compose)
        self.assertEqual(compose.count("environment: *runtime-environment"), 3)

    def test_compose_environment_example_does_not_expose_container_paths(self) -> None:
        example = (ROOT / ".env.example").read_text()

        for variable in (
            "RIP_DVD_DATABASE_PATH",
            "RIP_DVD_MEDIA_LIBRARY_PATH",
            "RIP_DVD_ORIGINALS_LIBRARY_PATH",
        ):
            self.assertNotIn(f"{variable}=", example)

    def test_worker_smoke_uses_configured_command_and_bounded_shutdown(self) -> None:
        smoke = (ROOT / "scripts" / "smoke-compose-workers.sh").read_text()

        self.assertIn('compose up --detach --no-deps "$service"', smoke)
        self.assertIn('compose stop --timeout 10 "$service"', smoke)
        self.assertIn('while [ "$attempt" -lt "$readiness_attempts" ]', smoke)
        self.assertIn('"$shutdown_message"', smoke)
        self.assertNotIn('node "$entry_point"', smoke)

    def test_worker_smoke_dispatches_complete_worker_descriptors(self) -> None:
        smoke = (ROOT / "scripts" / "smoke-compose-workers.sh").read_text()

        self.assertIn('worker_roles="archive encode"', smoke)
        self.assertIn("worker_service=archive-worker", smoke)
        self.assertIn("worker_writable_path=/media/originals", smoke)
        self.assertIn('worker_ready_message="Archive worker ready"', smoke)
        self.assertIn(
            'worker_shutdown_message="Archive worker received SIGTERM; stopping"',
            smoke,
        )
        self.assertIn("worker_service=encode-worker", smoke)
        self.assertIn("worker_writable_path=/media/movies", smoke)
        self.assertIn('worker_ready_message="Encode worker ready"', smoke)
        self.assertIn(
            'worker_shutdown_message="Encode worker received SIGTERM; stopping"',
            smoke,
        )
        self.assertIn('smoke_worker "$worker_role"', smoke)
        self.assertNotIn("IFS='|'", smoke)
        self.assertNotIn("smoke_worker \\\n    archive-worker", smoke)

    def test_worker_smoke_fails_closed_on_project_and_marker_collisions(self) -> None:
        smoke = (ROOT / "scripts" / "smoke-compose-workers.sh").read_text()

        self.assertIn('/dev/urandom', smoke)
        self.assertIn('label=com.docker.compose.project="$candidate"', smoke)
        self.assertIn('test ! -e "$marker"', smoke)
        self.assertIn('${run_token}', smoke)

    def test_worker_smoke_stops_when_docker_preflight_fails(self) -> None:
        result, calls = run_smoke_with_docker_stub("exit 17\n")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to continue", result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertRegex(
            resolved_project_name(calls),
            r"^fresh-test-project-[0-9a-f]{16}-named$",
        )

    def test_worker_smoke_stops_when_project_resources_exist(self) -> None:
        result, calls = run_smoke_with_docker_stub('printf "existing-container\\n"\n')

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("matching containers already exist", result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertRegex(
            resolved_project_name(calls),
            r"^fresh-test-project-[0-9a-f]{16}-named$",
        )

    def test_explicit_project_base_always_gets_fresh_entropy(self) -> None:
        first_result, first_calls = run_smoke_with_docker_stub("exit 17\n")
        second_result, second_calls = run_smoke_with_docker_stub("exit 17\n")

        self.assertNotEqual(first_result.returncode, 0)
        self.assertNotEqual(second_result.returncode, 0)
        first_project = resolved_project_name(first_calls)
        second_project = resolved_project_name(second_calls)
        self.assertRegex(first_project, r"^fresh-test-project-[0-9a-f]{16}-named$")
        self.assertRegex(second_project, r"^fresh-test-project-[0-9a-f]{16}-named$")
        self.assertNotEqual(first_project, second_project)

    def test_worker_smoke_rejects_an_unlabelled_exact_name_volume(self) -> None:
        result, calls = run_smoke_with_docker_stub(
            'case "$*" in\n'
            '  "volume ls --quiet --filter name="*"_rip-dvd-data$")\n'
            '    printf "unlabelled-volume\\n"\n'
            "    exit 0\n"
            "    ;;\n"
            "esac\n"
            'case "$1" in\n'
            "  ps|volume|network|image) exit 0 ;;\n"
            "  *) exit 17 ;;\n"
            "esac\n"
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("matching volumes already exist", result.stderr)
        self.assertTrue(
            any(
                call.startswith("volume ls --quiet --filter name=^")
                and call.endswith("_rip-dvd-data$")
                for call in calls
            )
        )

    def test_production_sharp_override_is_patched(self) -> None:
        workspace = (ROOT / "pnpm-workspace.yaml").read_text()
        lockfile = (ROOT / "pnpm-lock.yaml").read_text()
        dockerfile = (ROOT / "docker" / "runtime.Dockerfile").read_text()

        self.assertIn("sharp: 0.35.0", workspace)
        self.assertIn("sharp@0.35.0", lockfile)
        self.assertNotIn("sharp@0.34.5", lockfile)
        self.assertIn("@img+sharp-libvips-linux-*", dockerfile)
        self.assertIn('cp --archive "$source/." "$destination/"', dockerfile)
        self.assertIn("lib/libvips-cpp.so.*", dockerfile)
        self.assertIn("&& ldconfig", dockerfile)


if __name__ == "__main__":
    unittest.main()
