import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class InstallScriptTests(unittest.TestCase):
    def test_install_script_creates_working_wrapper(self):
        with tempfile.TemporaryDirectory() as temp:
            bin_dir = Path(temp) / "bin"

            install = subprocess.run(
                [str(ROOT / "install.sh"), "--bin-dir", str(bin_dir)],
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
                [str(wrapper), "--help"],
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            self.assertIn("join", help_result.stdout)


if __name__ == "__main__":
    unittest.main()
