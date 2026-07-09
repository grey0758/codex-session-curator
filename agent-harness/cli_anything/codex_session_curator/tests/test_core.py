from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

from cli_anything.codex_session_curator._cli import main
from cli_anything.codex_session_curator.core.sessions import filter_sessions
from cli_anything.codex_session_curator.core import sessions as session_core
from cli_anything.codex_session_curator.utils import _backend


class CoreTests(unittest.TestCase):
    def test_state_sessions_loads_cached_evaluations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "keptIds": ["abc"],
                        "deletedIds": [],
                        "titles": {"abc": "Custom Title"},
                        "evaluations": {
                            "abc": {
                                "title": "Original",
                                "summary": "NewAPI deployment work",
                                "recommendation": "keep",
                                "status": "ok",
                                "model": "minimaxai/minimax-m2.7",
                                "cwd": "/home/grey/work/demo",
                                "updatedAt": "2026-05-08T00:00:00Z",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            sessions = _backend.state_sessions(_backend.load_state(state_path))
        self.assertEqual(sessions[0]["id"], "abc")
        self.assertEqual(sessions[0]["title"], "Custom Title")
        self.assertTrue(sessions[0]["kept"])

    def test_filter_sessions_matches_keywords(self) -> None:
        sessions = [
            {"id": "1", "title": "Alpha", "summary": "nothing", "recommendation": "review", "updatedAt": "2"},
            {"id": "2", "title": "Beta", "summary": "NewAPI fix", "recommendation": "keep", "updatedAt": "3"},
        ]
        result = filter_sessions(sessions, query="newapi", recommendation="keep")
        self.assertEqual([item["id"] for item in result], ["2"])

    def test_cli_sessions_json_uses_fallback_state(self) -> None:
        runner = CliRunner()
        state = {
            "keptIds": [],
            "deletedIds": [],
            "titles": {},
            "evaluations": {
                "abc": {
                    "title": "Cached session",
                    "summary": "Cached summary",
                    "recommendation": "review",
                    "status": "ok",
                    "model": "gpt-5.4",
                    "updatedAt": "2026-05-08T00:00:00Z",
                }
            },
        }
        with patch.dict(os.environ, {"CURATOR_BASE_URL": "http://127.0.0.1:1"}, clear=False):
            with patch.object(_backend, "load_state", return_value=state):
                result = runner.invoke(main, ["sessions", "--json", "--limit", "1"])
        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertEqual(payload["source"], "state")
        self.assertEqual(payload["sessions"][0]["id"], "abc")

    def test_resume_job_template_is_sent_as_template(self) -> None:
        with patch.object(session_core, "request_json", return_value={"job": {"id": "job-1"}}) as request_json:
            payload = session_core.start_resume_job("session-1", "do work", template="review")
        self.assertEqual(payload["job"]["id"], "job-1")
        self.assertEqual(request_json.call_args.kwargs["body"]["template"], "review")

    def test_dispatch_template_is_sent_as_template(self) -> None:
        with patch.object(session_core, "request_json", return_value={"status": "dispatched"}) as request_json:
            payload = session_core.dispatch_to_codex("find work", template="review")
        self.assertEqual(payload["status"], "dispatched")
        self.assertEqual(request_json.call_args.kwargs["body"]["template"], "review")

    def test_dispatch_policy_profile_is_sent_as_backend_policy(self) -> None:
        runner = CliRunner()
        with patch("cli_anything.codex_session_curator._cli.dispatch_to_codex", return_value={"job": {"id": "job-1"}}) as dispatch:
            result = runner.invoke(
                main,
                [
                    "dispatch-to-codex",
                    "run tests",
                    "--policy-profile",
                    "test_only",
                    "--policy",
                    '{"maxRuntimeMs": 1234}',
                    "--json",
                ],
            )
        self.assertEqual(result.exit_code, 0, result.output)
        policy = dispatch.call_args.kwargs["policy"]
        self.assertFalse(policy["allowDeploy"])
        self.assertFalse(policy["allowDeletes"])
        self.assertTrue(policy["autoStop"])
        self.assertEqual(policy["maxRuntimeMs"], 1234)
        self.assertIn("git push", policy["blockedCommands"])

    def test_dispatch_defaults_to_pty_mode(self) -> None:
        runner = CliRunner()
        with patch("cli_anything.codex_session_curator._cli.dispatch_to_codex", return_value={"job": {"id": "job-1"}}) as dispatch:
            result = runner.invoke(main, ["dispatch-to-codex", "continue work", "--json"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(dispatch.call_args.kwargs["mode"], "pty")
        self.assertEqual(
            dispatch.call_args.kwargs["supervisor"],
            {"autoStop": True, "autoRetry": False, "staleOutputMs": 120000},
        )

    def test_resume_job_human_output_shows_tmux_hint(self) -> None:
        runner = CliRunner()
        payload = {"job": {"id": "job-1", "status": "running", "sessionId": "session-1", "mode": "pty", "cwd": "/tmp/demo", "tmuxName": "codex-job-1"}}
        with patch("cli_anything.codex_session_curator._cli.start_resume_job", return_value=payload):
            result = runner.invoke(main, ["resume-job", "session-1", "do work"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("tmux attach-session -t codex-job-1", result.output)
        self.assertIn("guide-job <job-id>", result.output)

    def test_get_job_outcome_falls_back_to_job_payload(self) -> None:
        job_payload = {
            "job": {
                "id": "job-1",
                "sessionId": "session-1",
                "status": "completed",
                "cwd": "/tmp/demo",
                "exitCode": 0,
                "signal": None,
                "changedFiles": ["app.py"],
                "structuredReport": {"status": "done", "tests": ["pytest"], "nextAction": "ship"},
                "policyState": {"violations": []},
                "outputTail": "done",
            }
        }
        with patch.object(session_core, "request_json", side_effect=[_backend.BackendError("404"), job_payload]):
            payload = session_core.get_job_outcome("job-1")
        self.assertEqual(payload["source"], "job")
        self.assertEqual(payload["status"], "done")
        self.assertEqual(payload["tests"], ["pytest"])

    def test_get_messages_uses_backend_messages_endpoint(self) -> None:
        with patch.object(session_core, "request_json", return_value={"messages": [{"index": 0, "role": "user", "text": "hi"}]}) as request_json:
            payload = session_core.get_messages("session-1", full=True, preserve=True)
        self.assertEqual(payload["messages"][0]["text"], "hi")
        self.assertEqual(request_json.call_args.args[0], "/api/sessions/session-1/messages")
        self.assertEqual(request_json.call_args.kwargs["params"]["full"], "1")
        self.assertEqual(request_json.call_args.kwargs["params"]["preserve"], "1")

    def test_get_messages_falls_back_to_local_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            session_path = Path(tmp) / "rollout-2026-05-18T00-00-00-session-1.jsonl"
            session_path.write_text(
                "\n".join(
                    [
                        json.dumps({"type": "session_meta", "payload": {"id": "session-1"}}),
                        json.dumps(
                            {
                                "timestamp": "2026-05-18T00:00:00Z",
                                "type": "response_item",
                                "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello\nworld"}]},
                            }
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-05-18T00:00:01Z",
                                "type": "response_item",
                                "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "answer"}]},
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )
            state = {
                "keptIds": [],
                "deletedIds": [],
                "titles": {},
                "evaluations": {"session-1": {"title": "Cached", "summary": "s", "filePath": str(session_path)}},
            }
            with patch.object(session_core, "request_json", side_effect=_backend.BackendError("offline")):
                with patch.object(_backend, "load_state", return_value=state):
                    payload = session_core.get_messages("session-1", full=True, preserve=True)
        self.assertEqual(payload["source"], "state")
        self.assertEqual(payload["totalMessages"], 2)
        self.assertEqual(payload["messages"][0]["text"], "hello\nworld")

    def test_outcome_command_prints_job_outcome(self) -> None:
        runner = CliRunner()
        payload = {"source": "job", "kind": "job", "jobId": "job-1", "status": "completed", "changedFiles": ["app.py"]}
        with patch("cli_anything.codex_session_curator._cli.get_job_outcome", return_value=payload):
            result = runner.invoke(main, ["outcome", "job-1", "--kind", "job"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("status: completed", result.output)
        self.assertIn("app.py", result.output)

    def test_job_events_prints_message_and_data(self) -> None:
        runner = CliRunner()
        payload = {
            "events": [
                {
                    "seq": 1,
                    "type": "supervisor",
                    "message": "Needs guidance",
                    "data": {"decision": "needs_guidance", "score": 42},
                }
            ]
        }
        with patch("cli_anything.codex_session_curator._cli.get_job_events", return_value=payload):
            result = runner.invoke(main, ["job-events", "job-1"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("1 | supervisor", result.output)
        self.assertIn("Needs guidance", result.output)
        self.assertIn('"decision": "needs_guidance"', result.output)

    def test_job_events_stream_polls_until_completed(self) -> None:
        runner = CliRunner()
        payload = {
            "events": [{"seq": 1, "type": "completion", "message": "Done", "data": {"exitCode": 0}}],
            "job": {"status": "completed"},
        }
        with patch("cli_anything.codex_session_curator._cli.get_job_events", return_value=payload) as get_events:
            result = runner.invoke(main, ["job-events-stream", "job-1", "--interval", "0.1"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("Done", result.output)
        get_events.assert_called_once_with("job-1", after_seq=0)


if __name__ == "__main__":
    unittest.main()
