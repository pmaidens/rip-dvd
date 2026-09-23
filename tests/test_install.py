import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class InstallScriptTests(unittest.TestCase):
    def test_install_script_creates_json_cli_wrapper(self):
        with tempfile.TemporaryDirectory() as temp:
            temporary = Path(temp)
            bin_dir = temporary / "bin"
            command_log = temporary / "docker-command"
            input_log = temporary / "docker-input"
            docker = temporary / "docker"
            docker.write_text(
                "#!/bin/sh\n"
                "if [ \"$*\" = 'compose version' ]; then exit 0; fi\n"
                "printf '%s\\n%s\\n' \"$PWD\" \"$*\" > \"$COMMAND_LOG\"\n"
                "cat > \"$INPUT_LOG\"\n"
                "printf '{\"schemaVersion\":1,\"usage\":\"rip-dvd <command>\"}\\n'\n",
                encoding="utf-8",
            )
            docker.chmod(0o755)
            environment = {
                **os.environ,
                "COMMAND_LOG": str(command_log),
                "INPUT_LOG": str(input_log),
                "PATH": f"{temporary}:/usr/bin:/bin",
            }

            install = subprocess.run(
                [str(ROOT / "install.sh"), "--bin-dir", str(bin_dir)],
                env=environment,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )

            wrapper = bin_dir / "rip-dvd"
            self.assertTrue(wrapper.exists())
            self.assertTrue(os.access(wrapper, os.X_OK))
            self.assertIn(str(wrapper), install.stdout)

            help_result = subprocess.run(
                [str(wrapper)],
                cwd=temporary,
                env=environment,
                input='{"example":"stdin passes through"}\n',
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            self.assertEqual(
                json.loads(help_result.stdout),
                {"schemaVersion": 1, "usage": "rip-dvd <command>"},
            )
            self.assertEqual(
                command_log.read_text(encoding="utf-8").splitlines(),
                [
                    str(ROOT),
                    "compose --profile maintenance run --rm --no-deps --no-TTY operator-cli",
                ],
            )
            self.assertEqual(
                input_log.read_text(encoding="utf-8"),
                '{"example":"stdin passes through"}\n',
            )


if __name__ == "__main__":
    unittest.main()
