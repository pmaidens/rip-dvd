import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
OLD_COMMIT = "1" * 40
TARGET_COMMIT = "2" * 40


def write_executable(path: pathlib.Path, body: str) -> None:
    path.write_text(body)
    path.chmod(0o755)


class DeploymentControllerHarness:
    def __init__(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary_directory.name)
        self.commands = self.root / "commands"
        self.commands.mkdir()
        self.calls = self.root / "calls"
        self.head = self.root / "head"
        self.fetch_count = self.root / "fetch-count"
        self.runtime_stopped = self.root / "runtime-stopped"
        self.systemctl_count = self.root / "systemctl-count"
        self.state = self.root / "state"
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.config = self.root / "deployment.json"
        self.readiness = {
            "schemaVersion": 1,
            "activeWork": [],
            "opticalDrives": [
                {
                    "id": "drive-a",
                    "devicePath": "/dev/sr1",
                    "serialNumber": "SERIAL-A",
                    "isEnabled": True,
                    "isPresent": True,
                },
                {
                    "id": "drive-b",
                    "devicePath": "/dev/sr2",
                    "serialNumber": "SERIAL-B",
                    "isEnabled": True,
                    "isPresent": True,
                },
            ],
        }
        self.config.write_text(
            json.dumps(
                {
                    "expectedHostname": "test-host",
                    "expectedRepositoryRoot": str(ROOT),
                    "expectedRemoteUrl": "https://github.com/pmaidens/rip-dvd.git",
                    "branch": "main",
                    "upstream": "origin/main",
                    "remote": "origin",
                    "targetRef": "origin/main",
                    "healthUrl": "http://127.0.0.1:3000/api/health",
                    "readinessUrl": "http://127.0.0.1:3000/api/deployment-readiness",
                    "storagePaths": ["/", "/mnt/sandisk"],
                    "expectedDrives": [
                        {
                            "serialNumber": "SERIAL-A",
                            "applicationId": "drive-a",
                        },
                        {
                            "serialNumber": "SERIAL-B",
                            "applicationId": "drive-b",
                        },
                    ],
                }
            )
        )
        self.environment = {
            "COMMAND_CALL_LOG": str(self.calls),
            "DEPLOY_ROOT": str(ROOT),
            "GIT_FETCH_COUNT": str(self.fetch_count),
            "GIT_HEAD_FILE": str(self.head),
            "RUNTIME_STOPPED_MARKER": str(self.runtime_stopped),
            "SYSTEMCTL_COUNT": str(self.systemctl_count),
            "RIP_DVD_BACKUP_HOST_PATH": str(self.backups),
            "RIP_DVD_DEPLOY_HOSTNAME_OVERRIDE": "test-host",
            "RIP_DVD_DEPLOY_STATE_DIR": str(self.state),
            "READINESS_JSON": json.dumps(self.readiness),
            "LSBLK_JSON": json.dumps(
                {
                    "blockdevices": [
                        {
                            "path": "/dev/sr1",
                            "type": "rom",
                            "model": "Drive A",
                            "serial": "SERIAL-A",
                        },
                        {
                            "path": "/dev/sr2",
                            "type": "rom",
                            "model": "Drive B",
                            "serial": "SERIAL-B",
                        },
                    ]
                }
            ),
            "GIT_CHANGE_KIND": "source",
        }
        self._write_commands()

    def cleanup(self) -> None:
        self.temporary_directory.cleanup()

    def _write_commands(self) -> None:
        git = r"""#!/bin/sh
printf 'git|%s\n' "$*" >> "$COMMAND_CALL_LOG"
case "$*" in
  'rev-parse --show-toplevel') printf '%s\n' "${GIT_REPOSITORY_ROOT:-$DEPLOY_ROOT}" ;;
  'remote get-url origin') printf '%s\n' "${GIT_REMOTE_URL:-https://github.com/pmaidens/rip-dvd.git}" ;;
  'branch --show-current') printf '%s\n' "${GIT_BRANCH:-main}" ;;
  'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') printf '%s\n' "${GIT_UPSTREAM:-origin/main}" ;;
  'status --porcelain --untracked-files=normal') printf '%s' "${GIT_STATUS_OUTPUT:-}" ;;
  'rev-parse HEAD')
    if [ -f "$GIT_HEAD_FILE" ]; then
      printf '%s\n' "${GIT_DEPLOYED_COMMIT:-__TARGET__}"
    else
      printf '%s\n' "__OLD__"
    fi
    ;;
  'fetch --prune origin')
    count=0
    if [ -f "$GIT_FETCH_COUNT" ]; then count="$(sed -n '1p' "$GIT_FETCH_COUNT")"; fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$GIT_FETCH_COUNT"
    ;;
  'rev-parse --verify origin/main^{commit}')
    count=0
    if [ -f "$GIT_FETCH_COUNT" ]; then count="$(sed -n '1p' "$GIT_FETCH_COUNT")"; fi
    if [ "${GIT_MOVE_TARGET:-0}" = 1 ] && [ "$count" -ge 2 ]; then
      printf '%s\n' "__MOVED__"
    else
      printf '%s\n' "__TARGET__"
    fi
    ;;
  'merge-base --is-ancestor __OLD__ __TARGET__')
    [ "${GIT_ANCESTRY_FAIL:-0}" != 1 ]
    ;;
  'log --format=%H%x09%s --no-merges __OLD__..__TARGET__')
    printf '__TARGET__\tFixture deployment commit\n'
    ;;
  'diff --name-status -z __OLD__..__TARGET__')
    case "${GIT_CHANGE_KIND:-source}" in
      source) printf 'M\000apps/web/app/page.tsx\000' ;;
      risky) printf 'M\000scripts/update.sh\000' ;;
      schema) printf 'M\000packages/data-access/src/schema.ts\000' ;;
      compose) printf 'M\000compose.yaml\000' ;;
      config) printf 'M\000packages/config/src/index.ts\000' ;;
      many)
        index=1
        while [ "$index" -le 300 ]; do
          printf 'M\000apps/web/file-%s.ts\000' "$index"
          index=$((index + 1))
        done
        printf 'M\000scripts/update.sh\000'
        ;;
    esac
    ;;
  diff\ --no-ext-diff*) printf '%s' "${GIT_REVIEW_DIFF:-}" ;;
  'rev-parse --git-path rip-dvd-update.lock') printf '%s\n' "$RIP_DVD_DEPLOY_STATE_DIR/update.lock" ;;
  'symbolic-ref --quiet --short HEAD') printf 'main\n' ;;
  'cat-file -e __TARGET__^{commit}') exit 0 ;;
  'merge --ff-only __TARGET__')
    [ -z "${GIT_MERGE_FAIL_STATUS:-}" ] || exit "$GIT_MERGE_FAIL_STATUS"
    : > "$GIT_HEAD_FILE"
    ;;
  *) printf 'unexpected fake git command: %s\n' "$*" >&2; exit 64 ;;
esac
"""
        git = (
            git.replace("__OLD__", OLD_COMMIT)
            .replace("__TARGET__", TARGET_COMMIT)
            .replace("__MOVED__", "3" * 40)
        )
        write_executable(self.commands / "git", git)

        docker = """#!/bin/sh
printf 'docker|%s\n' "$*" >> "$COMMAND_CALL_LOG"
if [ -n "${DOCKER_FAIL_MATCH:-}" ]; then
  case "$*" in
    *"$DOCKER_FAIL_MATCH"*)
      if [ "${CORRUPT_STAGE_ON_FAILURE:-0}" = 1 ]; then
        rm -f "$RIP_DVD_UPDATE_STAGE_FILE"
        mkdir "$RIP_DVD_UPDATE_STAGE_FILE"
      fi
      exit "${DOCKER_FAIL_STATUS:-1}"
      ;;
  esac
fi
case "$*" in
  'compose config --quiet') exit 0 ;;
  'compose config --environment')
    printf 'RIP_DVD_BACKUP_HOST_PATH=%s\n' "$RIP_DVD_BACKUP_HOST_PATH"
    ;;
  'compose ps') printf 'web healthy\narchive-worker running\nencode-worker running\n' ;;
  'system df') printf 'TYPE TOTAL ACTIVE SIZE RECLAIMABLE\nImages 5 5 1GB 0B\n' ;;
  'compose --profile maintenance run --rm --no-deps backup')
    if [ "${DOCKER_SKIP_BACKUP_FILE:-0}" != 1 ]; then
      printf 'fixture\n' > "$RIP_DVD_BACKUP_HOST_PATH/rip-dvd-test.sqlite"
    fi
    printf 'SQLite backup written to /backups/rip-dvd-test.sqlite\n'
    ;;
  'compose --profile maintenance run --rm --no-deps migrate')
    printf 'SQLite migrations are current\n'
    ;;
  'compose ps --quiet web') printf 'web-container\n' ;;
  'inspect --format {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}} web-container')
    printf '%s\n' "${WEB_HEALTH_STATUS:-healthy}"
    ;;
  'compose ps --status running --services')
    if [ ! -f "$RUNTIME_STOPPED_MARKER" ]; then
      printf '%s\n' "${RUNNING_SERVICES:-web archive-worker encode-worker}" | tr ' ' '\n'
    fi
    ;;
  'compose exec -T archive-worker lsblk --json --output PATH,TYPE,MODEL,SERIAL')
    printf '%s\n' "$LSBLK_JSON"
    ;;
  'compose logs --since 10m --no-color web archive-worker encode-worker'|'compose logs --tail 200 --timestamps web archive-worker encode-worker')
    printf '%s\n' "${LOG_OUTPUT:-}"
    ;;
  'compose stop --timeout 30 archive-worker encode-worker web')
    : > "$RUNTIME_STOPPED_MARKER"
    ;;
  'compose up --detach --no-build web archive-worker encode-worker')
    rm -f "$RUNTIME_STOPPED_MARKER"
    ;;
  'compose --progress plain --profile maintenance build migrate'|'compose --progress plain --profile maintenance build backup'|'compose --progress plain --profile maintenance build web'|'compose --progress plain --profile maintenance build archive-worker'|'compose --progress plain --profile maintenance build encode-worker')
    exit 0
    ;;
  *) printf 'unexpected fake docker command: %s\n' "$*" >&2; exit 64 ;;
esac
"""
        write_executable(self.commands / "docker", docker)

        write_executable(
            self.commands / "curl",
            """#!/bin/sh
case "$*" in
  *'/api/deployment-readiness') printf '%s\n' "$READINESS_JSON" ;;
  *'/api/health') printf '{"status":"ok"}\n' ;;
  *) exit 64 ;;
esac
""",
        )
        write_executable(
            self.commands / "free",
            """#!/bin/sh
printf '              total used free shared buff/cache available\n'
printf 'Mem: 4294967296 1 1 1 1 %s\n' "${MEMORY_AVAILABLE_BYTES:-2147483648}"
""",
        )
        write_executable(
            self.commands / "df",
            """#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/root 10000000 1 %s 1%% /\n' "${ROOT_AVAILABLE_KIB:-8000000}"
printf '/dev/data 10000000 1 8000000 1%% %s\n' "${DATA_MOUNT_PATH:-/mnt/sandisk}"
""",
        )
        write_executable(
            self.commands / "systemctl",
            "#!/bin/sh\n"
            "count=0\n"
            "if [ -f \"$SYSTEMCTL_COUNT\" ]; then count=\"$(sed -n '1p' \"$SYSTEMCTL_COUNT\")\"; fi\n"
            "count=$((count + 1))\n"
            "printf '%s\\n' \"$count\" > \"$SYSTEMCTL_COUNT\"\n"
            "printf '%s' \"${SYSTEMD_FAILED:-}\"\n"
            "if [ -n \"${SYSTEMD_FAIL_AFTER:-}\" ] && [ \"$count\" -gt \"$SYSTEMD_FAIL_AFTER\" ]; then\n"
            "  exit \"${SYSTEMD_STATUS:-88}\"\n"
            "fi\n",
        )
        write_executable(
            self.commands / "flock",
            "#!/bin/sh\n"
            "if [ \"${FLOCK_CONTENDED:-0}\" = 1 ]; then exit 1; fi\n"
            "printf 'RIP_DVD_LOCKED\\n'\n"
            "cat >/dev/null\n",
        )
        write_executable(self.commands / "stat", "#!/bin/sh\nprintf '8\n'\n")
        write_executable(
            self.commands / "screen",
            """#!/bin/sh
printf 'screen|%s\n' "$*" >> "$COMMAND_CALL_LOG"
case "$1" in
  -ls) exit 1 ;;
  -DmS) exit 0 ;;
esac
""",
        )

    def run(
        self,
        *arguments: str,
        environment: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("Node.js is unavailable")
        return subprocess.run(
            [node, str(ROOT / "scripts" / "deploy.mjs"), *arguments],
            capture_output=True,
            check=False,
            cwd=ROOT,
            env={
                **self.environment,
                "PATH": f"{self.commands}:/usr/bin:/bin",
                **(environment or {}),
            },
            text=True,
        )

    @staticmethod
    def result(completed: subprocess.CompletedProcess[str]) -> dict[str, object]:
        line = next(
            line
            for line in reversed(completed.stdout.splitlines())
            if line.startswith("RIP_DVD_RESULT_JSON=")
        )
        return json.loads(line.removeprefix("RIP_DVD_RESULT_JSON="))


class DeploymentControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.harness = DeploymentControllerHarness()

    def tearDown(self) -> None:
        self.harness.cleanup()

    def plan(self, environment: dict[str, str] | None = None):
        return self.harness.run(
            "plan",
            "--config",
            str(self.harness.config),
            environment=environment,
        )

    def test_plan_refuses_dirty_host_and_repository_mismatches(self) -> None:
        dirty = self.plan({"GIT_STATUS_OUTPUT": " M compose.yaml\n"})
        self.assertEqual(
            self.harness.result(dirty)["state"], "validation_failure"
        )
        self.assertIn("local changes", dirty.stdout)

        mismatch = self.plan({"GIT_REMOTE_URL": "https://example.test/wrong.git"})
        self.assertEqual(
            self.harness.result(mismatch)["state"], "validation_failure"
        )
        self.assertIn("remote identity", mismatch.stdout)

        hostname = self.plan({"RIP_DVD_DEPLOY_HOSTNAME_OVERRIDE": "wrong-host"})
        self.assertEqual(
            self.harness.result(hostname)["state"], "validation_failure"
        )
        self.assertIn("host identity", hostname.stdout)

        repository = self.plan({"GIT_REPOSITORY_ROOT": "/tmp/wrong-repository"})
        self.assertEqual(
            self.harness.result(repository)["state"], "validation_failure"
        )
        self.assertIn("root identity", repository.stdout)

    def test_plan_refuses_to_overwrite_state_during_an_active_run(self) -> None:
        self.harness.state.mkdir()
        status = self.harness.state / "status.json"
        status.write_text('{"phase":"apply","message":"still running"}\n')
        owner = self.harness.state / "run.lock.owner.json"
        owner.write_text(
            json.dumps({"pid": os.getpid(), "runId": "active-run"})
        )

        result = self.plan({"FLOCK_CONTENDED": "1"})

        self.assertEqual(result.returncode, 26)
        self.assertEqual(self.harness.result(result)["state"], "concurrent_run")
        self.assertEqual(
            status.read_text(),
            '{"phase":"apply","message":"still running"}\n',
        )

    def test_plan_ignores_stale_owner_metadata_when_os_lock_is_free(self) -> None:
        self.harness.state.mkdir()
        owner = self.harness.state / "run.lock.owner.json"
        owner.write_text('{"pid":999999,"runId":"interrupted-recovery"}\n')

        result = self.plan()

        self.assertNotEqual(result.returncode, 26)
        self.assertFalse(owner.exists())

    def test_apply_contention_does_not_overwrite_active_run_status(self) -> None:
        self.plan()
        status = self.harness.state / "status.json"
        status.write_text('{"phase":"apply","message":"still running"}\n')

        result = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={"FLOCK_CONTENDED": "1"},
        )

        self.assertEqual(result.returncode, 26)
        self.assertEqual(self.harness.result(result)["state"], "concurrent_run")
        self.assertEqual(
            status.read_text(),
            '{"phase":"apply","message":"still running"}\n',
        )

    def test_review_classifier_fails_closed_beyond_bundle_file_limit(self) -> None:
        planned = self.plan({"GIT_CHANGE_KIND": "many"})

        self.assertEqual(planned.returncode, 21)
        payload = self.harness.result(planned)
        self.assertEqual(payload["state"], "review_required")
        self.assertIn("deployment_or_recovery", payload["details"]["reasons"])
        self.assertIn("review_bundle_limit_exceeded", payload["details"]["reasons"])

    def test_plan_blocks_active_disc_work_before_checkout_changes(self) -> None:
        readiness = {
            **self.harness.readiness,
            "activeWork": [
                {"kind": "encode_job", "id": "encode-7", "status": "running"}
            ],
        }
        result = self.plan({"READINESS_JSON": json.dumps(readiness)})

        self.assertEqual(result.returncode, 20)
        payload = self.harness.result(result)
        self.assertEqual(payload["state"], "active_work")
        self.assertFalse(self.harness.head.exists())

    def test_plan_fails_closed_on_invalid_readiness_evidence(self) -> None:
        result = self.plan({"READINESS_JSON": '{"status":"error"}'})

        self.assertEqual(result.returncode, 10)
        self.assertEqual(
            self.harness.result(result)["state"], "validation_failure"
        )
        self.assertFalse(self.harness.head.exists())

    def test_apply_requires_explicit_active_work_authorization(self) -> None:
        readiness = {
            **self.harness.readiness,
            "activeWork": [
                {"kind": "archive_job", "id": "archive-9", "status": "running"}
            ],
        }
        active_environment = {"READINESS_JSON": json.dumps(readiness)}
        self.plan(active_environment)

        blocked = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment=active_environment,
        )
        self.assertEqual(self.harness.result(blocked)["state"], "active_work")
        self.assertFalse(self.harness.head.exists())

        authorized = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            "--allow-active-work",
            environment=active_environment,
        )
        payload = self.harness.result(authorized)
        self.assertEqual(payload["state"], "success")
        self.assertEqual(
            payload["details"]["backup"],
            {"filename": "rip-dvd-test.sqlite", "sizeBytes": 8},
        )

    def test_plan_rejects_ancestry_and_resource_failures(self) -> None:
        ancestry = self.plan({"GIT_ANCESTRY_FAIL": "1"})
        self.assertEqual(
            self.harness.result(ancestry)["state"], "validation_failure"
        )
        shortage = self.plan({"ROOT_AVAILABLE_KIB": "100"})
        self.assertEqual(
            self.harness.result(shortage)["state"], "validation_failure"
        )
        self.assertIn("build space", shortage.stdout)

    def test_plan_rejects_invalid_resource_configuration_and_evidence(self) -> None:
        config = json.loads(self.harness.config.read_text())
        config["storagePaths"] = ["/mnt/sandisk"]
        self.harness.config.write_text(json.dumps(config))
        missing_root = self.plan()
        self.assertEqual(
            self.harness.result(missing_root)["state"], "validation_failure"
        )

        config["storagePaths"] = ["/", "/mnt/sandisk"]
        config["minimumRootFreeBytes"] = -1
        self.harness.config.write_text(json.dumps(config))
        negative = self.plan()
        self.assertEqual(
            self.harness.result(negative)["state"], "validation_failure"
        )

        config["minimumRootFreeBytes"] = 1
        self.harness.config.write_text(json.dumps(config))
        malformed = self.plan({"ROOT_AVAILABLE_KIB": "not-a-number"})
        self.assertEqual(
            self.harness.result(malformed)["state"], "validation_failure"
        )

    def test_plan_requires_unique_expected_drive_identities(self) -> None:
        config = json.loads(self.harness.config.read_text())
        config["expectedDrives"] = []
        self.harness.config.write_text(json.dumps(config))
        empty = self.plan()
        self.assertEqual(
            self.harness.result(empty)["state"], "validation_failure"
        )

        config["expectedDrives"] = [
            {"serialNumber": "SERIAL-A", "applicationId": "drive-a"},
            {"serialNumber": "SERIAL-A", "applicationId": "drive-b"},
        ]
        self.harness.config.write_text(json.dumps(config))
        duplicate = self.plan()
        self.assertEqual(
            self.harness.result(duplicate)["state"], "validation_failure"
        )

    def test_plan_requires_authoritative_drive_id_and_serial_pairs(self) -> None:
        config = json.loads(self.harness.config.read_text())
        config["expectedDrives"] = [
            {"serialNumber": "SERIAL-A", "applicationId": "drive-b"},
            {"serialNumber": "SERIAL-B", "applicationId": "drive-a"},
        ]
        self.harness.config.write_text(json.dumps(config))

        swapped = self.plan()

        self.assertEqual(
            self.harness.result(swapped)["state"], "validation_failure"
        )
        self.assertFalse(self.harness.head.exists())

    def test_risky_plan_requires_sha_bound_review_approval(self) -> None:
        planned = self.plan({"GIT_CHANGE_KIND": "risky"})
        self.assertEqual(planned.returncode, 21)
        self.assertEqual(
            self.harness.result(planned)["state"], "review_required"
        )

        blocked = self.harness.run("apply", "--target", TARGET_COMMIT)
        self.assertEqual(blocked.returncode, 21)
        self.assertFalse(self.harness.head.exists())

        approved = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            "--approve-review",
            TARGET_COMMIT,
        )
        self.assertEqual(self.harness.result(approved)["state"], "success")

    def test_apply_rejects_target_movement_before_head_changes(self) -> None:
        planned = self.plan()
        self.assertEqual(self.harness.result(planned)["state"], "planned")
        applied = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={"GIT_MOVE_TARGET": "1"},
        )

        self.assertEqual(applied.returncode, 22)
        self.assertEqual(self.harness.result(applied)["state"], "stale_plan")
        self.assertFalse(self.harness.head.exists())

    def test_apply_reports_pre_and_post_migration_failures(self) -> None:
        self.plan()
        build = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={
                "DOCKER_FAIL_MATCH": (
                    "compose --progress plain --profile maintenance build web"
                ),
                "DOCKER_FAIL_STATUS": "72",
            },
        )
        self.assertEqual(
            self.harness.result(build)["state"], "pre_migration_failure"
        )

        self.harness.head.unlink(missing_ok=True)
        migration = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={
                "DOCKER_FAIL_MATCH": (
                    "compose --profile maintenance run --rm --no-deps migrate"
                ),
                "DOCKER_FAIL_STATUS": "73",
                "CORRUPT_STAGE_ON_FAILURE": "1",
            },
        )
        self.assertEqual(
            self.harness.result(migration)["state"], "post_migration_failure"
        )
        self.assertTrue(
            self.harness.result(migration)["details"]["containment"]["verified"]
        )

        self.harness.head.unlink(missing_ok=True)
        startup = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={
                "DOCKER_FAIL_MATCH": (
                    "compose up --detach --no-build web archive-worker "
                    "encode-worker"
                ),
                "DOCKER_FAIL_STATUS": "74",
            },
        )
        self.assertEqual(
            self.harness.result(startup)["state"], "post_migration_failure"
        )
        self.assertTrue(
            self.harness.result(startup)["details"]["containment"]["verified"]
        )

    def test_quiescence_failure_reports_unverified_containment(self) -> None:
        self.plan()
        applied = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={
                "DOCKER_FAIL_MATCH": "compose stop --timeout 30",
                "DOCKER_FAIL_STATUS": "75",
            },
        )

        payload = self.harness.result(applied)
        self.assertEqual(payload["state"], "post_migration_failure")
        self.assertFalse(payload["details"]["containment"]["verified"])

    def test_backup_verification_fails_before_head_changes(self) -> None:
        self.plan()
        applied = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={"DOCKER_SKIP_BACKUP_FILE": "1"},
        )

        self.assertEqual(
            self.harness.result(applied)["state"], "pre_migration_failure"
        )
        self.assertFalse(self.harness.head.exists())

    def test_recent_error_logs_fail_verification_without_exposing_paths(self) -> None:
        self.plan()
        applied = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={
                "LOG_OUTPUT": (
                    "fatal password: colon-secret Authorization: Basic basic-secret at "
                    "/mnt/sandisk/private/movie.iso"
                )
            },
        )

        self.assertEqual(
            self.harness.result(applied)["state"], "verification_failure"
        )
        self.assertNotIn("colon-secret", applied.stdout)
        self.assertNotIn("basic-secret", applied.stdout)
        self.assertNotIn("private/movie.iso", applied.stdout)

    def test_verification_commands_fail_closed_and_stop_runtime(self) -> None:
        self.plan()
        systemd = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={"SYSTEMD_FAIL_AFTER": "2", "SYSTEMD_STATUS": "88"},
        )
        systemd_payload = self.harness.result(systemd)
        self.assertEqual(systemd_payload["state"], "verification_failure")
        self.assertTrue(systemd_payload["details"]["containment"]["verified"])

        self.harness.head.unlink(missing_ok=True)
        self.harness.runtime_stopped.unlink(missing_ok=True)
        self.plan()
        logs = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={
                "DOCKER_FAIL_MATCH": "compose logs --since 10m",
                "DOCKER_FAIL_STATUS": "89",
            },
        )
        logs_payload = self.harness.result(logs)
        self.assertEqual(logs_payload["state"], "verification_failure")
        self.assertTrue(logs_payload["details"]["containment"]["verified"])

    def test_exact_commit_enforcement_and_drive_mismatch_blocking(self) -> None:
        self.plan()
        wrong_commit = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={"GIT_DEPLOYED_COMMIT": "4" * 40},
        )
        self.assertEqual(
            self.harness.result(wrong_commit)["state"], "pre_migration_failure"
        )

        self.harness.head.unlink(missing_ok=True)
        mismatched_lsblk = json.dumps(
            {
                "blockdevices": [
                    {
                        "path": "/dev/sr1",
                        "type": "rom",
                        "model": "Drive A",
                        "serial": "WRONG",
                    }
                ]
            }
        )
        mismatch = self.harness.run(
            "apply",
            "--target",
            TARGET_COMMIT,
            environment={"LSBLK_JSON": mismatched_lsblk},
        )
        self.assertEqual(
            self.harness.result(mismatch)["state"], "validation_failure"
        )
        self.assertFalse(self.harness.head.exists())

    def test_status_emits_a_bounded_stable_json_contract(self) -> None:
        self.plan()
        status = self.harness.run("status")
        payload = self.harness.result(status)

        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(payload["command"], "status")
        self.assertEqual(payload["state"], "planned")
        self.assertEqual(payload["targetCommit"], TARGET_COMMIT)
        self.assertLess(len(json.dumps(payload).encode()), 65_536)

    def test_every_command_failure_and_help_emit_json(self) -> None:
        missing = self.harness.run("apply", "--target", TARGET_COMMIT)
        self.assertEqual(missing.returncode, 10)
        self.assertEqual(
            self.harness.result(missing)["state"], "validation_failure"
        )

        help_result = self.harness.run("help")
        self.assertEqual(help_result.returncode, 0)
        self.assertEqual(self.harness.result(help_result)["state"], "success")

    def test_structured_results_redact_credentials_and_media_paths(self) -> None:
        remote = self.plan(
            {
                "GIT_REMOTE_URL": (
                    "https://deploy-user:token-secret@github.com/other/repo.git"
                )
            }
        )
        self.assertEqual(self.harness.result(remote)["state"], "validation_failure")
        self.assertNotIn("token-secret", remote.stdout)

        config = json.loads(self.harness.config.read_text())
        config["storagePaths"] = ["/", "/srv/private-library"]
        self.harness.config.write_text(json.dumps(config))
        storage_environment = {"DATA_MOUNT_PATH": "/srv/private-library"}
        self.plan(storage_environment)
        diagnostics = self.harness.run(
            "diagnostics", environment=storage_environment
        )
        self.assertEqual(self.harness.result(diagnostics)["state"], "success")
        self.assertNotIn("/srv/private-library", diagnostics.stdout)
