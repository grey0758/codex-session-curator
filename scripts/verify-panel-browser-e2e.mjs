#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.env.CURATOR_PANEL_VERIFY_BASE_URL || 'http://127.0.0.1:54177/';
const query = process.env.CURATOR_PANEL_VERIFY_QUERY || 'codex-session-curator';
const aiQuery = process.env.CURATOR_PANEL_VERIFY_AI_QUERY || 'cnal002的工作站';
const chromeBin = process.env.CHROMIUM_BIN || process.env.CHROME_BIN || '/snap/bin/chromium';
const waitMs = Number(process.env.CURATOR_PANEL_VERIFY_WAIT_MS || 15000);
const cdpTimeoutMs = Number(process.env.CURATOR_PANEL_VERIFY_CDP_TIMEOUT_MS || 30000);

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
      reject(new Error(`${method}: timed out after ${cdpTimeoutMs}ms`));
    }, cdpTimeoutMs);
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
  const remoteDebuggingPort = 24000 + Math.floor(Math.random() * 1000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'curator-panel-e2e-'));
  const targetUrl = new URL(baseUrl);
  targetUrl.searchParams.set('admin_token', token);
  const chrome = spawn(
    chromeBin,
    [
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
    ],
    { stdio: 'ignore' }
  );

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
    await delay(waitMs);

    async function evaluate(expression) {
      const result = await cdpCall(ws, id++, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return result.result.value;
    }

    async function waitFor(expression, predicate, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await evaluate(expression);
        if (predicate(value)) return value;
        await delay(100);
      }
      throw new Error(`${label}: timed out after ${timeoutMs}ms`);
    }

    async function setSearchQuery(value) {
      await evaluate(`(() => {
        const input = document.querySelector('input[data-session-filter]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    }

    async function selectAgentFilter(agent) {
      await evaluate(`(() => {
        const button = document.querySelector('.agent-switch button[data-agent-filter=${JSON.stringify(agent)}]');
        button?.click();
        return Boolean(button);
      })()`);
    }

    async function focusSession(sessionId) {
      await setSearchQuery(sessionId);
      await waitFor(
        `Boolean([...document.querySelectorAll('.session-row[data-session-id]')].find((row) => row.dataset.sessionId === ${JSON.stringify(sessionId)}))`,
        Boolean,
        `session row ${sessionId}`
      );
      await evaluate(`(() => {
        const row = [...document.querySelectorAll('.session-row[data-session-id]')]
          .find((entry) => entry.dataset.sessionId === ${JSON.stringify(sessionId)});
        row?.click();
        return Boolean(row);
      })()`);
    }

    async function focusSessionIdentity(sessionId, machineId, agent) {
      await setSearchQuery(sessionId);
      const selector = `.session-row[data-session-id=${JSON.stringify(sessionId)}][data-machine-id=${JSON.stringify(machineId)}][data-agent=${JSON.stringify(agent)}]`;
      await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, Boolean, `session row ${machineId}/${agent}/${sessionId}`);
      await evaluate(`(() => {
        const row = document.querySelector(${JSON.stringify(selector)});
        row?.click();
        return Boolean(row);
      })()`);
    }

    await waitFor(
      `document.querySelector('.audit-summary span')?.textContent || ''`,
      (value) => value.includes('稳定会话 AI 覆盖') || value.includes('链路审计失败'),
      'fleet audit summary',
      60000
    );

    const before = await evaluate(`(() => ({
      loginVisible: Boolean(document.querySelector('.login-shell')),
      searchVisible: Boolean(document.querySelector('input[data-session-filter]')),
      aiSearchVisible: Boolean(document.querySelector('[data-ai-session-search] #ai-session-search-input')),
      sessionRows: document.querySelectorAll('.session-row').length,
      sessionGroups: document.querySelectorAll('.session-group').length,
      loadingVisible: document.body.innerText.includes('正在加载'),
      loadErrorVisible: document.body.innerText.includes('加载失败'),
      auditSummaryText: document.querySelector('.audit-summary span')?.textContent || ''
    }))()`);

    const agentCandidates = await evaluate(`(async () => {
      const response = await fetch('/api/sessions?detail=0');
      if (!response.ok) return null;
      const payload = await response.json();
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      const byMachine = new Map();
      for (const session of sessions) {
        if (!session?.machineId || !['codex', 'claude'].includes(session.agent)) continue;
        const agents = byMachine.get(session.machineId) || new Set();
        agents.add(session.agent);
        byMachine.set(session.machineId, agents);
      }
      const sessionsById = new Map();
      for (const session of sessions) {
        const identities = sessionsById.get(session.id) || [];
        identities.push({ id: session.id, machineId: session.machineId, agent: session.agent });
        sessionsById.set(session.id, identities);
      }
      const duplicateIdentities = [...sessionsById.values()]
        .find((identities) => new Set(identities.map((entry) => entry.machineId + '|||' + entry.agent)).size > 1)
        ?.slice(0, 2) || [];
      const sharedMachine = [...byMachine.entries()].find(([, agents]) => agents.has('codex') && agents.has('claude'))?.[0] || null;
      return {
        sharedMachine,
        codexId: sessions.find((session) => session.agent === 'codex')?.id || null,
        claudeId: sessions.find((session) => session.agent === 'claude')?.id || null,
        duplicateIdentities
      };
    })()`);
    if (!agentCandidates?.sharedMachine || !agentCandidates.codexId || !agentCandidates.claudeId) {
      throw new Error('agent filter verification needs indexed Codex and Claude sessions on one machine');
    }

    const agentFilterSnapshotExpression = `(() => {
      const buttons = [...document.querySelectorAll('.agent-switch button[data-agent-filter]')];
      const rows = [...document.querySelectorAll('.session-row[data-agent]')];
      return {
        active: buttons.find((button) => button.classList.contains('active'))?.dataset.agentFilter || null,
        labels: buttons.map((button) => button.querySelector('span')?.textContent || ''),
        counts: Object.fromEntries(buttons.map((button) => [button.dataset.agentFilter, Number(button.querySelector('em')?.textContent || 0)])),
        agents: rows.map((row) => row.dataset.agent || '')
      };
    })()`;

    await setSearchQuery(agentCandidates.sharedMachine);
    await selectAgentFilter('all');
    const allAgents = await waitFor(
      agentFilterSnapshotExpression,
      (value) => value.active === 'all' && value.agents.includes('codex') && value.agents.includes('claude'),
      'all agent filter'
    );
    await selectAgentFilter('codex');
    const codexAgents = await waitFor(
      agentFilterSnapshotExpression,
      (value) => value.active === 'codex' && value.agents.length > 0 && value.agents.every((agent) => agent === 'codex'),
      'Codex agent filter'
    );
    await selectAgentFilter('claude');
    const claudeAgents = await waitFor(
      agentFilterSnapshotExpression,
      (value) => value.active === 'claude' && value.agents.length > 0 && value.agents.every((agent) => agent === 'claude'),
      'Claude agent filter'
    );
    await selectAgentFilter('all');

    const agentFilterOk =
      JSON.stringify(allAgents.labels) === JSON.stringify(['全部', 'Codex', 'Claude']) &&
      allAgents.counts.all === allAgents.counts.codex + allAgents.counts.claude &&
      allAgents.counts.codex > 0 &&
      allAgents.counts.claude > 0 &&
      codexAgents.agents.every((agent) => agent === 'codex') &&
      claudeAgents.agents.every((agent) => agent === 'claude');

    let duplicateIdentityOk = agentCandidates.duplicateIdentities.length < 2;
    if (agentCandidates.duplicateIdentities.length >= 2) {
      const [firstIdentity, secondIdentity] = agentCandidates.duplicateIdentities;
      await selectAgentFilter('all');
      await focusSessionIdentity(firstIdentity.id, firstIdentity.machineId, firstIdentity.agent);
      const firstSelection = await evaluate(`(() => {
        const selected = [...document.querySelectorAll('.session-row.selected')];
        const target = [...document.querySelectorAll('.session-row')].find((row) =>
          row.dataset.sessionId === ${JSON.stringify(firstIdentity.id)} &&
          row.dataset.machineId === ${JSON.stringify(firstIdentity.machineId)} &&
          row.dataset.agent === ${JSON.stringify(firstIdentity.agent)}
        );
        target?.querySelector('input.session-checkbox')?.click();
        return {
          selected: selected.map((row) => [row.dataset.machineId, row.dataset.agent, row.dataset.sessionId]),
          checked: [...document.querySelectorAll('.session-row input.session-checkbox:checked')].length
        };
      })()`);
      await focusSessionIdentity(secondIdentity.id, secondIdentity.machineId, secondIdentity.agent);
      const secondSelection = await evaluate(`(() => {
        const selected = [...document.querySelectorAll('.session-row.selected')];
        const checked = [...document.querySelectorAll('.session-row input.session-checkbox:checked')];
        checked.forEach((input) => input.click());
        return {
          selected: selected.map((row) => [row.dataset.machineId, row.dataset.agent, row.dataset.sessionId]),
          checked: checked.length
        };
      })()`);
      duplicateIdentityOk =
        firstSelection.selected.length === 1 &&
        firstSelection.selected[0][0] === firstIdentity.machineId &&
        firstSelection.selected[0][1] === firstIdentity.agent &&
        firstSelection.checked === 1 &&
        secondSelection.selected.length === 1 &&
        secondSelection.selected[0][0] === secondIdentity.machineId &&
        secondSelection.selected[0][1] === secondIdentity.agent &&
        secondSelection.checked === 1;
    }

    await setSearchQuery(query);
    await delay(700);

    const after = await evaluate(`(() => ({
      sessionRows: document.querySelectorAll('.session-row').length,
      emptyVisible: document.body.innerText.includes('暂无'),
      loadErrorVisible: document.body.innerText.includes('加载失败')
    }))()`);

    const recentCandidates = await evaluate(`(async () => {
      const rows = [...document.querySelectorAll('.session-row[data-session-id]')];
      const inactiveRows = rows.filter((row) => row.querySelector('.session-time')?.textContent?.includes('非活跃'));
      const visibleIds = [...inactiveRows, ...rows].map((row) => row.dataset.sessionId).filter(Boolean);
      const sessionIds = [...new Set(visibleIds)].slice(0, 2);
      const candidates = [];
      const histories = await Promise.all(sessionIds.map(async (sessionId) => {
        try {
          const historyResponse = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/history?limit=200');
          if (!historyResponse.ok) return null;
          const history = await historyResponse.json();
          const messages = (history.messages || [])
            .filter((message) => message.role === 'user')
            .slice(-4)
            .reverse()
            .map((message) => message.text);
          return messages.length ? { sessionId, messages } : null;
        } catch {
          return null;
        }
      }));
      for (const candidate of histories) {
        if (!candidate) continue;
        if (candidates.some((entry) => JSON.stringify(entry.messages) === JSON.stringify(candidate.messages))) continue;
        candidates.push(candidate);
        if (candidates.length === 2) break;
      }
      candidates.sort((left, right) =>
        Math.max(...right.messages.map((message) => message.length)) -
        Math.max(...left.messages.map((message) => message.length))
      );
      return candidates;
    })()`);
    if (recentCandidates.length < 2) throw new Error('recent dialogue verification needs two distinct sessions');

    const [firstCandidate, secondCandidate] = recentCandidates;
    const recentSnapshotExpression = `(() => {
      const section = document.querySelector('.recent-dialogue');
      const cards = section ? [...section.querySelectorAll('[data-recent-user-message]')] : [];
      const panel = section?.closest('.primary-panel');
      const heading = panel?.querySelector('.panel-heading');
      return {
        sessionId: section?.dataset.sessionId || null,
        busy: section?.getAttribute('aria-busy') === 'true',
        selectedRows: [...document.querySelectorAll('.session-row.selected')].map((row) => ({
          sessionId: row.dataset.sessionId || null,
          machineId: row.dataset.machineId || null
        })),
        messages: cards.map((card) => card.querySelector('p')?.textContent || ''),
        roles: cards.map((card) => card.dataset.role || ''),
        lineClamps: cards.map((card) => getComputedStyle(card.querySelector('p')).webkitLineClamp),
        expandableCount: cards.filter((card) => card.querySelector('.recent-message-toggle')).length,
        agentReplyVisible: document.body.innerText.includes('Agent 最后回复'),
        refreshStatusVisible: Boolean(heading?.textContent?.includes('已 AI 重算')),
        refreshButtonVisible: [...(heading?.querySelectorAll('button') || [])]
          .some((button) => button.textContent?.includes('重算当前'))
      };
    })()`;

    await focusSession(firstCandidate.sessionId);
    const firstRecent = await waitFor(
      recentSnapshotExpression,
      (value) =>
        value.sessionId === firstCandidate.sessionId &&
        !value.busy &&
        JSON.stringify(value.messages) === JSON.stringify(firstCandidate.messages),
      'first recent dialogue'
    );

    await waitFor(
      `Boolean(document.querySelector('.recent-dialogue .recent-message-toggle'))`,
      Boolean,
      'recent dialogue expand control'
    );
    const expansionBefore = await evaluate(`(() => {
      const button = document.querySelector('.recent-dialogue .recent-message-toggle');
      const card = button?.closest('[data-recent-user-message]');
      const paragraph = card?.querySelector('.recent-message-text');
      const result = {
        available: Boolean(button && card && paragraph),
        lineClamp: paragraph ? getComputedStyle(paragraph).webkitLineClamp : null,
        collapsed: paragraph ? paragraph.clientHeight < paragraph.scrollHeight : false
      };
      button?.click();
      return result;
    })()`);
    await delay(150);
    const expansionAfter = await evaluate(`(() => {
      const button = document.querySelector('.recent-dialogue .recent-message-toggle');
      const card = button?.closest('[data-recent-user-message]');
      const paragraph = card?.querySelector('.recent-message-text');
      return {
        expanded: card?.classList.contains('expanded') === true,
        ariaExpanded: button?.getAttribute('aria-expanded') === 'true',
        fullHeight: paragraph ? paragraph.clientHeight >= paragraph.scrollHeight - 1 : false
      };
    })()`);

    await evaluate(`(() => {
      const originalFetch = window.fetch.bind(window);
      window.__curatorPanelOriginalFetch = originalFetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (url.includes(${JSON.stringify(`/api/sessions/${encodeURIComponent(secondCandidate.sessionId)}/history?limit=200`)})) {
          return new Promise((resolve) => setTimeout(resolve, 1200)).then(() => originalFetch(input, init));
        }
        return originalFetch(input, init);
      };
      return true;
    })()`);

    await focusSession(secondCandidate.sessionId);
    const transitionRecent = await waitFor(
      recentSnapshotExpression,
      (value) => value.sessionId === secondCandidate.sessionId,
      'recent dialogue session switch',
      700
    );
    const secondRecent = await waitFor(
      recentSnapshotExpression,
      (value) =>
        value.sessionId === secondCandidate.sessionId &&
        !value.busy &&
        JSON.stringify(value.messages) === JSON.stringify(secondCandidate.messages),
      'second recent dialogue'
    );
    await evaluate(`(() => {
      if (window.__curatorPanelOriginalFetch) window.fetch = window.__curatorPanelOriginalFetch;
      delete window.__curatorPanelOriginalFetch;
      return true;
    })()`);

    const recentOk =
      firstRecent.messages.length >= 1 &&
      firstRecent.messages.length <= 4 &&
      firstRecent.roles.every((role) => role === 'user') &&
      firstRecent.selectedRows.length === 1 &&
      firstRecent.selectedRows[0].sessionId === firstCandidate.sessionId &&
      firstRecent.lineClamps.every((value) => value === '6') &&
      !firstRecent.agentReplyVisible &&
      !firstRecent.refreshStatusVisible &&
      !firstRecent.refreshButtonVisible &&
      expansionBefore.available &&
      expansionBefore.lineClamp === '6' &&
      expansionBefore.collapsed &&
      expansionAfter.expanded &&
      expansionAfter.ariaExpanded &&
      expansionAfter.fullHeight &&
      transitionRecent.busy &&
      transitionRecent.selectedRows.length === 1 &&
      transitionRecent.selectedRows[0].sessionId === secondCandidate.sessionId &&
      transitionRecent.messages.length === 0 &&
      secondRecent.messages.length >= 1 &&
      secondRecent.messages.length <= 4 &&
      secondRecent.selectedRows.length === 1 &&
      secondRecent.selectedRows[0].sessionId === secondCandidate.sessionId &&
      secondRecent.roles.every((role) => role === 'user') &&
      !secondRecent.agentReplyVisible;

    await evaluate(`(() => {
      const input = document.querySelector('#ai-session-search-input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(aiQuery)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form')?.requestSubmit();
      return true;
    })()`);
    const aiSearch = await waitFor(
      `(() => {
        const status = document.querySelector('[data-ai-search-mode]');
        const rows = [...document.querySelectorAll('.session-row[data-machine-id]')];
        return {
          mode: status?.getAttribute('data-ai-search-mode') || null,
          text: status?.textContent || '',
          machines: [...new Set(rows.map((row) => row.dataset.machineId).filter(Boolean))],
          resultCount: document.querySelectorAll('[data-ai-search-result]').length
        };
      })()`,
      (value) => value.mode === 'deepseek' || value.mode === 'fallback-local' || value.mode === 'error',
      'AI cross-machine search',
      20000
    );
    const aiSearchOk =
      aiSearch.mode === 'deepseek' &&
      aiSearch.text.includes('机器 cnal002') &&
      aiSearch.resultCount > 0 &&
      aiSearch.machines.length === 1 &&
      aiSearch.machines[0] === 'cnal002';
    ws.close();

    const ok =
      !before.loginVisible &&
      before.searchVisible &&
      before.aiSearchVisible &&
      before.sessionGroups > 0 &&
      after.sessionRows > 0 &&
      !before.loadErrorVisible &&
      !after.loadErrorVisible &&
      before.auditSummaryText.includes('稳定会话 AI 覆盖') &&
      before.auditSummaryText.includes('真正遗漏') &&
      agentFilterOk &&
      duplicateIdentityOk &&
      recentOk &&
      aiSearchOk &&
      exceptions.length === 0 &&
      consoleErrors.length === 0;
    console.log(JSON.stringify({
      ok,
      baseUrl,
      query,
      before,
      after,
      agentFilter: {
        ok: agentFilterOk,
        machineId: agentCandidates.sharedMachine,
        counts: allAgents.counts,
        codexRows: codexAgents.agents.length,
        claudeRows: claudeAgents.agents.length,
      },
      duplicateIdentity: {
        ok: duplicateIdentityOk,
        candidates: agentCandidates.duplicateIdentities,
      },
      recent: {
        ok: recentOk,
        firstSessionId: firstCandidate.sessionId,
        firstCount: firstRecent.messages.length,
        sixLineClamp: expansionBefore.lineClamp === '6',
        expandsFully: expansionAfter.fullHeight,
        refreshControlsVisible: firstRecent.refreshStatusVisible || firstRecent.refreshButtonVisible,
        transitionCleared: transitionRecent.messages.length === 0,
        secondSessionId: secondCandidate.sessionId,
        secondCount: secondRecent.messages.length,
        agentReplyVisible: firstRecent.agentReplyVisible || secondRecent.agentReplyVisible,
      },
      aiSearch: {
        ok: aiSearchOk,
        query: aiQuery,
        mode: aiSearch.mode,
        machines: aiSearch.machines,
        resultCount: aiSearch.resultCount,
      },
      exceptions,
      consoleErrors,
    }, null, 2));
    process.exit(ok ? 0 : 2);
  } finally {
    chrome.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
