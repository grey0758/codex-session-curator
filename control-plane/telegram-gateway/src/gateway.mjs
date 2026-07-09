#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = dirname(__dirname);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CODEX_CONTROL_PLANE_DIR =
  process.env.CODEX_CONTROL_PLANE_DIR || "/home/grey/work/codex-control-plane";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const TELEGRAM_ALLOWED_USER_IDS = parseAllowedUserIds(
  process.env.TELEGRAM_ALLOWED_USER_IDS || "",
);

const STATE_DIR = join(gatewayRoot, ".state");
const SESSION_DIR = join(STATE_DIR, "sessions");
const RUN_DIR = join(STATE_DIR, "runs");
const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : "";
const TELEGRAM_CHUNK_LIMIT = 3800;

let updateOffset = 0;
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});

async function main() {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  await mkdir(SESSION_DIR, { recursive: true });
  await mkdir(RUN_DIR, { recursive: true });

  if (TELEGRAM_ALLOWED_USER_IDS.size === 0) {
    console.warn("TELEGRAM_ALLOWED_USER_IDS is empty; all Telegram users are allowed.");
  }

  console.log("Telegram thin gateway started.");
  console.log(`Control plane: ${CODEX_CONTROL_PLANE_DIR}`);
  console.log(`Codex binary: ${CODEX_BIN}`);

  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        allowed_updates: ["message"],
        offset: updateOffset || undefined,
        timeout: 50,
      });

      for (const update of updates) {
        updateOffset = Math.max(updateOffset, update.update_id + 1);
        await handleUpdate(update);
      }
    } catch (error) {
      console.error(`poll error: ${error?.message || String(error)}`);
      await sleep(3000);
    }
  }

  console.log("Telegram thin gateway stopped.");
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.chat || !message.from) {
    return;
  }

  const userId = String(message.from.id);
  if (TELEGRAM_ALLOWED_USER_IDS.size > 0 && !TELEGRAM_ALLOWED_USER_IDS.has(userId)) {
    await sendMessage(message.chat.id, "Unauthorized user.", message.message_thread_id);
    return;
  }

  const prompt = extractPrompt(message);
  if (!prompt) {
    await sendMessage(
      message.chat.id,
      "Only text and caption messages are supported by this thin gateway.",
      message.message_thread_id,
    );
    return;
  }

  const sessionKey = buildSessionKey(message.chat.id, message.message_thread_id);
  const sessionFile = sessionFilePath(sessionKey);

  if (prompt.trim() === "/reset") {
    await rm(sessionFile, { force: true });
    await sendMessage(message.chat.id, "Codex session mapping reset.", message.message_thread_id);
    return;
  }

  const session = await readSession(sessionFile);
  await sendMessage(message.chat.id, "Received. Forwarding to Codex.", message.message_thread_id);

  let result;
  try {
    result = await runCodex({
      prompt: buildCodexPrompt(message, prompt),
      sessionId: session.sessionId,
    });
  } catch (error) {
    const text = `Codex invocation failed:\n${error?.message || String(error)}`;
    for (const chunk of splitTelegramMessage(text)) {
      await sendMessage(message.chat.id, chunk, message.message_thread_id);
    }
    return;
  }

  const nextSession = {
    chatId: String(message.chat.id),
    threadId: String(message.message_thread_id || 0),
    sessionId: result.sessionId || session.sessionId || null,
    updatedAt: new Date().toISOString(),
    createdAt: session.createdAt || new Date().toISOString(),
    lastTelegramUpdateId: update.update_id,
    lastCodexExitCode: result.exitCode,
  };
  await writeSession(sessionFile, nextSession);

  const response = formatCodexResponse(result);
  for (const chunk of splitTelegramMessage(response)) {
    await sendMessage(message.chat.id, chunk, message.message_thread_id);
  }
}

function extractPrompt(message) {
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.caption === "string") {
    return message.caption;
  }
  return "";
}

function buildCodexPrompt(message, text) {
  const thread = message.message_thread_id ? ` thread=${message.message_thread_id}` : "";
  return `Telegram request: chat=${message.chat.id}${thread} user=${message.from.id}\n\n${text}`;
}

async function runCodex({ prompt, sessionId }) {
  const outputFile = join(RUN_DIR, `${Date.now()}-${process.pid}-${randomUUID()}.last-message.txt`);
  const startedAt = Date.now();
  const args = sessionId
    ? ["exec", "resume", "--skip-git-repo-check", "--json", "-o", outputFile]
    : ["exec", "-C", CODEX_CONTROL_PLANE_DIR, "--skip-git-repo-check", "--json", "-o", outputFile];

  if (CODEX_MODEL) {
    args.push("-m", CODEX_MODEL);
  }

  if (sessionId) {
    args.push(sessionId);
  }
  args.push(prompt);

  const { stdout, stderr, exitCode } = await spawnCollect(CODEX_BIN, args, {
    cwd: CODEX_CONTROL_PLANE_DIR,
  });

  const lastMessage = await readOptionalFile(outputFile);
  await rm(outputFile, { force: true });

  const detectedSessionId =
    findSessionId(stdout) ||
    findSessionId(stderr) ||
    (sessionId ? "" : await findRecentCodexSessionId(startedAt, CODEX_CONTROL_PLANE_DIR));

  return {
    exitCode,
    lastMessage,
    sessionId: detectedSessionId || sessionId || null,
    stderr,
    stdout,
  };
}

function spawnCollect(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function formatCodexResponse(result) {
  const cleanLastMessage = result.lastMessage.trim();
  if (result.exitCode === 0 && cleanLastMessage) {
    return cleanLastMessage;
  }

  const readableJson = extractReadableJsonOutput(result.stdout).trim();
  const output = cleanLastMessage || readableJson || result.stdout.trim() || "(no output)";

  if (result.exitCode === 0) {
    return output;
  }

  const stderr = result.stderr.trim();
  return [
    `Codex exited with code ${result.exitCode}.`,
    stderr ? `stderr:\n${stderr}` : "",
    output ? `output:\n${output}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractReadableJsonOutput(stdout) {
  const messages = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const event = safeJsonParse(line);
    if (!event || typeof event !== "object") {
      messages.push(line);
      continue;
    }
    const text = extractText(event);
    if (text) {
      messages.push(text);
    }
  }
  return messages.join("\n");
}

function extractText(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const type = typeof value.type === "string" ? value.type : "";
  for (const key of ["message", "text", "content", "delta"]) {
    if (typeof value[key] === "string" && shouldUseText(type, key)) {
      return value[key];
    }
  }

  if (value.item && typeof value.item === "object") {
    return extractText(value.item);
  }

  if (Array.isArray(value.content)) {
    return value.content.map(extractText).filter(Boolean).join("\n");
  }

  return "";
}

function shouldUseText(type, key) {
  if (!type) {
    return key !== "delta";
  }
  return /message|response|final|answer|output|delta/i.test(type);
}

function findSessionId(output) {
  for (const line of output.split(/\r?\n/)) {
    const event = safeJsonParse(line);
    const fromJson = findSessionIdInValue(event);
    if (fromJson) {
      return fromJson;
    }
  }

  const match = output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return match ? match[0] : "";
}

function findSessionIdInValue(value, parentKey = "") {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionIdInValue(item, parentKey);
      if (found) {
        return found;
      }
    }
    return "";
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && looksLikeSessionKey(key, parentKey) && isUuid(child)) {
      return child;
    }
  }

  const type = typeof value.type === "string" ? value.type : "";
  if (/session/i.test(type)) {
    for (const key of ["id", "session_id", "sessionId"]) {
      if (typeof value[key] === "string" && isUuid(value[key])) {
        return value[key];
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const found = findSessionIdInValue(child, key);
    if (found) {
      return found;
    }
  }
  return "";
}

function looksLikeSessionKey(key, parentKey) {
  return /session/i.test(key) || /session/i.test(parentKey);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function findRecentCodexSessionId(startedAt, expectedCwd) {
  const root = process.env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions");
  const files = await listRecentSessionFiles(root, startedAt - 5000);
  for (const file of files) {
    const session = await readSessionMeta(file.path);
    if (!session || session.cwd !== expectedCwd || !isUuid(session.id || "")) {
      continue;
    }
    return session.id;
  }
  return "";
}

async function listRecentSessionFiles(root, sinceMs) {
  const files = [];
  await walk(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const info = await stat(path);
      if (info.mtimeMs >= sinceMs) {
        files.push({ path, mtimeMs: info.mtimeMs });
      }
    }
  }
}

async function readSessionMeta(filePath) {
  const raw = await readOptionalFile(filePath);
  const firstLine = raw.split(/\r?\n/, 1)[0] || "";
  const event = safeJsonParse(firstLine);
  if (!event || event.type !== "session_meta" || !event.payload) {
    return null;
  }
  return {
    id: event.payload.id || "",
    cwd: event.payload.cwd || "",
  };
}

async function telegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Telegram ${method} HTTP ${response.status}`);
  }

  const body = await response.json();
  if (!body.ok) {
    throw new Error(`Telegram ${method} failed: ${body.description || "unknown error"}`);
  }
  return body.result;
}

async function sendMessage(chatId, text, threadId) {
  const payload = {
    chat_id: chatId,
    disable_web_page_preview: true,
    text,
  };
  if (threadId) {
    payload.message_thread_id = threadId;
  }
  return telegram("sendMessage", payload);
}

function splitTelegramMessage(text) {
  const chars = Array.from(text || "(empty)");
  const chunks = [];
  for (let index = 0; index < chars.length; index += TELEGRAM_CHUNK_LIMIT) {
    chunks.push(chars.slice(index, index + TELEGRAM_CHUNK_LIMIT).join(""));
  }
  return chunks.length > 0 ? chunks : ["(empty)"];
}

function buildSessionKey(chatId, threadId) {
  const raw = `${chatId}:${threadId || 0}`;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `chat-${sanitizeName(String(chatId))}-thread-${sanitizeName(String(threadId || 0))}-${digest}`;
}

function sanitizeName(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function sessionFilePath(sessionKey) {
  return join(SESSION_DIR, `${sessionKey}.json`);
}

async function readSession(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = await readFile(filePath, "utf8");
  return safeJsonParse(raw) || {};
}

async function writeSession(filePath, session) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseAllowedUserIds(raw) {
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
