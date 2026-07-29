#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const sessionId = process.env.CURATOR_TERMINAL_VERIFY_SESSION || '019f0ed6-029f-7d63-a5e2-c706bf7cbfec';
const baseUrl = process.env.CURATOR_TERMINAL_VERIFY_BASE_URL || 'http://127.0.0.1:54177/';
const chromeBin = process.env.CHROMIUM_BIN || process.env.CHROME_BIN || '/snap/bin/chromium';
const windowSize = process.env.CURATOR_TERMINAL_VERIFY_WINDOW || '2100,960';
const screenshotPath = process.env.CURATOR_TERMINAL_VERIFY_SCREENSHOT || '/tmp/curator-terminal-browser-e2e.png';
const agent = process.env.CURATOR_TERMINAL_VERIFY_AGENT === 'claude' ? 'claude' : 'codex';
const machineId = process.env.CURATOR_TERMINAL_VERIFY_MACHINE_ID || 'gpl001';
const sshTarget = process.env.CURATOR_TERMINAL_VERIFY_SSH_TARGET || '';
const sshCommand = process.env.CURATOR_TERMINAL_VERIFY_SSH_COMMAND || 'ssh';
const tmuxSocket = process.env.CURATOR_TERMINAL_VERIFY_TMUX_SOCKET || 'codex-curator';
const tmuxSession = `${agent}-curator-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}`;
const probeText = process.env.CURATOR_TERMINAL_VERIFY_PROBE || `CURATOR_TERMINAL_E2E_${'abcdefghij'.repeat(18)}`;
const submitProbe = process.env.CURATOR_TERMINAL_VERIFY_SUBMIT === '1';

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

async function waitForSessionMarker(token) {
  if (!submitProbe) return false;
  const deadline = Date.now() + Number(process.env.CURATOR_TERMINAL_VERIFY_SUBMIT_WAIT_MS || 45000);
  while (Date.now() < deadline) {
    try {
      const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}`, baseUrl);
      url.searchParams.set('admin_token', token);
      url.searchParams.set('ts', String(Date.now()));
      const response = await fetch(url);
      if (response.ok) {
        const session = await response.json();
        if (session.lastUserMessage?.text?.includes(probeText)) return true;
      }
    } catch {
      // Retry while the remote session cache and transcript update settle.
    }
    await delay(2000);
  }
  return false;
}

async function cdpCall(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(process.env.CURATOR_TERMINAL_VERIFY_CDP_TIMEOUT_MS || 10000);
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
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

function runTmux(args) {
  if (sshTarget) {
    const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const remoteCommand = ['tmux', '-L', tmuxSocket, ...args].map(quote).join(' ');
    return execFileSync(sshCommand, [sshTarget, remoteCommand], { encoding: 'utf8' });
  }
  return execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8' });
}

function tmuxClients() {
  try {
    return runTmux(['list-clients']);
  } catch {
    return '';
  }
}

function tmuxPaneContains(text) {
  try {
    const pane = runTmux(['capture-pane', '-p', '-t', tmuxSession, '-S', '-200']);
    return pane.includes(text);
  } catch {
    return false;
  }
}

function detachSessionClients() {
  try {
    runTmux(['detach-client', '-s', tmuxSession]);
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
  targetUrl.searchParams.set('machineId', machineId);
  targetUrl.searchParams.set('agent', agent);
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
    let probeFrameSent = false;
    const probeInputFrames = [];
    const inputFrameMeta = [];
    const terminalEvents = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(messageText(event));
      if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails?.text || 'exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
        consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '));
      }
      if (message.method === 'Network.webSocketFrameSent') {
        const payloadData = message.params.response?.payloadData || '';
        probeFrameSent ||= payloadData.includes(probeText);
        try {
          const input = JSON.parse(payloadData);
          if (input.type === 'input' && typeof input.data === 'string') {
            inputFrameMeta.push({
              length: input.data.length,
              hasCr: input.data.includes('\r'),
              hasLf: input.data.includes('\n'),
              firstCode: input.data.length ? input.data.charCodeAt(0) : null,
              lastCode: input.data.length ? input.data.charCodeAt(input.data.length - 1) : null,
            });
          }
        } catch {
          // Ignore non-JSON WebSocket frames.
        }
        if (payloadData.includes(probeText)) {
          try {
            const input = JSON.parse(payloadData);
            const data = typeof input.data === 'string' ? input.data : '';
            probeInputFrames.push({
              type: input.type ?? null,
              length: data.length,
              hasCr: data.includes('\r'),
              hasLf: data.includes('\n'),
              firstCode: data.length ? data.charCodeAt(0) : null,
              lastCode: data.length ? data.charCodeAt(data.length - 1) : null,
            });
          } catch {
            probeInputFrames.push({ type: 'unparsed', length: payloadData.length });
          }
        }
      }
      if (message.method === 'Network.webSocketFrameReceived') {
        try {
          const terminalEvent = JSON.parse(message.params.response?.payloadData || '{}');
          if (['ready', 'error', 'exit'].includes(terminalEvent.type)) {
            terminalEvents.push({
              type: terminalEvent.type,
              code: terminalEvent.code ?? null,
              signal: terminalEvent.signal ?? null,
              data: terminalEvent.type === 'error' ? terminalEvent.data : undefined,
            });
          }
        } catch {
          // Ignore non-JSON WebSocket frames.
        }
      }
    });

    await cdpCall(ws, id++, 'Runtime.enable');
    await cdpCall(ws, id++, 'Page.enable');
    await cdpCall(ws, id++, 'Network.enable');
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
    if (process.env.CURATOR_TERMINAL_VERIFY_ESCAPE_FIRST === '1') {
      await cdpCall(ws, id++, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await cdpCall(ws, id++, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await delay(600);
    }
    await cdpCall(ws, id++, 'Input.insertText', { text: probeText });
    if (submitProbe) {
      await cdpCall(ws, id++, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r',
      });
      await cdpCall(ws, id++, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
    }
    await delay(Number(process.env.CURATOR_TERMINAL_VERIFY_INPUT_WAIT_MS || 1800));

    const after = await evaluate(`(() => ({
      status: document.querySelector('.terminal-toolbar span')?.textContent || '',
      active: document.activeElement?.className || document.activeElement?.tagName,
      rows: [...document.querySelectorAll('.xterm-rows > div')].slice(-8).map((el) => el.textContent),
      bodyTail: document.body.innerText.slice(-1000)
    }))()`);
    const probeVisibleInTmux = tmuxPaneContains(probeText);
    const submittedMarkerRecorded = await waitForSessionMarker(token);

    if (!submitProbe) {
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
    }

    let screenshotError = null;
    try {
      const screenshot = await cdpCall(ws, id++, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    } catch (error) {
      screenshotError = error instanceof Error ? error.message : String(error);
    }
    ws.close();
    await delay(300);
    const clients = tmuxClients();
    detachSessionClients();

    const expectedStatus = `${agent === 'claude' ? 'Claude' : 'Codex'} 运行中`;
    const statusOk = before.status.includes(expectedStatus) && after.status.includes(expectedStatus);
    const inputOk = after.bodyTail.includes('CURATOR_TERMINAL_E2E_') || probeVisibleInTmux || submittedMarkerRecorded;
    const disconnected = `${before.status}\n${after.status}`.includes('断开');
    const ok = statusOk && inputOk && !disconnected && exceptions.length === 0 && consoleErrors.length === 0;
    const report = {
      ok,
    sessionId,
    machineId,
    agent,
      sshTarget: sshTarget || null,
      sshCommand: sshTarget ? sshCommand : null,
      baseUrl,
      windowSize,
      before,
      after,
      clients,
      probeVisibleInTmux,
      submittedMarkerRecorded,
      probeFrameSent,
      probeInputFrames,
      inputFrameMeta,
      terminalEvents,
      exceptions,
      consoleErrors,
      screenshot: screenshotError ? null : screenshotPath,
      screenshotError,
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
