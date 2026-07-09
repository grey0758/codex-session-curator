from __future__ import annotations

import json
import subprocess
import sys
import unittest


class FullE2ETests(unittest.TestCase):
    def test_module_status_json_runs(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "cli_anything.codex_session_curator", "status", "--json"],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn("source", payload)

    def test_repl_help_and_exit(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "cli_anything.codex_session_curator"],
            input="help\nexit\n",
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("commands:", result.stdout)


if __name__ == "__main__":
    unittest.main()
