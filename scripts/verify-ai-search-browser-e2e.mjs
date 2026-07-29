#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.env.CURATOR_PANEL_VERIFY_BASE_URL || 'http://127.0.0.1:54177/';
const query = process.env.CURATOR_PANEL_VERIFY_AI_QUERY || 'cnal002的工作站';
const expectedMachine = process.env.CURATOR_PANEL_VERIFY_AI_MACHINE || 'cnal002';
const chromeBin = process.env.CHROMIUM_BIN || process.env.CHROME_BIN || '/snap/bin/chromium';
const timeoutMs = Number(process.env.CURATOR_PANEL_VERIFY_AI_TIMEOUT_MS || 30000);

function readAdminToken() {
  const authEnv = readFileSync(join(homedir(), '.config/codex-session-curator/auth.env'), 'utf8');
  const line = authEnv.split(/\r?\n/).find((entry) => entry.startsWith('CURATOR_ADMIN_TOKEN='));
  if (!line) throw new Error('CURATOR_ADMIN_TOKEN is missing from auth.env');
  return line.slice('CURATOR_ADMIN_TOKEN='.length).replace(/^['"]|['"]$/g, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(event) {
  if (typeof event === 'string') return event;
  if (typeof event?.data === 'string') return event.data;
  if (Buffer.isBuffer(event?.data)) return event.data.toString('utf8');
  if (Buffer.isBuffer(event)) return event.toString('utf8');
  return String(event?.data ?? event);
}

async function cdpCall(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`${method}: timed out`));
    }, timeoutMs);
    const onMessage = (event) => {
      const message = JSON.parse(messageText(event));
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    ws.addEventListener('message', onMessage);
  });
}

async function main() {
  const token = readAdminToken();
  const remoteDebuggingPort = 25000 + Math.floor(Math.random() * 1000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'curator-ai-search-e2e-'));
  const targetUrl = new URL(baseUrl);
  targetUrl.searchParams.set('admin_token', token);
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${remoteDebuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--window-size=1600,1000',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/version`);
        if (response.ok) break;
      } catch {
        // Chromium is still starting.
      }
      await delay(100);
    }
    const targetResponse = await fetch(
      `http://127.0.0.1:${remoteDebuggingPort}/json/new?${encodeURIComponent(targetUrl.toString())}`,
      { method: 'PUT' },
    );
    const target = await targetResponse.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let id = 1;
    const exceptions = [];
    const consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(messageText(event));
      if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails?.text || 'exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '));
      }
    });
    await cdpCall(ws, id++, 'Runtime.enable');
    await cdpCall(ws, id++, 'Page.enable');

    async function evaluate(expression) {
      const result = await cdpCall(ws, id++, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return result.result.value;
    }

    const inputDeadline = Date.now() + timeoutMs;
    while (Date.now() < inputDeadline) {
      if (await evaluate(`Boolean(document.querySelector('#ai-session-search-input'))`)) break;
      await delay(100);
    }
    const startedAt = Date.now();
    const submitted = await evaluate(`(() => {
      const input = document.querySelector('#ai-session-search-input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form')?.requestSubmit();
      return true;
    })()`);
    if (!submitted) throw new Error('AI search input was not available');

    let snapshot = null;
    const resultDeadline = Date.now() + timeoutMs;
    while (Date.now() < resultDeadline) {
      snapshot = await evaluate(`(() => {
        const status = document.querySelector('[data-ai-search-mode]');
        const rows = [...document.querySelectorAll('.session-row[data-machine-id]')];
        return {
          mode: status?.getAttribute('data-ai-search-mode') || null,
          text: status?.textContent || '',
          machines: [...new Set(rows.map((row) => row.dataset.machineId).filter(Boolean))],
          resultCount: document.querySelectorAll('[data-ai-search-result]').length
        };
      })()`);
      if (['deepseek', 'fallback-local', 'error'].includes(snapshot?.mode)) break;
      await delay(100);
    }
    const ok =
      snapshot?.mode === 'deepseek' &&
      snapshot.text.includes(`机器 ${expectedMachine}`) &&
      snapshot.resultCount > 0 &&
      snapshot.machines.length === 1 &&
      snapshot.machines[0] === expectedMachine &&
      exceptions.length === 0 &&
      consoleErrors.length === 0;
    console.log(JSON.stringify({
      ok,
      baseUrl,
      query,
      expectedMachine,
      latencyMs: Date.now() - startedAt,
      result: snapshot,
      exceptions,
      consoleErrors,
    }, null, 2));
    ws.close();
    if (!ok) process.exitCode = 2;
  } finally {
    chrome.kill('SIGTERM');
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
