#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import importlib.machinery
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


CLI_PATH = Path(__file__).resolve().parents[1] / "bin" / "curator"


def load_cli():
    loader = importlib.machinery.SourceFileLoader("curator_cli", str(CLI_PATH))
    spec = importlib.util.spec_from_loader("curator_cli", loader)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CuratorCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cli = load_cli()

    def test_env_file_parser(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "auth.env"
            path.write_text("CURATOR_ADMIN_TOKEN='secret-token'\nOTHER=value\n", encoding="utf-8")
            self.assertEqual(self.cli.read_env_file(path)["CURATOR_ADMIN_TOKEN"], "secret-token")

    def test_query_includes_token_without_printing_it(self) -> None:
        old_token = os.environ.get("CURATOR_ADMIN_TOKEN")
        old_base = os.environ.get("CURATOR_BASE_URL")
        os.environ["CURATOR_ADMIN_TOKEN"] = "secret-token"
        os.environ["CURATOR_BASE_URL"] = "http://example.test"
        try:
            url = self.cli.with_query("/api/test", {"q": "hello world"})
        finally:
            if old_token is None:
                os.environ.pop("CURATOR_ADMIN_TOKEN", None)
            else:
                os.environ["CURATOR_ADMIN_TOKEN"] = old_token
            if old_base is None:
                os.environ.pop("CURATOR_BASE_URL", None)
            else:
                os.environ["CURATOR_BASE_URL"] = old_base
        self.assertIn("admin_token=secret-token", url)
        self.assertIn("q=hello+world", url)

    def test_help_exits_cleanly(self) -> None:
        with redirect_stdout(StringIO()):
            with self.assertRaises(SystemExit) as raised:
                self.cli.build_parser().parse_args(["--help"])
        self.assertEqual(raised.exception.code, 0)

    def test_direct_action_start_payload(self) -> None:
        args = self.cli.build_parser().parse_args([
            "direct-action",
            "start",
            "--kind",
            "direct-action",
            "--goal",
            "update CLI",
            "--reason",
            "control-plane maintenance",
            "--scope",
            "CLI and docs",
            "--cwd",
            "/tmp/control",
            "--target-repo",
            "/tmp/control",
        ])

        self.assertEqual(args.command, "direct-action")
        self.assertEqual(args.direct_action_command, "start")
        self.assertEqual(
            self.cli.direct_action_start_body(args),
            {
                "kind": "direct-action",
                "goal": "update CLI",
                "reason": "control-plane maintenance",
                "scope": "CLI and docs",
                "cwd": "/tmp/control",
                "targetRepo": "/tmp/control",
            },
        )

    def test_direct_action_finish_payload_splits_csv_fields(self) -> None:
        args = self.cli.build_parser().parse_args([
            "direct-action",
            "finish",
            "act-123",
            "--status",
            "completed",
            "--changed-files",
            "AGENTS.md, bin/curator",
            "--tests",
            "python -m unittest tests/test_curator_cli.py",
            "--verification",
            "payload constructed, no service call",
            "--follow-up",
            "none",
        ])

        self.assertEqual(
            self.cli.direct_action_finish_body(args),
            {
                "status": "completed",
                "changedFiles": ["AGENTS.md", "bin/curator"],
                "tests": ["python -m unittest tests/test_curator_cli.py"],
                "verification": ["payload constructed", "no service call"],
                "followUp": "none",
            },
        )

    def test_direct_action_main_posts_expected_request(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"id": "act-123"}

        self.cli.request_json = fake_request_json
        with redirect_stdout(StringIO()):
            exit_code = self.cli.main([
                "direct-action",
                "finish",
                "act-123",
                "--status",
                "blocked",
                "--changed-files",
                "bin/curator",
            ])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [
                (
                    "PATCH",
                    "/api/commander-actions/act-123",
                    None,
                    {"status": "blocked", "changedFiles": ["bin/curator"]},
                )
            ],
        )

    def test_direct_action_list_uses_collection_endpoint(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"actions": []}

        self.cli.request_json = fake_request_json
        with redirect_stdout(StringIO()):
            exit_code = self.cli.main(["direct-action", "list"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(calls, [("GET", "/api/commander-actions", None, None)])

    def test_session_index_uses_hermes_index_endpoint(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"sessions": []}

        self.cli.request_json = fake_request_json
        with redirect_stdout(StringIO()):
            exit_code = self.cli.main(["session-index", "curator", "--limit", "12", "--no-remote"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [("GET", "/api/hermes/session-index", {"q": "curator", "limit": 12, "remote": "0"}, None)],
        )

    def test_dispatch_payload_includes_project_context(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"status": "started"}

        self.cli.request_json = fake_request_json
        with redirect_stdout(StringIO()):
            exit_code = self.cli.main([
                "dispatch",
                "fix curator knowledge search",
                "--cwd",
                "/home/grey/work/codex-control-plane",
                "--repo",
                "/home/grey/data/apps/codex-session-curator",
                "--limit",
                "6",
                "--no-remote",
            ])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [
                (
                    "POST",
                    "/api/hermes/dispatch",
                    {"remote": "0"},
                    {
                        "query": "fix curator knowledge search",
                        "cwd": "/home/grey/work/codex-control-plane",
                        "repo": "/home/grey/data/apps/codex-session-curator",
                        "limit": 6,
                        "mode": "exec",
                    },
                )
            ],
        )

    def test_context_forwards_composite_session_identity(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"contextText": "remote context"}

        self.cli.request_json = fake_request_json
        with redirect_stdout(StringIO()):
            exit_code = self.cli.main([
                "context",
                "shared-session",
                "--history-limit",
                "7",
                "--machine",
                "sgp001",
                "--agent",
                "claude",
            ])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [(
                "GET",
                "/api/hermes/sessions/shared-session/context",
                {"historyLimit": 7, "machineId": "sgp001", "agent": "claude"},
                None,
            )],
        )

    def test_context_legacy_fallback_rejects_agent_identity(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            raise self.cli.CuratorError("HTTP 410: gone")

        self.cli.request_json = fake_request_json
        with self.assertRaisesRegex(
            self.cli.CuratorError,
            "legacy context fallback cannot guarantee agent identity",
        ):
            self.cli.fetch_session_context(
                "shared-session",
                5,
                "gpl001",
                "claude",
            )

        self.assertEqual(
            calls,
            [(
                "GET",
                "/api/hermes/sessions/shared-session/context",
                {"historyLimit": 5, "machineId": "gpl001", "agent": "claude"},
                None,
            )],
        )

    def test_dispatch_payload_includes_composite_session_identity(self) -> None:
        args = self.cli.build_parser().parse_args([
            "dispatch",
            "continue remote work",
            "--session-id",
            "shared-session",
            "--machine",
            "sgp001",
            "--agent",
            "codex",
        ])

        self.assertEqual(self.cli.dispatch_body(args)["sessionId"], "shared-session")
        self.assertEqual(self.cli.dispatch_body(args)["machineId"], "sgp001")
        self.assertEqual(self.cli.dispatch_body(args)["agent"], "codex")

    def test_resume_payload_includes_composite_session_identity(self) -> None:
        args = self.cli.build_parser().parse_args([
            "resume",
            "shared-session",
            "continue the task",
            "--machine",
            "sgp001",
            "--agent",
            "claude",
        ])

        self.assertEqual(
            {
                key: self.cli.resume_body(args)[key]
                for key in ("sessionId", "machineId", "agent")
            },
            {
                "sessionId": "shared-session",
                "machineId": "sgp001",
                "agent": "claude",
            },
        )

    def test_job_read_commands_forward_complete_identity_or_allow_none(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {}

        identity = [
            "--machine-id", "sgp001",
            "--agent", "claude",
            "--session-id", "shared-session",
        ]
        cases = [
            (
                ["job", "job/one", *identity, "--json"],
                ("GET", "/api/hermes/jobs/job%2Fone", {
                    "machineId": "sgp001",
                    "agent": "claude",
                    "sessionId": "shared-session",
                }, None),
            ),
            (
                ["events", "job/one", "--after-seq", "7", "--no-remote", *identity],
                ("GET", "/api/hermes/jobs/job%2Fone/events", {
                    "afterSeq": 7,
                    "remote": "0",
                    "machineId": "sgp001",
                    "agent": "claude",
                    "sessionId": "shared-session",
                }, None),
            ),
            (
                ["outcome", "job/one", *identity],
                ("GET", "/api/hermes/jobs/job%2Fone/outcome", {
                    "machineId": "sgp001",
                    "agent": "claude",
                    "sessionId": "shared-session",
                }, None),
            ),
            (
                ["job", "job-one", "--json"],
                ("GET", "/api/hermes/jobs/job-one", None, None),
            ),
            (
                ["events", "job-one"],
                ("GET", "/api/hermes/jobs/job-one/events", {
                    "afterSeq": 0,
                    "remote": None,
                }, None),
            ),
            (
                ["outcome", "job-one"],
                ("GET", "/api/hermes/jobs/job-one/outcome", None, None),
            ),
        ]

        self.cli.request_json = fake_request_json
        for argv, expected in cases:
            with self.subTest(argv=argv), redirect_stdout(StringIO()):
                calls.clear()
                self.assertEqual(self.cli.main(argv), 0)
                self.assertEqual(calls, [expected])

    def test_job_read_commands_reject_partial_identity(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {}

        self.cli.request_json = fake_request_json
        for command in ("job", "events", "outcome"):
            with self.subTest(command=command), redirect_stderr(StringIO()):
                self.assertEqual(
                    self.cli.main([command, "job-one", "--machine-id", "sgp001"]),
                    1,
                )
                self.assertEqual(calls, [])

    def test_job_mutations_forward_required_composite_identity(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {}

        identity = [
            "--machine-id", "sgp001",
            "--agent", "codex",
            "--session-id", "shared-session",
        ]
        params = {
            "machineId": "sgp001",
            "agent": "codex",
            "sessionId": "shared-session",
        }
        cases = [
            (
                ["stop", "job/one", *identity, "--json"],
                ("POST", "/api/hermes/jobs/job%2Fone/stop", params, {}),
            ),
            (
                ["guide", "job/one", "stay scoped", *identity, "--json"],
                ("POST", "/api/hermes/jobs/job%2Fone/guidance", params, {
                    "text": "stay scoped",
                    "source": "api",
                }),
            ),
            (
                ["protocol", "job/one", "verify", "run checks", *identity],
                ("POST", "/api/hermes/jobs/job%2Fone/protocol", params, {
                    "kind": "verify",
                    "text": "run checks",
                }),
            ),
            (
                ["supervise", "job/one", "--auto-retry", *identity],
                ("POST", "/api/hermes/jobs/job%2Fone/supervise", params, {
                    "autoRetry": True,
                }),
            ),
        ]

        self.cli.request_json = fake_request_json
        for argv, expected in cases:
            with self.subTest(argv=argv), redirect_stdout(StringIO()):
                calls.clear()
                self.assertEqual(self.cli.main(argv), 0)
                self.assertEqual(calls, [expected])

    def test_job_mutations_require_complete_identity(self) -> None:
        cases = [
            ["stop", "job-one"],
            ["guide", "job-one", "stay scoped"],
            ["protocol", "job-one", "verify"],
            ["supervise", "job-one"],
        ]
        for argv in cases:
            with self.subTest(argv=argv), redirect_stderr(StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    self.cli.build_parser().parse_args(argv)
                self.assertEqual(raised.exception.code, 2)

    def test_knowledge_search_uses_expected_endpoint_and_params(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"results": []}

        self.cli.request_json = fake_request_json
        with redirect_stdout(StringIO()):
            exit_code = self.cli.main([
                "knowledge-search",
                "resume policy",
                "--type",
                "preference",
                "--type",
                "runbook",
                "--project",
                "codex-control-plane",
                "--repo",
                "/home/grey/work/codex-control-plane",
                "--limit",
                "7",
            ])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [
                (
                    "GET",
                    "/api/hermes/knowledge-search",
                    {
                        "q": "resume policy",
                        "type": ["preference", "runbook"],
                        "project": "codex-control-plane",
                        "repo": "/home/grey/work/codex-control-plane",
                        "limit": 7,
                    },
                    None,
                )
            ],
        )

    def test_context_pack_uses_expected_endpoint_and_params(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"context": ""}

        self.cli.request_json = fake_request_json
        with redirect_stdout(StringIO()):
            exit_code = self.cli.main([
                "context-pack",
                "CLI strategy",
                "--cwd",
                "/home/grey/work/codex-control-plane",
                "--repo",
                "/home/grey/work/codex-control-plane",
                "--limit",
                "9",
                "--no-remote",
            ])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [
                (
                    "GET",
                    "/api/hermes/context-pack",
                    {
                        "q": "CLI strategy",
                        "cwd": "/home/grey/work/codex-control-plane",
                        "repo": "/home/grey/work/codex-control-plane",
                        "limit": 9,
                        "remote": "0",
                    },
                    None,
                )
            ],
        )

    def test_knowledge_proposal_overlay_packages_only_changed_files(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None, extra_headers=None):
            calls.append((method, path, params, body, extra_headers))
            return {
                "proposal": {
                    "id": "remote-proposal-1",
                    "status": "pending",
                    "submittedAt": "2026-07-18T00:00:00Z",
                },
                "idempotent": False,
            }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "mirror"
            source = root / "knowledge" / "runbooks" / "example.md"
            (root / "skills" / "shared").mkdir(parents=True)
            source.parent.mkdir(parents=True)
            source.write_text("# Example\n\nBefore.\n", encoding="utf-8")
            (root / ".mirror-source-hash").write_text("a" * 64 + "\n", encoding="utf-8")
            (root / ".mirror-target-machine").write_text("us002\n", encoding="utf-8")
            proposal_store = Path(tmp) / "proposals"

            with patch.object(self.cli, "DEFAULT_PROPOSAL_ROOT", proposal_store):
                init_args = self.cli.build_parser().parse_args([
                    "knowledge-proposal", "init", "knowledge/runbooks/example.md",
                    "--reason", "verified update", "--local-id", "local-proposal-1",
                    "--knowledge-root", str(root), "--session-id", "session-1",
                ])
                initialized = self.cli.initialize_local_proposal(init_args)
                overlay = Path(initialized["editRoot"]) / "knowledge" / "runbooks" / "example.md"
                overlay.write_text("# Example\n\nAfter.\n", encoding="utf-8")
                self.cli.request_json = fake_request_json
                submit_args = self.cli.build_parser().parse_args([
                    "knowledge-proposal", "submit", "local-proposal-1", "--knowledge-root", str(root),
                ])
                result = self.cli.submit_local_proposal(submit_args)

        self.assertEqual(result["proposal"]["id"], "remote-proposal-1")
        self.assertEqual(len(calls), 1)
        method, path, params, body, headers = calls[0]
        self.assertEqual((method, path, params, headers), ("POST", "/api/knowledge/proposals", None, None))
        self.assertEqual(body["sourceMachineId"], "us002")
        self.assertEqual(body["baseSourceHash"], "a" * 64)
        self.assertEqual(body["changes"][0]["content"], "# Example\n\nAfter.\n")
        self.assertEqual(body["changes"][0]["operation"], "upsert")

    def test_knowledge_proposal_apply_sends_separate_capability_header(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None, extra_headers=None):
            calls.append((method, path, params, body, extra_headers))
            return {"proposal": {"id": "proposal-1", "status": "applying"}}

        self.cli.request_json = fake_request_json
        with patch.object(self.cli, "get_proposal_apply_token", return_value="apply-capability-test"), redirect_stdout(StringIO()):
            exit_code = self.cli.main([
                "knowledge-proposal", "apply", "proposal-1", "--publish", "fleet", "--no-wait",
            ])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [(
                "POST",
                "/api/knowledge/proposals/proposal-1/apply",
                None,
                {"publish": "fleet"},
                {"X-Curator-Proposal-Apply-Token": "apply-capability-test"},
            )],
        )

    def test_server_identity_list_uses_expected_endpoint(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"machines": []}

        self.cli.request_json = fake_request_json
        with redirect_stdout(StringIO()):
            exit_code = self.cli.main(["server-identity", "list", "--include-deprecated"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [("GET", "/api/server-identity/machines", {"includeDeprecated": "1"}, None)],
        )

    def test_server_identity_patch_reads_json_payload(self) -> None:
        calls = []

        def fake_request_json(method, path, params=None, body=None):
            calls.append((method, path, params, body))
            return {"machine": {"alias": "jp001"}}

        self.cli.request_json = fake_request_json
        with patch("sys.stdin", StringIO('{"notes":"verified"}')), redirect_stdout(StringIO()):
            exit_code = self.cli.main(["server-identity", "patch", "jp001"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            calls,
            [
                (
                    "PATCH",
                    "/api/server-identity/machines/jp001",
                    None,
                    {"notes": "verified"},
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
