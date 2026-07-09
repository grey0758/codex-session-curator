#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MCP_PATH = ROOT / "bin" / "server-identity-mcp"


class ServerIdentityCompatibilityMcpTests(unittest.TestCase):
    def run_mcp(self, message: dict) -> dict:
        result = subprocess.run(
            [str(MCP_PATH)],
            cwd=ROOT,
            input=json.dumps(message) + "\n",
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_tools_list_uses_global_mcp(self) -> None:
        response = self.run_mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})

        self.assertEqual(response["id"], 1)
        names = [tool["name"] for tool in response["result"]["tools"]]
        self.assertEqual(
            names,
            [
                "server_identity.list_machines",
                "server_identity.get_machine",
                "server_identity.upsert_machine",
                "server_identity.render_ssh_config",
            ],
        )

    def test_get_machine_call(self) -> None:
        response = self.run_mcp(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "server_identity.get_machine", "arguments": {"alias": "jd001"}},
            }
        )

        self.assertEqual(response["id"], 2)
        text = response["result"]["content"][0]["text"]
        self.assertIn('"alias": "jd001"', text)
        self.assertIn('"pub117"', text)


if __name__ == "__main__":
    unittest.main()
