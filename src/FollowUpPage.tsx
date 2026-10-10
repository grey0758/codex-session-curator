import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Bell, CheckCheck, Clock3, Copy, Loader2, RefreshCw, Search, Sparkles, Terminal, Undo2 } from 'lucide-react';
import { RecentUserMessages } from './RecentUserMessages';
import { sessionKey } from './RecentUserMessagesData';
import { terminalPageUrl } from './session-files-routing';
import './FollowUpPage.css';

interface FollowUpItem {
  key: string;
  version: string;
  sessionId: string;
  machineId: string;
  agent: 'codex' | 'claude';
  title: string;
  cwd: string | null;
  ownerUser: string;
  endedAt: string;
  analyzedAt: string;
  dismissedAt: string | null;
  needsFollowUp: boolean;
  priority: 'high' | 'normal' | 'low';
  previousTaskSummary: string;
  reason: string;
  suggestedPrompt: string;
  model: string;
}

interface Payload {
  items: FollowUpItem[];
  scanning: boolean;
  lastScanAt: string | null;
  error: string | null;
  windowHours: number;
}

const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(new Date(value));

function panelUrl(item: FollowUpItem): string {
  const query = new URLSearchParams({ session: item.sessionId, machine: item.machineId, agent: item.agent });
  return `/?${query}`;
}

export function FollowUpPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all' | 'done'>('pending');
  const [sort, setSort] = useState<'recent' | 'oldest'>('recent');
  const [query, setQuery] = useState('');
  const [aiKeys, setAiKeys] = useState<string[] | null>(null);
  const [aiMode, setAiMode] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/follow-ups', { cache: 'no-cache' });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPayload(await response.json() as Payload);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提醒中心加载失败');
    }
  }, [onUnauthorized]);

  useEffect(() => {
    const start = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 20_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearTimeout(start); window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [load]);

  const items = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (payload?.items ?? []).filter((item) => {
      if (filter === 'pending' && (!item.needsFollowUp || item.dismissedAt)) return false;
      if (filter === 'done' && !item.dismissedAt) return false;
      if (aiKeys && !aiKeys.includes(item.key)) return false;
      if (needle && !aiKeys && ![item.title, item.previousTaskSummary, item.reason, item.suggestedPrompt, item.cwd ?? '', item.machineId, item.ownerUser]
        .some((part) => part.toLocaleLowerCase().includes(needle))) return false;
      return true;
    }).sort((a, b) => (sort === 'recent' ? -1 : 1) * (Date.parse(a.endedAt) - Date.parse(b.endedAt)));
  }, [aiKeys, filter, payload, query, sort]);
  const selected = items.find((item) => item.key === selectedKey) ?? items[0] ?? null;
  const pendingCount = (payload?.items ?? []).filter((item) => item.needsFollowUp && !item.dismissedAt).length;
  const draftKey = selected ? `${selected.key}:${selected.version}` : '';
  const draft = selected ? drafts[draftKey] ?? selected.suggestedPrompt : '';

  async function searchWithAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setAiBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/follow-ups/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as { keys: string[]; mode: string; error?: string };
      setAiKeys(result.keys);
      setAiMode(result.mode);
      if (result.error) setNotice(`AI 搜索暂不可用，已使用本地搜索：${result.error}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'AI 搜索失败');
    } finally { setAiBusy(false); }
  }

  async function dismiss(item: FollowUpItem, value: boolean) {
    setBusy(true);
    try {
      const response = await fetch('/api/follow-ups/dismiss', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: item.key, version: item.version, dismissed: value }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '更新提醒失败');
    } finally { setBusy(false); }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(draft);
      setNotice('推荐回复已复制，可粘贴到原会话');
    } catch { setNotice('复制失败，请手动选中文本'); }
  }

  async function refresh() {
    setBusy(true);
    try {
      const response = await fetch('/api/follow-ups/refresh', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : '检查失败'); }
    finally { setBusy(false); }
  }

  return (
    <main className="followup-shell">
      <aside className="followup-rail">
        <header className="followup-brand">
          <div className="followup-brand-icon"><Bell size={21} /></div>
          <div><p>CURATOR · NEXT</p><h1>提醒中心</h1></div>
          <a href="/" className="followup-back">返回会话</a>
        </header>
        <div className="followup-intro">
          <strong>{pendingCount} 条待跟进</strong>
          <span>{payload?.scanning ? '正在分析最近两天的会话 · ' : ''}仅分析最近 48 小时结束的会话；安静 10 分钟后开始判断。</span>
        </div>
        <form className="followup-search" onSubmit={(event) => void searchWithAi(event)}>
          <Search size={17} />
          <input value={query} onChange={(event) => { setQuery(event.target.value); setAiKeys(null); setAiMode(null); }} placeholder="搜索任务、项目或机器" />
          <button type="submit" title="用 AI 理解搜索" disabled={aiBusy || query.trim().length < 2}>
            {aiBusy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
          </button>
        </form>
        {aiKeys ? <div className="followup-search-result">{aiMode === 'ai' ? 'AI 搜索' : '本地搜索'} · {aiKeys.length} 条 <button type="button" onClick={() => { setAiKeys(null); setAiMode(null); }}>清除</button></div> : null}
        <div className="followup-controls">
          <div role="group" aria-label="提醒筛选">
            <button className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>待跟进</button>
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
            <button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}>已处理</button>
          </div>
          <button type="button" className="followup-sort" onClick={() => setSort(sort === 'recent' ? 'oldest' : 'recent')}><Clock3 size={15} /> {sort === 'recent' ? '最近结束' : '最早结束'}</button>
        </div>
        <div className="followup-list">
          {!payload ? <div className="followup-empty"><Loader2 size={20} className="spin" /> 正在加载提醒</div> : null}
          {payload && !items.length ? <div className="followup-empty">{payload.scanning ? '正在生成提醒，请稍候…' : '当前没有匹配的提醒。新会话结束后会自动检查。'}</div> : null}
          {items.map((item) => (
            <button key={item.key} type="button" className={`followup-row${selected?.key === item.key ? ' selected' : ''}`} data-session-id={item.sessionId} data-machine-id={item.machineId} data-agent={item.agent} onClick={() => setSelectedKey(item.key)}>
              <span className="followup-row-top"><strong>{item.title}</strong><time>{formatTime(item.endedAt)}</time></span>
              <span className="followup-row-summary">{item.previousTaskSummary}</span>
              <span className="followup-row-meta"><i className={`followup-dot ${item.priority}`} /> {item.machineId} · {item.agent === 'codex' ? 'Codex' : 'Claude'}{item.dismissedAt ? ' · 已处理' : !item.needsFollowUp ? ' · 无待办' : ''}</span>
            </button>
          ))}
        </div>
      </aside>
      <section className="followup-detail">
        <header className="followup-detail-header">
          <div><p>会话结束后的下一步</p><h2>{selected?.title ?? '请选择一条提醒'}</h2></div>
          <button type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={17} /> 检查新会话</button>
        </header>
        {notice ? <div className="followup-notice" role="status">{notice}</div> : null}
        {payload?.error ? <div className="followup-notice" role="status">AI 分析暂未完成：{payload.error}。系统会自动重试。</div> : null}
        {selected ? <div className="followup-content">
          <div className="followup-facts">
            <span>最后对话结束：<strong>{formatTime(selected.endedAt)}</strong></span>
            <span>{selected.machineId} · {selected.ownerUser} · {selected.agent}</span>
            {selected.cwd ? <code>{selected.cwd}</code> : null}
          </div>
          <section className="followup-card followup-recent-card">
            <p className="followup-kicker">原会话</p><h3>最近对话</h3>
            <RecentUserMessages
              key={sessionKey({ id: selected.sessionId, machineId: selected.machineId, agent: selected.agent })}
              session={{ id: selected.sessionId, machineId: selected.machineId, agent: selected.agent }}
            />
          </section>
          <article className="followup-card"><p className="followup-kicker">上一个任务</p><h3>这次会话做了什么</h3><p>{selected.previousTaskSummary}</p></article>
          <article className="followup-card"><p className="followup-kicker">跟进判断</p><h3>{selected.needsFollowUp ? '建议继续跟进' : '暂时无需跟进'}</h3><p>{selected.reason}</p></article>
          <article className="followup-card followup-prompt-card">
            <p className="followup-kicker">推荐回复 · 可编辑</p><h3>发给原会话的下一条消息</h3>
            <textarea value={draft} onChange={(event) => setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))} rows={6} aria-label="推荐回复" />
            <div className="followup-actions">
              <button type="button" className="primary-button" onClick={() => void copyPrompt()} disabled={!draft.trim()}><Copy size={16} /> 复制回复</button>
              <a className="primary-button" href={terminalPageUrl(selected.sessionId, selected.machineId, selected.agent)} target="_blank" rel="noopener noreferrer"><Terminal size={16} /> 打开原会话</a>
              <a className="followup-text-link" href={panelUrl(selected)}>在主面板查看</a>
            </div>
          </article>
          <div className="followup-footer">
            <span>AI 判断于 {formatTime(selected.analyzedAt)} · {selected.model}</span>
            <button type="button" disabled={busy} onClick={() => void dismiss(selected, !selected.dismissedAt)}>
              {selected.dismissedAt ? <Undo2 size={16} /> : <CheckCheck size={16} />}
              {selected.dismissedAt ? '重新提醒' : '标记已处理'}
            </button>
          </div>
        </div> : <div className="followup-detail-empty">选择左侧会话，查看上一任务和推荐回复。</div>}
      </section>
    </main>
  );
}
