#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const sessionId = process.env.CURATOR_TERMINAL_VERIFY_SESSION || '019f0ed6-029f-7d63-a5e2-c706bf7cbfec';
const baseUrl = process.env.CURATOR_TERMINAL_VERIFY_BASE_URL || 'http://127.0.0.1:54177/';
const chromeBin = process.env.CHROMIUM_BIN || process.env.CHROME_BIN || '/snap/bin/chromium';
const windowSize = process.env.CURATOR_TERMINAL_VERIFY_WINDOW || '2100,960';
const screenshotPath = process.env.CURATOR_TERMINAL_VERIFY_SCREENSHOT || '/tmp/curator-terminal-browser-e2e.png';
const probeText = `CURATOR_TERMINAL_E2E_${'abcdefghij'.repeat(18)}`;

function readAdminToken() {
  const authEnv = readFileSync(join(homedir(), '.config/codex-session-curator/auth.env'), 'utf8');
  const line = authEnv.split(/\r?\n/).find((entry) => entry.startsWith('CURATOR_ADMIN_TOKEN='));
  if (!line) throw new Error('CURATOR_ADMIN_TOKEN is missing from auth.env');
  return line.slice('CURATOR_ADMIN_TOKEN='.length).replace(/^['"]|['"]$/g, '');
}

function messageText(event) {
  if (typeof event === 'string') return event;
  if (typeof event?.data === 'string') return event.data;
  if (Buffer.isBuffer(event?.data)) return event.data.toString('utf8');
  if (Buffer.isBuffer(event)) return event.toString('utf8');
  return String(event?.data ?? event);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpCall(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(messageText(event));
      if (message.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    ws.addEventListener('message', onMessage);
  });
}

function tmuxClients() {
  try {
    return execSync(
      "tmux -L codex-curator list-clients -F '#{client_session} #{client_width}x#{client_height} #{client_tty}' 2>/dev/null || true",
      { encoding: 'utf8' }
    );
  } catch {
    return '';
  }
}

function detachSessionClients() {
  try {
    execSync(`tmux -L codex-curator detach-client -s ${JSON.stringify(`codex-curator-${sessionId}`)} 2>/dev/null || true`);
  } catch {
    // tmux may not be running, or the test may target a remote machine.
  }
}

async function main() {
  const token = readAdminToken();
  const remoteDebuggingPort = 23000 + Math.floor(Math.random() * 1000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'curator-terminal-e2e-'));
  const targetUrl = new URL(baseUrl);
  targetUrl.searchParams.set('terminal', sessionId);
  targetUrl.searchParams.set('admin_token', token);

  detachSessionClients();
  const chrome = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${remoteDebuggingPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--window-size=${windowSize}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/version`);
        if (response.ok) break;
      } catch {
        // Chrome is still starting.
      }
      await delay(100);
    }

    const targetResponse = await fetch(
      `http://127.0.0.1:${remoteDebuggingPort}/json/new?${encodeURIComponent(targetUrl.toString())}`,
      { method: 'PUT' }
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
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
        consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '));
      }
    });

    await cdpCall(ws, id++, 'Runtime.enable');
    await cdpCall(ws, id++, 'Page.enable');
    await delay(Number(process.env.CURATOR_TERMINAL_VERIFY_WAIT_MS || 9000));

    async function evaluate(expression) {
      const result = await cdpCall(ws, id++, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return result.result.value;
    }

    const before = await evaluate(`(() => {
      const q = (selector) => document.querySelector(selector);
      const box = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        status: q('.terminal-toolbar span')?.textContent || '',
        rows: [...document.querySelectorAll('.xterm-rows > div')].length,
        screen: box(q('.xterm-screen')),
        root: box(q('.terminal-surface .xterm')),
        bodyTail: document.body.innerText.slice(-800),
        url: location.href.replace(/admin_token=[^&]+/, 'admin_token=[redacted]')
      };
    })()`);

    await evaluate(`document.querySelector('.xterm-helper-textarea')?.focus(); true`);
    await cdpCall(ws, id++, 'Input.insertText', { text: probeText });
    await delay(1800);

    const after = await evaluate(`(() => ({
      status: document.querySelector('.terminal-toolbar span')?.textContent || '',
      active: document.activeElement?.className || document.activeElement?.tagName,
      rows: [...document.querySelectorAll('.xterm-rows > div')].slice(-8).map((el) => el.textContent),
      bodyTail: document.body.innerText.slice(-1000)
    }))()`);

    await cdpCall(ws, id++, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'u',
      code: 'KeyU',
      windowsVirtualKeyCode: 85,
      modifiers: 2,
    });
    await cdpCall(ws, id++, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'u',
      code: 'KeyU',
      windowsVirtualKeyCode: 85,
      modifiers: 2,
    });

    const screenshot = await cdpCall(ws, id++, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    ws.close();
    await delay(300);
    const clients = tmuxClients();
    detachSessionClients();

    const statusOk = before.status.includes('Codex 运行中') && after.status.includes('Codex 运行中');
    const inputOk = after.bodyTail.includes('CURATOR_TERMINAL_E2E_');
    const disconnected = `${before.status}\n${after.status}\n${after.bodyTail}`.includes('断开');
    const ok = statusOk && inputOk && !disconnected && exceptions.length === 0 && consoleErrors.length === 0;
    const report = {
      ok,
      sessionId,
      baseUrl,
      windowSize,
      before,
      after,
      clients,
      exceptions,
      consoleErrors,
      screenshot: screenshotPath,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(ok ? 0 : 2);
  } finally {
    chrome.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
