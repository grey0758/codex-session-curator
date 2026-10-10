#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.env.CURATOR_FOLLOW_UP_VERIFY_BASE_URL || 'http://127.0.0.1:54177/?view=notifications';
const authBaseUrl = process.env.CURATOR_FOLLOW_UP_VERIFY_AUTH_BASE_URL || 'http://127.0.0.1:54177/';
const chromeBin = process.env.CHROMIUM_BIN || process.env.CHROME_BIN || '/snap/bin/chromium';

function adminToken() {
  const env = readFileSync(join(homedir(), '.config/codex-session-curator/auth.env'), 'utf8');
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith('CURATOR_ADMIN_TOKEN='));
  if (!line) throw new Error('Admin token is unavailable');
  return line.slice('CURATOR_ADMIN_TOKEN='.length).replace(/^['"]|['"]$/g, '');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const port = 25000 + Math.floor(Math.random() * 1000);
  const profile = mkdtempSync(join(tmpdir(), 'curator-follow-up-e2e-'));
  const authUrl = new URL(authBaseUrl);
  authUrl.searchParams.set('admin_token', adminToken());
  const chrome = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--window-size=1500,1000', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { /* starting */ }
      if (ready) break;
      await delay(100);
    }
    if (!ready) throw new Error('Chromium did not start');
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(authUrl.toString())}`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    try {
      let nextId = 1;
      function cdp(method, params = {}) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { ws.removeEventListener('message', onMessage); reject(new Error(`${method} timed out`)); }, 20_000);
          function onMessage(event) {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            if (message.error) reject(new Error(`${method} failed`));
            else resolve(message.result);
          }
          ws.addEventListener('message', onMessage);
        });
      }
      async function evaluate(expression) {
        const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error('Browser evaluation failed');
        return result.result.value;
      }
      async function waitFor(expression, predicate, label) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const result = await evaluate(expression);
          if (predicate(result)) return result;
          await delay(150);
        }
        throw new Error(`${label} timed out`);
      }

      await cdp('Runtime.enable');
      await cdp('Page.enable');
      await delay(700);
      await cdp('Page.navigate', { url: baseUrl });
      await waitFor('Boolean(document.querySelector(".followup-controls button"))', Boolean, 'reminder controls');
      await evaluate('document.querySelector(".followup-controls button:nth-child(2)")?.click()');
      const identities = await waitFor(
        '[...document.querySelectorAll(".followup-row")].map((row) => ({ id: row.dataset.sessionId, machineId: row.dataset.machineId, agent: row.dataset.agent }))',
        (rows) => rows.length > 1,
        'multiple reminder rows',
      );
      const candidates = identities.slice(0, 2);
      for (const identity of candidates) {
        const expected = await evaluate(`(async () => {
          const params = new URLSearchParams({ limit: '4', machineId: ${JSON.stringify(identity.machineId)}, agent: ${JSON.stringify(identity.agent)} });
          const response = await fetch('/api/sessions/' + encodeURIComponent(${JSON.stringify(identity.id)}) + '/recent-user-messages?' + params);
          if (!response.ok) return null;
          const payload = await response.json();
          return (payload.messages || []).map((message) => message.text).reverse();
        })()`);
        if (!expected?.length) throw new Error('Selected reminder has no recent user messages');
        await evaluate(`([...document.querySelectorAll('.followup-row')].find((row) =>
          row.dataset.sessionId === ${JSON.stringify(identity.id)} && row.dataset.machineId === ${JSON.stringify(identity.machineId)} && row.dataset.agent === ${JSON.stringify(identity.agent)})?.click(), true)`);
        await waitFor(
          `(() => {
            const dialogue = document.querySelector('.followup-recent-card .recent-dialogue');
            return { id: dialogue?.dataset.sessionId, busy: dialogue?.getAttribute('aria-busy'), messages: [...(dialogue?.querySelectorAll('[data-recent-user-message]') || [])].map((card) => card.querySelector('.recent-message-text')?.textContent) };
          })()`,
          (actual) => actual.id === identity.id && actual.busy === 'false' && JSON.stringify(actual.messages) === JSON.stringify(expected),
          'recent dialogue for selected reminder',
        );
      }
      const hasExpandButton = await evaluate(`(() => {
        const button = document.querySelector('.followup-recent-card .recent-message-toggle');
        button?.click();
        return Boolean(button);
      })()`);
      if (hasExpandButton) await waitFor(
        'document.querySelector(".followup-recent-card .recent-message-toggle")?.getAttribute("aria-expanded")',
        (value) => value === 'true',
        'recent message expansion',
      );
      process.stdout.write(`Notification recent dialogue verified for ${candidates.length} sessions.\n`);
    } finally { ws.close(); }
  } finally {
    chrome.kill('SIGTERM');
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
