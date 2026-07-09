from __future__ import annotations

import json
import os
import shlex
import sys
import time
from typing import Any

import click

from .core.sessions import (
    dispatch_to_codex,
    get_job_events,
    get_job_outcome,
    get_job_registry,
    get_hermes_context,
    get_history,
    get_messages,
    get_resume_job,
    get_session,
    get_session_outcome,
    hermes_search,
    list_sessions,
    guide_resume_job,
    send_job_protocol,
    stop_resume_job,
    supervise_resume_job,
    start_resume_job,
)
from .utils._backend import BackendError, default_base_url, default_state_path, request_json


POLICY_PROFILES: dict[str, dict[str, Any]] = {
    "read_only": {
        "allowDeploy": False,
        "allowDeletes": False,
        "autoStop": True,
        "blockedCommands": [
            "apply_patch",
            "git commit",
            "git push",
            "npm version",
            "pnpm version",
            "yarn version",
            "rm -rf",
            "mv ",
            "cp ",
        ],
    },
    "code_edit": {"allowDeploy": False, "allowDeletes": False, "autoStop": True},
    "test_only": {
        "allowDeploy": False,
        "allowDeletes": False,
        "autoStop": True,
        "blockedCommands": ["apply_patch", "git commit", "git push", "rm -rf"],
    },
    "deploy_allowed": {"allowDeploy": True, "allowDeletes": False, "autoStop": True},
    "dangerous_ops_allowed": {"allowDeploy": True, "allowDeletes": True, "autoStop": False},
}

DEFAULT_STALE_OUTPUT_MS = int(os.environ.get("CURATOR_HERMES_STALE_OUTPUT_MS", str(2 * 60 * 1000)))


def emit(payload: Any, *, as_json: bool) -> None:
    if as_json:
        click.echo(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if isinstance(payload, str):
        click.echo(payload)
        return
    click.echo(json.dumps(payload, ensure_ascii=False, indent=2))


def session_lines(payload: dict[str, Any]) -> str:
    lines = [f"source={payload.get('source')} total={payload.get('filteredTotal', payload.get('total', 0))}"]
    for session in payload.get("sessions", []):
        lines.append(
            " | ".join(
                str(item)
                for item in [
                    session.get("id"),
                    session.get("title"),
                    session.get("recommendation"),
                    session.get("status"),
                    session.get("machineId"),
                    session.get("cwd"),
                ]
                if item
            )
        )
    return "\n".join(lines)


def json_object_option(value: str | None, option_name: str) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise click.BadParameter(f"{option_name} must be a JSON object: {exc}") from exc
    if not isinstance(parsed, dict):
        raise click.BadParameter(f"{option_name} must be a JSON object")
    return parsed


def policy_option(profile: str | None, policy: str | None) -> dict[str, Any] | None:
    parsed = json_object_option(policy, "--policy") or {}
    if not profile:
        return parsed or None
    base = dict(POLICY_PROFILES[profile])
    if "blockedCommands" in base:
        base["blockedCommands"] = list(base["blockedCommands"])
    base.update(parsed)
    return base


def supervisor_option(
    enabled: bool,
    *,
    auto_stop: bool,
    auto_retry: bool,
    check_interval_ms: int | None,
    stale_output_ms: int | None,
) -> bool | dict[str, Any] | None:
    strategy: dict[str, Any] = {"autoStop": True, "autoRetry": False, "staleOutputMs": DEFAULT_STALE_OUTPUT_MS}
    if auto_stop:
        strategy["autoStop"] = True
    if auto_retry:
        strategy["autoRetry"] = True
    if check_interval_ms is not None:
        strategy["checkIntervalMs"] = check_interval_ms
    if stale_output_ms is not None:
        strategy["staleOutputMs"] = stale_output_ms
    if enabled:
        strategy["enabled"] = True
    return strategy


def format_event_data(data: Any) -> str:
    if data is None or data == "":
        return ""
    if isinstance(data, str):
        return data.strip()
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)


def format_job_event(event: dict[str, Any]) -> str:
    parts = [str(event.get("seq")), str(event.get("type"))]
    if event.get("kind"):
        parts.append(str(event.get("kind")))
    if event.get("status"):
        parts.append(str(event.get("status")))
    lines = [" | ".join(parts)]
    message = str(event.get("message") or event.get("text") or "").strip()
    if message:
        lines.append(message)
    data = format_event_data(event.get("data"))
    if data:
        lines.append(data)
    return "\n".join(lines)


def format_job_launch(payload: dict[str, Any]) -> str:
    job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    if not job:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    lines = [
        f"id: {job.get('id')}",
        f"status: {job.get('status')}",
        f"session: {job.get('sessionId')}",
        f"mode: {job.get('mode')}",
        f"cwd: {job.get('cwd')}",
    ]
    if job.get("tmuxName"):
        lines.extend(
            [
                f"tmux: tmux attach-session -t {job.get('tmuxName')}",
                "guide: use guide-job <job-id> <text> for interactive pty guidance.",
            ]
        )
    elif job.get("mode") == "pty":
        lines.append("pty: interactive worker requested; use job-events-stream <job-id> to follow output.")
    if job.get("policy"):
        lines.append(f"policy: {json.dumps(job.get('policy'), ensure_ascii=False, sort_keys=True)}")
    return "\n".join(lines)


def format_outcome(payload: dict[str, Any]) -> str:
    lines = [
        f"kind: {payload.get('kind')}",
        f"source: {payload.get('source')}",
        f"status: {payload.get('status')}",
    ]
    if payload.get("jobId"):
        lines.append(f"job: {payload.get('jobId')}")
    if payload.get("sessionId"):
        lines.append(f"session: {payload.get('sessionId')}")
    for key, label in (("changedFiles", "changed files"), ("tests", "tests"), ("policyViolations", "policy violations")):
        value = payload.get(key)
        if isinstance(value, list) and value:
            lines.append(f"{label}:")
            lines.extend(f"- {json.dumps(item, ensure_ascii=False) if isinstance(item, dict) else item}" for item in value)
    for key, label in (("nextAction", "next action"), ("error", "error"), ("contextText", "context")):
        value = payload.get(key)
        if value:
            lines.extend(["", f"{label}:", str(value)])
    if payload.get("outputTail"):
        lines.extend(["", "output tail:", str(payload.get("outputTail"))])
    return "\n".join(lines)


@click.group(invoke_without_command=True)
@click.option("--base-url", default=None, help="Curator backend URL. Defaults to CURATOR_BASE_URL or localhost.")
@click.pass_context
def main(ctx: click.Context, base_url: str | None) -> None:
    """Agent CLI for Codex Session Curator."""
    ctx.ensure_object(dict)
    ctx.obj["base_url"] = base_url
    if base_url:
        os.environ["CURATOR_BASE_URL"] = base_url
    if ctx.invoked_subcommand is None:
        repl(ctx)


@main.command()
@click.option("--json-output", "--json", "as_json", is_flag=True, help="Emit machine-readable JSON.")
@click.pass_context
def status(ctx: click.Context, as_json: bool) -> None:
    """Show backend and fallback state status."""
    base_url = ctx.obj.get("base_url") or default_base_url()
    payload: dict[str, Any] = {"baseUrl": base_url, "statePath": str(default_state_path())}
    try:
        payload["auth"] = request_json("/api/auth/status", base_url=base_url)
        payload["meta"] = request_json("/api/meta", base_url=base_url)
        payload["source"] = "api"
    except BackendError as exc:
        payload["source"] = "state"
        payload["warning"] = str(exc)
    emit(payload, as_json=as_json)


@main.command()
@click.option("--limit", default=20, show_default=True, type=int)
@click.option("--query", "-q", default=None)
@click.option("--recommendation", type=click.Choice(["all", "keep", "review", "delete"]), default=None)
@click.option("--local-only", is_flag=True, help="Do not include remote agents.")
@click.option("--detail", is_flag=True, help="Ask backend for full session details.")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def sessions(limit: int, query: str | None, recommendation: str | None, local_only: bool, detail: bool, as_json: bool) -> None:
    """List recent or matching sessions."""
    payload = list_sessions(query=query, recommendation=recommendation, limit=limit, remote=not local_only, detail=detail)
    emit(payload if as_json else session_lines(payload), as_json=as_json)


@main.command()
@click.argument("query")
@click.option("--limit", default=10, show_default=True, type=int)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def search(query: str, limit: int, as_json: bool) -> None:
    """Search sessions by title, summary, directory, tech stack, or keyword."""
    payload = list_sessions(query=query, limit=limit, remote=True, detail=False)
    emit(payload if as_json else session_lines(payload), as_json=as_json)


@main.command()
@click.argument("session_id")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def show(session_id: str, as_json: bool) -> None:
    """Show one session summary for agent context."""
    payload = get_session(session_id)
    if as_json:
        emit(payload, as_json=True)
        return
    session = payload.get("session") or {}
    lines = [
        f"id: {session.get('id')}",
        f"title: {session.get('title')}",
        f"resume: {session.get('resumeCommand')}",
        f"cwd: {session.get('cwd')}",
        f"machine: {session.get('machineId')}",
        f"recommendation: {session.get('recommendation')} status: {session.get('status')} model: {session.get('model')}",
        "",
        str(session.get("summary") or ""),
    ]
    detail = session.get("detailedSummary")
    if detail:
        lines.extend(["", str(detail)])
    emit("\n".join(lines), as_json=False)


@main.command()
@click.argument("session_id")
@click.option("--limit", default=30, show_default=True, type=int)
@click.option("--before", default=None, type=int)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def history(session_id: str, limit: int, before: int | None, as_json: bool) -> None:
    """Read a small page of transcript history from the real backend."""
    payload = get_history(session_id, limit=limit, before=before)
    if as_json:
        emit(payload, as_json=True)
        return
    lines = []
    for message in payload.get("messages", []):
        lines.append(f"[{message.get('index')}] {message.get('role')}: {message.get('text')}")
    emit("\n\n".join(lines), as_json=False)


@main.command()
@click.argument("session_id")
@click.option("--limit", default=200, show_default=True, type=int)
@click.option("--before", default=None, type=int)
@click.option("--after", default=None, type=int)
@click.option("--full", is_flag=True, help="Read all user/assistant messages from the session.")
@click.option("--preserve", is_flag=True, help="Preserve original whitespace and line breaks.")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def messages(
    session_id: str,
    limit: int,
    before: int | None,
    after: int | None,
    full: bool,
    preserve: bool,
    as_json: bool,
) -> None:
    """Read transcript messages from a Codex session by session id."""
    payload = get_messages(session_id, limit=limit, before=before, after=after, full=full, preserve=preserve)
    if as_json:
        emit(payload, as_json=True)
        return
    lines = []
    for message in payload.get("messages", []):
        lines.append(f"[{message.get('index')}] {message.get('role')} @ {message.get('timestamp') or 'unknown'}\n{message.get('text')}")
    emit("\n\n".join(lines), as_json=False)


@main.command()
@click.argument("session_id")
@click.option("--history-limit", default=12, show_default=True, type=int)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def context(session_id: str, history_limit: int, as_json: bool) -> None:
    """Build a compact context pack for another agent."""
    session_payload = get_session(session_id)
    history_payload: dict[str, Any]
    try:
        history_payload = get_history(session_id, limit=history_limit)
    except BackendError as exc:
        history_payload = {"warning": str(exc), "messages": []}
    payload = {"session": session_payload.get("session"), "history": history_payload}
    if as_json:
        emit(payload, as_json=True)
        return
    session = payload["session"] or {}
    lines = [
        f"# {session.get('title')}",
        f"- id: {session.get('id')}",
        f"- resume: {session.get('resumeCommand')}",
        f"- cwd: {session.get('cwd')}",
        f"- machine: {session.get('machineId')}",
        f"- model: {session.get('model')}",
        "",
        str(session.get("summary") or ""),
    ]
    if session.get("detailedSummary"):
        lines.extend(["", str(session.get("detailedSummary"))])
    if history_payload.get("messages"):
        lines.append("\n## Recent History")
        for message in history_payload["messages"]:
            lines.append(f"- {message.get('role')}: {message.get('text')}")
    emit("\n".join(lines), as_json=False)


@main.command("hermes-search")
@click.argument("query")
@click.option("--limit", default=5, show_default=True, type=int)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def hermes_search_command(query: str, limit: int, as_json: bool) -> None:
    """Search sessions with Hermes-oriented scoring and context output."""
    payload = hermes_search(query, limit=limit)
    if as_json:
        emit(payload, as_json=True)
        return
    emit(payload.get("memoryContext") or session_lines(payload), as_json=False)


@main.command("hermes-context")
@click.argument("session_id")
@click.option("--history-limit", default=20, show_default=True, type=int)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def hermes_context_command(session_id: str, history_limit: int, as_json: bool) -> None:
    """Build a Hermes-oriented context pack for one session."""
    payload = get_hermes_context(session_id, history_limit=history_limit)
    if as_json:
        emit(payload, as_json=True)
        return
    emit(payload.get("contextText") or json.dumps(payload, ensure_ascii=False, indent=2), as_json=False)


@main.command("resume-job")
@click.argument("session_id")
@click.argument("prompt")
@click.option("--model", default=None)
@click.option("--template", default=None, help="Pass a Codex CLI template name to the worker.")
@click.option("--mode", type=click.Choice(["exec", "pty"]), default="pty", show_default=True, help="Worker mode. exec is non-interactive; pty supports guidance and tmux attach.")
@click.option("--supervisor", is_flag=True, help="Enable supervisor metadata for this job.")
@click.option("--auto-stop", is_flag=True, help="Supervisor may stop a stale or failed job.")
@click.option("--auto-retry", is_flag=True, help="Supervisor may start a follow-up job.")
@click.option("--check-interval-ms", default=None, type=int, help="Desired supervisor polling interval.")
@click.option("--stale-output-ms", default=None, type=int, help="Desired no-output threshold before supervision.")
@click.option("--policy-profile", type=click.Choice(list(POLICY_PROFILES)), default=None, help="Named policy profile to send to the backend.")
@click.option("--policy", default=None, help="JSON object with job policy metadata.")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def resume_job_command(
    session_id: str,
    prompt: str,
    model: str | None,
    template: str | None,
    mode: str | None,
    supervisor: bool,
    auto_stop: bool,
    auto_retry: bool,
    check_interval_ms: int | None,
    stale_output_ms: int | None,
    policy_profile: str | None,
    policy: str | None,
    as_json: bool,
) -> None:
    """Start a supervised Codex resume job."""
    payload = start_resume_job(
        session_id,
        prompt,
        model=model,
        template=template,
        mode=mode,
        supervisor=supervisor_option(
            supervisor,
            auto_stop=auto_stop,
            auto_retry=auto_retry,
            check_interval_ms=check_interval_ms,
            stale_output_ms=stale_output_ms,
        ),
        policy=policy_option(policy_profile, policy),
    )
    emit(payload if as_json else format_job_launch(payload), as_json=as_json)


@main.command("dispatch-to-codex")
@click.argument("query")
@click.option("--prompt", default=None, help="Optional worker prompt. Defaults to query.")
@click.option("--session-id", default=None, help="Force a specific Codex session ID.")
@click.option("--model", default=None)
@click.option("--template", default=None, help="Pass a Codex CLI template name to the worker.")
@click.option("--mode", type=click.Choice(["exec", "pty"]), default="pty", show_default=True, help="Worker mode. pty supports guidance and tmux attach.")
@click.option("--supervisor", is_flag=True, help="Enable supervisor metadata for this job.")
@click.option("--auto-stop", is_flag=True, help="Supervisor may stop a stale or failed job.")
@click.option("--auto-retry", is_flag=True, help="Supervisor may start a follow-up job.")
@click.option("--check-interval-ms", default=None, type=int, help="Desired supervisor polling interval.")
@click.option("--stale-output-ms", default=None, type=int, help="Desired no-output threshold before supervision.")
@click.option("--policy-profile", type=click.Choice(list(POLICY_PROFILES)), default=None, help="Named policy profile to send to the backend.")
@click.option("--policy", default=None, help="JSON object with job policy metadata.")
@click.option("--limit", default=5, show_default=True, type=int)
@click.option("--threshold", default=None, type=int, help="Ask for selection below this score.")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def dispatch_to_codex_command(
    query: str,
    prompt: str | None,
    session_id: str | None,
    model: str | None,
    template: str | None,
    mode: str | None,
    supervisor: bool,
    auto_stop: bool,
    auto_retry: bool,
    check_interval_ms: int | None,
    stale_output_ms: int | None,
    policy_profile: str | None,
    policy: str | None,
    limit: int,
    threshold: int | None,
    as_json: bool,
) -> None:
    """Search, select, and start a supervised Codex worker job."""
    payload = dispatch_to_codex(
        query,
        prompt=prompt,
        session_id=session_id,
        model=model,
        template=template,
        mode=mode,
        supervisor=supervisor_option(
            supervisor,
            auto_stop=auto_stop,
            auto_retry=auto_retry,
            check_interval_ms=check_interval_ms,
            stale_output_ms=stale_output_ms,
        ),
        policy=policy_option(policy_profile, policy),
        limit=limit,
        require_confirmation_below_score=threshold,
    )
    emit(payload if as_json else format_job_launch(payload), as_json=as_json)


@main.command("job")
@click.argument("job_id")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def job_command(job_id: str, as_json: bool) -> None:
    """Show a supervised Codex job status."""
    payload = get_resume_job(job_id)
    if as_json:
        emit(payload, as_json=True)
        return
    job = payload.get("job") or {}
    lines = [
        f"id: {job.get('id')}",
        f"status: {job.get('status')}",
        f"session: {job.get('sessionId')}",
        f"cwd: {job.get('cwd')}",
        f"exit: {job.get('exitCode')} signal: {job.get('signal')}",
        "",
        str(job.get("outputTail") or ""),
    ]
    emit("\n".join(lines), as_json=False)


@main.command("outcome")
@click.argument("target_id")
@click.option("--kind", type=click.Choice(["auto", "job", "session"]), default="auto", show_default=True)
@click.option("--history-limit", default=20, show_default=True, type=int)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def outcome_command(target_id: str, kind: str, history_limit: int, as_json: bool) -> None:
    """Show a session or job outcome, falling back to context/job details."""
    if kind == "job":
        payload = get_job_outcome(target_id)
    elif kind == "session":
        payload = get_session_outcome(target_id, history_limit=history_limit)
    else:
        try:
            payload = get_job_outcome(target_id)
        except BackendError:
            payload = get_session_outcome(target_id, history_limit=history_limit)
    emit(payload if as_json else format_outcome(payload), as_json=as_json)


@main.command("job-events")
@click.argument("job_id")
@click.option("--after-seq", default=0, show_default=True, type=int)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def job_events_command(job_id: str, after_seq: int, as_json: bool) -> None:
    """Read job events after a sequence number."""
    payload = get_job_events(job_id, after_seq=after_seq)
    if as_json:
        emit(payload, as_json=True)
        return
    lines = []
    for event in payload.get("events", []):
        if isinstance(event, dict):
            lines.append(format_job_event(event))
    emit("\n\n".join(lines), as_json=False)


@main.command("job-events-stream")
@click.argument("job_id")
@click.option("--after-seq", default=0, show_default=True, type=int)
@click.option("--interval", default=1.0, show_default=True, type=float, help="Polling interval in seconds.")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def job_events_stream_command(job_id: str, after_seq: int, interval: float, as_json: bool) -> None:
    """Poll and print job events until the job leaves running status."""
    next_seq = max(0, after_seq)
    try:
        while True:
            payload = get_job_events(job_id, after_seq=next_seq)
            events = [event for event in payload.get("events", []) if isinstance(event, dict)]
            if as_json and events:
                for event in events:
                    emit(event, as_json=True)
            elif events:
                emit("\n\n".join(format_job_event(event) for event in events), as_json=False)
            if events:
                max_seq = max(int(event.get("seq", next_seq)) for event in events)
                next_seq = max(next_seq, max_seq)
            else:
                next_seq = max(0, next_seq)
            job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
            if job.get("status") and job.get("status") != "running":
                return
            time.sleep(max(0.1, interval))
    except KeyboardInterrupt:
        return


@main.command("protocol-job")
@click.argument("job_id")
@click.argument("kind", type=click.Choice(["guide", "pause", "continue", "summarize", "handoff", "verify"]))
@click.argument("text", required=False, default="")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def protocol_job_command(job_id: str, kind: str, text: str, as_json: bool) -> None:
    """Send a structured protocol command to a job."""
    emit(send_job_protocol(job_id, kind=kind, text=text), as_json=as_json)


@main.command("job-registry")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def job_registry_command(as_json: bool) -> None:
    """List local and remote jobs as a global registry."""
    payload = get_job_registry()
    if as_json:
        emit(payload, as_json=True)
        return
    lines = [f"count={payload.get('count', len(payload.get('jobs', [])))}"]
    for item in payload.get("jobs", []):
        job = item.get("job") if isinstance(item, dict) else {}
        lines.append(
            " | ".join(
                str(value)
                for value in [
                    item.get("machineId") if isinstance(item, dict) else None,
                    item.get("baseUrl") if isinstance(item, dict) else None,
                    job.get("id") if isinstance(job, dict) else None,
                    job.get("status") if isinstance(job, dict) else None,
                    job.get("sessionId") if isinstance(job, dict) else None,
                    job.get("cwd") if isinstance(job, dict) else None,
                ]
                if value
            )
        )
    emit("\n".join(lines), as_json=False)


@main.command("stop-job")
@click.argument("job_id")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def stop_job_command(job_id: str, as_json: bool) -> None:
    """Stop a supervised Codex job."""
    emit(stop_resume_job(job_id), as_json=as_json)


@main.command("guide-job")
@click.argument("job_id")
@click.argument("text")
@click.option("--json-output", "--json", "as_json", is_flag=True)
def guide_job_command(job_id: str, text: str, as_json: bool) -> None:
    """Send guidance into an interactive Codex PTY job, or record guidance for exec jobs."""
    emit(guide_resume_job(job_id, text), as_json=as_json)


@main.command("supervise-job")
@click.argument("job_id")
@click.option("--instruction", default=None, help="Optional supervisor guidance.")
@click.option("--auto-stop", is_flag=True, help="Stop the job if supervision decides it is off track or failed.")
@click.option("--auto-retry", is_flag=True, help="Start a follow-up job if supervision decides retry is needed.")
@click.option("--check-interval-ms", default=None, type=int, help="Desired supervisor polling interval.")
@click.option("--stale-output-ms", default=None, type=int, help="Desired no-output threshold before supervision.")
@click.option("--retry-mode", type=click.Choice(["exec", "pty"]), default=None)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def supervise_job_command(
    job_id: str,
    instruction: str | None,
    auto_stop: bool,
    auto_retry: bool,
    check_interval_ms: int | None,
    stale_output_ms: int | None,
    retry_mode: str | None,
    as_json: bool,
) -> None:
    """Inspect a job and optionally guide, stop, or retry it."""
    emit(
        supervise_resume_job(
            job_id,
            instruction=instruction,
            auto_stop=auto_stop,
            auto_retry=auto_retry,
            check_interval_ms=check_interval_ms,
            stale_output_ms=stale_output_ms,
            retry_mode=retry_mode,
        ),
        as_json=as_json,
    )


@main.command()
@click.option("--json-output", "--json", "as_json", is_flag=True)
def analysis(as_json: bool) -> None:
    """Show recent AI analysis run stats."""
    payload = request_json("/api/analysis-runs")
    emit(payload, as_json=as_json)


@main.command()
@click.option("--limit", default=4, show_default=True, type=int)
@click.option("--include-failed", is_flag=True)
@click.option("--json-output", "--json", "as_json", is_flag=True)
def backfill(limit: int, include_failed: bool, as_json: bool) -> None:
    """Trigger a small backend AI summary backfill batch."""
    payload = request_json(
        "/api/evaluations/backfill",
        method="POST",
        body={"limit": max(1, min(200, limit)), "includeFailed": include_failed},
        timeout=180,
    )
    emit(payload, as_json=as_json)


def repl(ctx: click.Context) -> None:
    click.echo("Codex Session Curator CLI. Type help, sessions, search <q>, dispatch <task>, job <id>, outcome <id>, events <id>, stream <id>, registry, status, exit.")
    while True:
        try:
            line = input("curator> ").strip()
        except EOFError:
            click.echo()
            return
        if not line:
            continue
        if line in {"exit", "quit", ":q"}:
            return
        if line == "help":
            click.echo(
                "commands: status | sessions [limit] | search <query> | show <id> | context <id> | hermes-search <query> | "
                "hermes-context <id> | dispatch <task> | job <id> | outcome <id> | events <id> | stream <id> | registry | history <id> | messages <id> | analysis | exit"
            )
            continue
        try:
            args = shlex.split(line)
        except ValueError as exc:
            click.echo(f"parse error: {exc}", err=True)
            continue
        command = args[0]
        try:
            if command == "status":
                ctx.invoke(status, as_json=False)
            elif command == "sessions":
                limit = int(args[1]) if len(args) > 1 else 10
                ctx.invoke(sessions, limit=limit, query=None, recommendation=None, local_only=False, detail=False, as_json=False)
            elif command == "search" and len(args) > 1:
                ctx.invoke(search, query=" ".join(args[1:]), limit=10, as_json=False)
            elif command == "show" and len(args) > 1:
                ctx.invoke(show, session_id=args[1], as_json=False)
            elif command == "context" and len(args) > 1:
                ctx.invoke(context, session_id=args[1], history_limit=12, as_json=False)
            elif command == "hermes-search" and len(args) > 1:
                ctx.invoke(hermes_search_command, query=" ".join(args[1:]), limit=5, as_json=False)
            elif command == "hermes-context" and len(args) > 1:
                ctx.invoke(hermes_context_command, session_id=args[1], history_limit=20, as_json=False)
            elif command == "dispatch" and len(args) > 1:
                ctx.invoke(
                    dispatch_to_codex_command,
                    query=" ".join(args[1:]),
                    prompt=None,
                    session_id=None,
                    model=None,
                    template=None,
                    mode="pty",
                    supervisor=False,
                    auto_stop=False,
                    auto_retry=False,
                    check_interval_ms=None,
                    stale_output_ms=None,
                    policy_profile=None,
                    policy=None,
                    limit=5,
                    threshold=None,
                    as_json=False,
                )
            elif command == "job" and len(args) > 1:
                ctx.invoke(job_command, job_id=args[1], as_json=False)
            elif command == "outcome" and len(args) > 1:
                ctx.invoke(outcome_command, target_id=args[1], kind="auto", history_limit=20, as_json=False)
            elif command == "events" and len(args) > 1:
                ctx.invoke(job_events_command, job_id=args[1], after_seq=0, as_json=False)
            elif command == "stream" and len(args) > 1:
                ctx.invoke(job_events_stream_command, job_id=args[1], after_seq=0, interval=1.0, as_json=False)
            elif command == "registry":
                ctx.invoke(job_registry_command, as_json=False)
            elif command == "history" and len(args) > 1:
                ctx.invoke(history, session_id=args[1], limit=20, before=None, as_json=False)
            elif command == "messages" and len(args) > 1:
                ctx.invoke(messages, session_id=args[1], limit=200, before=None, after=None, full=False, preserve=True, as_json=False)
            elif command == "analysis":
                ctx.invoke(analysis, as_json=False)
            else:
                click.echo("unknown command or missing argument", err=True)
        except Exception as exc:
            click.echo(f"error: {exc}", err=True)


if __name__ == "__main__":
    sys.exit(main())
