from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..utils._backend import BackendError, request_json, state_sessions


def compact_session(session: dict[str, Any], *, include_detail: bool = False) -> dict[str, Any]:
    evaluation = session.get("evaluation") if isinstance(session.get("evaluation"), dict) else {}
    result = {
        "id": session.get("id"),
        "title": session.get("title"),
        "summary": evaluation.get("summary"),
        "recommendation": evaluation.get("recommendation"),
        "status": evaluation.get("status"),
        "model": evaluation.get("model"),
        "workflow": evaluation.get("workflow"),
        "cwd": session.get("cwd"),
        "machineId": session.get("machineId"),
        "updatedAt": session.get("updatedAt"),
        "messageCount": session.get("messageCount"),
        "userTurns": session.get("userTurns"),
        "assistantTurns": session.get("assistantTurns"),
        "resumeCommand": session.get("resumeCommand") or f"codex resume {session.get('id')}",
        "actualWorkdirs": evaluation.get("actualWorkdirs") or [],
        "techStack": evaluation.get("techStack") or [],
        "keywords": evaluation.get("keywords") or [],
    }
    if include_detail:
        result["detailedSummary"] = evaluation.get("detailedSummary")
        result["reasons"] = evaluation.get("reasons") or []
        result["remoteMachines"] = evaluation.get("remoteMachines") or []
    return result


def list_sessions(
    *,
    query: str | None = None,
    recommendation: str | None = None,
    limit: int = 20,
    remote: bool = True,
    detail: bool = False,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "detail": "1" if detail else "0",
        "pageSize": max(1, min(500, limit)),
        "remote": "1" if remote else "0",
    }
    if query:
        params["q"] = query
    if recommendation:
        params["recommendation"] = recommendation
    try:
        payload = request_json("/api/sessions", params=params)
        sessions = payload.get("sessions", []) if isinstance(payload, dict) else []
        return {
            "source": "api",
            "total": payload.get("total") if isinstance(payload, dict) else len(sessions),
            "filteredTotal": payload.get("filteredTotal") if isinstance(payload, dict) else len(sessions),
            "sessions": [compact_session(item, include_detail=detail) for item in sessions],
        }
    except BackendError as exc:
        sessions = [compact_session(item, include_detail=detail) for item in state_sessions()]
        sessions = filter_sessions(sessions, query=query, recommendation=recommendation)[:limit]
        return {"source": "state", "warning": str(exc), "total": len(sessions), "filteredTotal": len(sessions), "sessions": sessions}


def filter_sessions(
    sessions: list[dict[str, Any]],
    *,
    query: str | None = None,
    recommendation: str | None = None,
) -> list[dict[str, Any]]:
    filtered = sessions
    if recommendation and recommendation != "all":
        filtered = [item for item in filtered if item.get("recommendation") == recommendation]
    if query:
        needle = query.lower()
        filtered = [item for item in filtered if needle in searchable_text(item)]
    return sorted(filtered, key=lambda item: item.get("updatedAt") or "", reverse=True)


def searchable_text(session: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("id", "title", "summary", "detailedSummary", "cwd", "machineId", "resumeCommand"):
        value = session.get(key)
        if value:
            parts.append(str(value))
    for key in ("actualWorkdirs", "techStack", "keywords"):
        value = session.get(key)
        if isinstance(value, list):
            parts.extend(str(item) for item in value)
    return " ".join(parts).lower()


def get_session(session_id: str) -> dict[str, Any]:
    try:
        payload = request_json(f"/api/sessions/{session_id}")
        if isinstance(payload, dict):
            return {"source": "api", "session": compact_session(payload, include_detail=True)}
    except BackendError as exc:
        for session in state_sessions():
            if session.get("id") == session_id:
                return {"source": "state", "warning": str(exc), "session": compact_session(session, include_detail=True)}
        raise
    return {"source": "api", "session": None}


def get_history(session_id: str, *, limit: int = 20, before: int | None = None) -> dict[str, Any]:
    params: dict[str, Any] = {"limit": max(1, min(200, limit))}
    if before is not None:
        params["before"] = before
    payload = request_json(f"/api/sessions/{session_id}/history", params=params)
    return payload if isinstance(payload, dict) else {"messages": []}


def text_from_content(content: Any) -> str | None:
    if isinstance(content, str):
        return content.strip() or None
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        for key in ("text", "input_text"):
            value = item.get(key)
            if isinstance(value, str):
                parts.append(value)
    text = "\n".join(parts).strip()
    return text or None


def local_messages_from_jsonl(
    file_path: str | None,
    *,
    limit: int,
    before: int | None = None,
    after: int | None = None,
    full: bool = False,
    preserve: bool = False,
) -> dict[str, Any]:
    if not file_path:
        raise BackendError("No local session file path in cached state")
    path = Path(file_path).expanduser()
    messages: list[dict[str, Any]] = []
    total = 0
    max_messages = float("inf") if full else max(1, min(5000, limit))
    before_index = before if before is not None else float("inf")
    after_index = after if after is not None else -1
    skipped_before = False
    stopped_after = False

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise BackendError(f"Cannot read session file: {path}") from exc

    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("type") != "response_item":
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        role = payload.get("role")
        if role not in {"user", "assistant"}:
            continue
        text = text_from_content(payload.get("content"))
        if not text:
            continue
        message = {
            "index": total,
            "role": role,
            "text": text if preserve else " ".join(text.split()),
            "timestamp": record.get("timestamp") if isinstance(record.get("timestamp"), str) else None,
        }
        total += 1
        if message["index"] >= before_index or message["index"] <= after_index:
            continue
        if len(messages) < max_messages:
            messages.append(message)
        elif before is not None:
            messages.pop(0)
            messages.append(message)
            skipped_before = True
        else:
            stopped_after = True

    first = messages[0]["index"] if messages else None
    last = messages[-1]["index"] if messages else None
    has_more_before = first is not None and (skipped_before or first > after_index + 1)
    has_more_after = last is not None and (stopped_after or last < min(before_index, total) - 1)
    return {
        "source": "state",
        "messages": messages,
        "totalMessages": total,
        "nextBefore": first if has_more_before else None,
        "nextAfter": last if has_more_after else None,
        "hasMoreBefore": has_more_before,
        "hasMoreAfter": has_more_after,
    }


def get_messages(
    session_id: str,
    *,
    limit: int = 200,
    before: int | None = None,
    after: int | None = None,
    full: bool = False,
    preserve: bool = False,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "limit": max(1, min(5000, limit)),
        "full": "1" if full else "0",
        "preserve": "1" if preserve else "0",
    }
    if before is not None:
        params["before"] = before
    if after is not None:
        params["after"] = after
    try:
        payload = request_json(f"/api/sessions/{session_id}/messages", params=params, timeout=30)
        return payload if isinstance(payload, dict) else {"messages": []}
    except BackendError as exc:
        for session in state_sessions():
            if session.get("id") == session_id:
                payload = local_messages_from_jsonl(
                    session.get("filePath"),
                    limit=limit,
                    before=before,
                    after=after,
                    full=full,
                    preserve=preserve,
                )
                payload["warning"] = str(exc)
                return payload
        raise


def hermes_search(query: str, *, limit: int = 5) -> dict[str, Any]:
    try:
        payload = request_json("/api/hermes/search", params={"q": query, "limit": max(1, min(20, limit))})
        return payload if isinstance(payload, dict) else {"sessions": []}
    except BackendError:
        fallback = list_sessions(query=query, limit=limit, remote=True, detail=True)
        sessions = fallback.get("sessions", []) if isinstance(fallback, dict) else []
        return {
            "query": query,
            "source": fallback.get("source"),
            "warning": fallback.get("warning"),
            "sessions": sessions,
            "count": len(sessions),
            "memoryContext": "\n".join(
                f"- {item.get('id')}: {item.get('title')} | {item.get('cwd')} | {item.get('summary')}" for item in sessions
            ),
        }


def get_hermes_context(session_id: str, *, history_limit: int = 20) -> dict[str, Any]:
    try:
        payload = request_json(
            f"/api/hermes/sessions/{session_id}/context",
            params={"historyLimit": max(0, min(80, history_limit))},
        )
        return payload if isinstance(payload, dict) else {"session": None}
    except BackendError:
        session_payload = get_session(session_id)
        history_payload: dict[str, Any]
        try:
            history_payload = get_history(session_id, limit=history_limit)
        except BackendError as exc:
            history_payload = {"warning": str(exc), "messages": []}
        return {"session": session_payload.get("session"), "history": history_payload}


def get_job_outcome(job_id: str) -> dict[str, Any]:
    try:
        payload = request_json(f"/api/hermes/jobs/{job_id}/outcome", timeout=8)
        if isinstance(payload, dict):
            return {"source": "api", "kind": "job", **payload}
    except BackendError as exc:
        warning = str(exc)
    else:
        warning = "Empty outcome response"

    job_payload = get_resume_job(job_id)
    job = job_payload.get("job") if isinstance(job_payload.get("job"), dict) else {}
    report = job.get("structuredReport") if isinstance(job.get("structuredReport"), dict) else {}
    policy_state = job.get("policyState") if isinstance(job.get("policyState"), dict) else {}
    return {
        "source": "job",
        "kind": "job",
        "warning": warning,
        "jobId": job_id,
        "status": report.get("status") or job.get("status"),
        "sessionId": job.get("sessionId"),
        "cwd": job.get("cwd"),
        "exitCode": job.get("exitCode"),
        "signal": job.get("signal"),
        "error": job.get("error"),
        "changedFiles": report.get("changedFiles") or job.get("changedFiles") or [],
        "tests": report.get("tests") or [],
        "nextAction": report.get("nextAction"),
        "policyViolations": policy_state.get("violations") or [],
        "outputTail": job.get("outputTail") or "",
    }


def get_session_outcome(session_id: str, *, history_limit: int = 20) -> dict[str, Any]:
    try:
        payload = request_json(f"/api/sessions/{session_id}/outcome", timeout=8)
        if isinstance(payload, dict):
            return {"source": "api", "kind": "session", **payload}
    except BackendError as exc:
        warning = str(exc)
    else:
        warning = "Empty outcome response"

    context = get_hermes_context(session_id, history_limit=history_limit)
    return {
        "source": "context",
        "kind": "session",
        "warning": warning,
        "sessionId": session_id,
        "session": context.get("session"),
        "history": context.get("history"),
        "contextText": context.get("contextText"),
    }


def start_resume_job(
    session_id: str,
    prompt: str,
    *,
    model: str | None = None,
    template: str | None = None,
    mode: str | None = None,
    supervisor: bool | dict[str, Any] | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"sessionId": session_id, "prompt": prompt}
    if model:
        body["model"] = model
    if template:
        body["template"] = template
    if mode:
        body["mode"] = mode
    if supervisor is not None:
        body["supervisor"] = supervisor
    if policy:
        body["policy"] = policy
    payload = request_json("/api/hermes/jobs/resume", method="POST", body=body, timeout=30)
    return payload if isinstance(payload, dict) else {"job": None}


def dispatch_to_codex(
    query: str,
    *,
    prompt: str | None = None,
    session_id: str | None = None,
    model: str | None = None,
    template: str | None = None,
    limit: int = 5,
    require_confirmation_below_score: int | None = None,
    mode: str | None = None,
    supervisor: bool | dict[str, Any] | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "query": query,
        "limit": max(1, min(10, limit)),
    }
    if prompt:
        body["prompt"] = prompt
    if session_id:
        body["sessionId"] = session_id
    if model:
        body["model"] = model
    if template:
        body["template"] = template
    if mode:
        body["mode"] = mode
    if supervisor is not None:
        body["supervisor"] = supervisor
    if policy:
        body["policy"] = policy
    if require_confirmation_below_score is not None:
        body["requireConfirmationBelowScore"] = max(0, min(100, require_confirmation_below_score))
    payload = request_json("/api/hermes/dispatch", method="POST", body=body, timeout=35)
    return payload if isinstance(payload, dict) else {"status": "unknown"}


def get_resume_job(job_id: str) -> dict[str, Any]:
    payload = request_json(f"/api/hermes/jobs/{job_id}", timeout=8)
    return payload if isinstance(payload, dict) else {"job": None}


def get_job_events(job_id: str, *, after_seq: int = 0) -> dict[str, Any]:
    try:
        payload = request_json(f"/api/hermes/jobs/{job_id}/events", params={"afterSeq": max(0, after_seq)}, timeout=8)
        return payload if isinstance(payload, dict) else {"events": []}
    except BackendError as exc:
        return {"error": str(exc), "jobId": job_id, "events": []}


def send_job_protocol(job_id: str, *, kind: str, text: str) -> dict[str, Any]:
    try:
        payload = request_json(f"/api/hermes/jobs/{job_id}/protocol", method="POST", body={"kind": kind, "text": text}, timeout=12)
        return payload if isinstance(payload, dict) else {"job": None}
    except BackendError as exc:
        return {"error": str(exc), "jobId": job_id, "kind": kind, "job": None}


def get_job_registry() -> dict[str, Any]:
    try:
        payload = request_json("/api/hermes/job-registry", timeout=12)
        return payload if isinstance(payload, dict) else {"jobs": []}
    except BackendError as exc:
        return {"error": str(exc), "jobs": []}


def stop_resume_job(job_id: str) -> dict[str, Any]:
    payload = request_json(f"/api/hermes/jobs/{job_id}/stop", method="POST", body={}, timeout=8)
    return payload if isinstance(payload, dict) else {"job": None}


def guide_resume_job(job_id: str, text: str) -> dict[str, Any]:
    payload = request_json(f"/api/hermes/jobs/{job_id}/guidance", method="POST", body={"text": text, "source": "hermes"}, timeout=8)
    return payload if isinstance(payload, dict) else {"job": None}


def supervise_resume_job(
    job_id: str,
    *,
    instruction: str | None = None,
    auto_stop: bool = False,
    auto_retry: bool = False,
    check_interval_ms: int | None = None,
    stale_output_ms: int | None = None,
    retry_mode: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"autoStop": auto_stop, "autoRetry": auto_retry}
    if instruction:
        body["instruction"] = instruction
    if check_interval_ms is not None:
        body["checkIntervalMs"] = check_interval_ms
    if stale_output_ms is not None:
        body["staleOutputMs"] = stale_output_ms
    if retry_mode:
        body["retryMode"] = retry_mode
    payload = request_json(f"/api/hermes/jobs/{job_id}/supervise", method="POST", body=body, timeout=12)
    return payload if isinstance(payload, dict) else {"job": None}
