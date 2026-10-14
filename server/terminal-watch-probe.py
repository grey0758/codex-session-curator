"""Small, bounded probe executed in the terminal owner's login environment.

Only structured status leaves this process. No transcript or pane text is returned.
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request


def emit(value):
    print(json.dumps(value, ensure_ascii=False))


def tmux(*args):
    socket = re.sub(r"[^a-zA-Z0-9_-]", "_", os.getenv("CURATOR_TERMINAL_TMUX_SOCKET", "codex-curator"))[:80]
    return subprocess.run(["tmux", "-L", socket, *args], capture_output=True, text=True, timeout=5)


def inspect(session_id, file_path):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,120}", session_id):
        raise ValueError("invalid session identity")
    name = "codex-curator-" + session_id
    pane_info = tmux("display-message", "-p", "-t", name, "#{pane_current_command}|#{pane_dead}")
    if pane_info.returncode != 0:
        return {"pane": False, "status": "closed"}
    command, _, dead = pane_info.stdout.strip().partition("|")
    if dead == "1" or command not in ("node", "codex"):
        return {"pane": True, "status": "closed"}

    pane = tmux("capture-pane", "-p", "-t", name, "-S", "-120")
    screen = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", pane.stdout)[-16000:]
    last_lines = [line.strip() for line in screen.splitlines() if line.strip()]
    manual_banner = bool(re.search(r"Conversation interrupted\s*[-–]\s*use /feedback", "\n".join(last_lines[-45:]), re.I))
    screen_tail = "\n".join(last_lines[-16:])
    upstream_error = bool(re.search(
        r"stream disconnected|connection reset|connection refused|network error|upstream.*(?:error|failed)|"
        r"(?:HTTP|status)\s*(?:429|500|502|503|504)\b|rate limit|service unavailable|"
        r"request timed out|transport error|error sending request", screen_tail, re.I))
    retrying = bool(re.search(r"\bretrying\b|正在重试", "\n".join(last_lines[-5:]), re.I))
    prompt = bool(re.search(r"(?:^|\s)[›❯](?:\s|$)|^>(?:\s|$)", "\n".join(last_lines[-10:]), re.M))
    diagnostic = ""
    if not upstream_error:
        for line in reversed(last_lines[-20:]):
            if re.search(r"\berror\b|\bfailed\b|异常|请求失败|连接断开", line, re.I):
                diagnostic = re.sub(r"https?://\S+|\b(?:sk-|nvapi-)[A-Za-z0-9_-]+\b|\b[A-Za-z0-9_-]{32,}\b", "[redacted]", line)
                diagnostic = re.sub(r"['\"`][^'\"`]{8,}['\"`]", "[redacted]", diagnostic)[:180]
                break

    path = pathlib.Path(file_path)
    if session_id not in path.name or not path.is_file():
        return {"pane": True, "status": "unknown", "reason": "session-file-unavailable"}
    goal = None
    task_started = ""
    task_complete = ""
    aborted = ""
    last_activity = ""
    last_user = ""
    final_answer = ""
    with path.open(encoding="utf8", errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except (ValueError, TypeError):
                continue
            payload = event.get("payload") or {}
            timestamp = event.get("timestamp") or ""
            if event.get("type") == "event_msg":
                kind = payload.get("type")
                if kind == "thread_goal_updated":
                    goal = (payload.get("goal") or {}).get("status")
                elif kind == "task_started":
                    task_started = timestamp
                    final_answer = ""
                elif kind == "task_complete":
                    task_complete = timestamp
                elif kind == "turn_aborted":
                    aborted = timestamp
                elif kind in ("item_completed", "token_count"):
                    last_activity = timestamp
                    if kind == "item_completed":
                        item = payload.get("item") or {}
                        if item.get("type") == "AgentMessage" and item.get("phase") in ("final_answer", "final"):
                            final_answer = timestamp
            elif event.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") == "user":
                last_user = timestamp

    manual = bool((aborted and aborted >= task_started) or manual_banner)
    if goal in ("paused", "blocked", "complete"):
        status = "manual-paused"
    elif manual:
        status = "manual-paused"
    elif retrying:
        status = "retrying"
    elif task_started and task_started > max(task_complete, aborted):
        status = "running"
    else:
        status = "idle"
    failed_complete = bool(
        status == "idle" and task_started and task_complete >= task_started
        and final_answer < task_started and upstream_error and prompt
        and not (last_user and last_user > task_complete)
    )
    return {
        "pane": True, "status": status, "goalStatus": goal,
        "taskStartedAt": task_started, "taskCompleteAt": task_complete,
        "abortedAt": aborted, "lastActivityAt": last_activity, "lastUserAt": last_user,
        "upstreamError": upstream_error, "promptVisible": prompt,
        "failedComplete": failed_complete,
        "diagnostic": diagnostic,
    }


def health():
    config_path = pathlib.Path.home() / ".codex" / "config.toml"
    with config_path.open("rb") as stream:
        config = tomllib.load(stream)
    provider = config.get("model_providers", {}).get(config.get("model_provider"), {})
    base = str(provider.get("base_url") or "").rstrip("/")
    model = str(config.get("model") or "")
    key = os.environ.get(str(provider.get("env_key") or ""), "")
    wire_api = provider.get("wire_api")
    if not re.match(r"^https?://", base) or not model or not key or wire_api not in ("responses", "chat", "chat_completions"):
        return {"healthy": False, "reason": "provider-config-unavailable"}
    if wire_api == "responses":
        path = "/responses"
        body = {"model": model, "input": "Reply OK.", "max_output_tokens": 64, "stream": False}
    else:
        path = "/chat/completions"
        body = {"model": model, "messages": [{"role": "user", "content": "Reply OK."}], "max_tokens": 64, "stream": False}
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=18) as response:
            data = json.load(response)
            valid = bool(data.get("id") or data.get("choices"))
            healthy = response.status == 200 and valid
            return {"healthy": healthy, "reason": "ok" if healthy else "unexpected-response"}
    except urllib.error.HTTPError as error:
        return {"healthy": False, "reason": "upstream-http-" + str(error.code)}
    except (urllib.error.URLError, TimeoutError, ValueError):
        return {"healthy": False, "reason": "upstream-unreachable"}


def main():
    mode, session_id, file_path, *rest = sys.argv[1:]
    if mode == "list":
        result = tmux("list-sessions", "-F", "#{session_name}")
        names = re.findall(r"^codex-curator-([a-zA-Z0-9_-]{8,120})$", result.stdout, re.M) if result.returncode == 0 else []
        emit({"sessions": names[:200]})
    elif mode == "inspect":
        emit(inspect(session_id, file_path))
    elif mode == "health":
        emit(health())
    elif mode == "send":
        expected_task, text, *diagnostic_rest = rest
        expected_diagnostic = diagnostic_rest[0] if diagnostic_rest else ""
        if text not in ("/goal resume", "继续"):
            raise ValueError("unsupported recovery message")
        current = inspect(session_id, file_path)
        error_confirmed = current.get("upstreamError") or (expected_diagnostic and current.get("diagnostic") == expected_diagnostic)
        if (current.get("taskStartedAt") != expected_task or not error_confirmed or
                not current.get("promptVisible") or current.get("status") in ("closed", "manual-paused", "retrying")):
            emit({"sent": False, "reason": "state-changed"})
            return
        name = "codex-curator-" + session_id
        literal = tmux("send-keys", "-t", name, "-l", text)
        enter = tmux("send-keys", "-t", name, "Enter") if literal.returncode == 0 else literal
        emit({"sent": literal.returncode == 0 and enter.returncode == 0, "reason": "ok" if enter.returncode == 0 else "tmux-send-failed"})
    else:
        raise ValueError("unknown mode")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"status": "unknown", "healthy": False, "sent": False, "reason": "probe-failed"})
