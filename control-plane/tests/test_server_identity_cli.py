#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI_PATH = ROOT / "bin" / "server-identity"


class ServerIdentityCompatibilityCliTests(unittest.TestCase):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(CLI_PATH), *args],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_list_uses_global_agent_knowledge_store(self) -> None:
        result = self.run_cli("list")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("jp001", result.stdout)

    def test_get_jd001_reassigned_machine(self) -> None:
        result = self.run_cli("get", "jd001", "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        machine = json.loads(result.stdout)
        self.assertEqual(machine["alias"], "jd001")
        self.assertIn("pub117", machine["aliases"])
        self.assertEqual(machine["public_ip"], "117.72.151.207")

    def test_render_ssh_config(self) -> None:
        result = self.run_cli("render-ssh-config")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Generated from agent-knowledge-stack", result.stdout)
        self.assertIn("Host", result.stdout)


if __name__ == "__main__":
    unittest.main()
