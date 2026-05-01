import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock3,
  Copy,
  FileJson,
  FolderOpen,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './App.css';

type Recommendation = 'keep' | 'review' | 'delete';
type ActivityStatus = 'active' | 'inactive';
type TabId = 'all' | 'kept' | 'recycle' | Recommendation;

interface RemoteMachine {
  label: string | null;
  host: string | null;
  ip: string | null;
  user: string | null;
  evidence: string;
}

interface Evaluation {
  title: string;
  summary: string;
  detailedSummary: string;
  recommendation: Recommendation;
  score: number;
  reasons: string[];
  actualWorkdirs: string[];
  cwdMatchesWorkdir: boolean | null;
  recommendedWorkdir: string | null;
  remoteMachines: RemoteMachine[];
  evaluatedAt: string;
  workflow: string;
  model: string;
  status: 'ok' | 'fallback' | 'failed';
  error: string | null;
}

interface CodexSession {
  id: string;
  filePath: string;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  bytes: number;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  shellSnapshotCount: number;
  title: string;
  customTitle: string | null;
  resumeCommand: string;
  machineId: string;
  activityStatus: ActivityStatus;
  lastActiveAt: string | null;
  inactiveDays: number | null;
  kept: boolean;
  deleted: boolean;
  evaluation: Evaluation;
}

interface ApiPayload {
  meta: {
    codexHome: string;
    sessionsRoot: string;
    recycleRoot: string;
    recycleRetentionDays: number;
    deleteMode: string;
    remoteAgents?: Array<{ id: string; baseUrl: string }>;
  };
  sessions: CodexSession[];
  total: number;
  filteredTotal?: number;
  page?: number;
  pageSize?: number;
}

interface RecycleArchive {
  sessionId: string;
  archiveDir: string;
  originalSessionFile: string | null;
  deletedAt: string | null;
  expiresAt: string | null;
  retentionDays: number | null;
  archivedFiles: string[];
  removedOriginalFiles: string[];
  removedHistoryEntries: number;
}

interface RecyclePayload {
  meta: ApiPayload['meta'];
  archives: RecycleArchive[];
}

interface HistoryMessage {
  index: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
}

interface HistoryPayload {
  messages: HistoryMessage[];
  nextBefore: number | null;
  hasMore: boolean;
}

interface TerminalEvent {
  type: 'ready' | 'output' | 'exit' | 'error';
  data?: string;
  code?: number | null;
  signal?: string | number | null;
}

interface RemoteAgentStatus {
  id: string;
  baseUrl: string;
  online: boolean;
  latencyMs: number | null;
  error: string | null;
  machineId: string | null;
}

type TerminalStatus = 'disconnected' | 'connecting' | 'connected' | 'codex-running';

const terminalStatusLabel: Record<TerminalStatus, string> = {
  disconnected: '断开',
  connecting: '连接中',
  connected: '已连接',
  'codex-running': 'Codex 运行中',
};

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'kept', label: '保留面板' },
  { id: 'keep', label: '推荐保留' },
  { id: 'review', label: '复核' },
  { id: 'delete', label: '建议删除' },
  { id: 'recycle', label: '回收站' },
];

const recommendationLabel: Record<Recommendation, string> = {
  keep: '推荐保留',
  review: '需要复核',
  delete: '建议删除',
};

const recommendationTone: Record<Recommendation, string> = {
  keep: 'tone-keep',
  review: 'tone-review',
  delete: 'tone-delete',
};

function formatDate(value: string | null): string {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePath(value: string | null | undefined): string {
  return (value ?? '').replace(/\/+$/, '');
}

function sessionGroupKey(session: CodexSession): string {
  return `${session.machineId}|||${normalizePath(session.cwd) || 'unknown cwd'}`;
}

function matchesSearch(session: CodexSession, query: string): boolean {
  if (!query.trim()) return true;
  const text = [
    session.id,
    session.title,
    session.resumeCommand,
    session.cwd ?? '',
    session.machineId,
    session.evaluation.summary,
    session.evaluation.detailedSummary,
    ...session.evaluation.actualWorkdirs,
    session.evaluation.recommendedWorkdir ?? '',
    ...session.evaluation.remoteMachines.map((machine) =>
      [machine.label, machine.host, machine.ip, machine.user].filter(Boolean).join(' ')
    ),
  ]
    .join(' ')
    .toLowerCase();
  return text.includes(query.toLowerCase());
}

function filterByTab(session: CodexSession, tab: TabId): boolean {
  if (tab === 'all') return true;
  if (tab === 'kept') return session.kept;
  if (tab === 'recycle') return false;
  return session.evaluation.recommendation === tab;
}

function metricLabel(value: number, label: string) {
  return (
    <span className="metric">
      <strong>{value}</strong>
      {label}
    </span>
  );
}

function TerminalConsole({ session, active, onClose }: { session: CodexSession; active: boolean; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const terminalCleanupRef = useRef<(() => void) | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const activeRef = useRef(active);
  const manualCloseRef = useRef(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>('disconnected');
  const [fullscreen, setFullscreen] = useState(false);
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [contextMenu]);

  const closeSocketAndPty = useCallback(() => {
    terminalCleanupRef.current?.();
    terminalCleanupRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
    setTerminalStatus('disconnected');
  }, []);

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    closeSocketAndPty();
  }, [closeSocketAndPty]);

  useEffect(() => disconnect, [disconnect]);

  const pasteIntoTerminal = useCallback(async () => {
    const socket = socketRef.current;
    const terminal = terminalRef.current;
    if (!socket || !terminal || socket.readyState !== WebSocket.OPEN) {
      setTerminalNotice('终端未连接');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        setTerminalNotice('剪贴板为空');
        return;
      }
      socket.send(JSON.stringify({ type: 'input', data: text }));
      terminal.focus();
      setTerminalNotice('已粘贴到终端');
    } catch {
      setTerminalNotice('浏览器阻止读取剪贴板，请使用 Ctrl+V 或切换到 HTTPS 隧道');
    }
  }, []);

  const copyTerminalSelection = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal?.hasSelection()) {
      setTerminalNotice('没有选中的终端文本');
      return;
    }
    try {
      await navigator.clipboard.writeText(terminal.getSelection());
      terminal.clearSelection();
      terminal.focus();
      setTerminalNotice('已复制终端选中文本');
    } catch {
      setTerminalNotice('浏览器阻止写入剪贴板');
    }
  }, []);

  const connect = useCallback(() => {
    if (!containerRef.current || socketRef.current) return;
    manualCloseRef.current = false;
    setTerminalStatus('connecting');
    setTerminalNotice(null);
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      theme: { background: '#0b1220', foreground: '#d6deeb' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    fitRef.current = fit;
    terminal.open(containerRef.current);
    terminal.focus();
    terminal.writeln(`连接 ${session.id}`);
    terminal.writeln(`machine: ${session.machineId}`);
    terminal.writeln(`cwd: ${session.cwd ?? 'unknown'}`);

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/api/sessions/${encodeURIComponent(session.id)}/terminal`);
    socketRef.current = socket;
    terminalRef.current = terminal;

    const container = containerRef.current;
    const writeInput = (data: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    };

    terminal.onData((data) => {
      writeInput(data);
    });

    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      writeInput(text);
      terminal.focus();
      setTerminalNotice('已粘贴到终端');
    };
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      terminal.focus();
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        setContextMenu({ x: event.clientX, y: event.clientY });
        return;
      }
      if (terminal.hasSelection()) {
        void copyTerminalSelection();
        return;
      }
      void pasteIntoTerminal();
    };
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const lines = Math.max(1, Math.ceil(Math.abs(event.deltaY) / 40));
      terminal.scrollLines(event.deltaY > 0 ? lines : -lines);
    };
    container.addEventListener('paste', handlePaste);
    container.addEventListener('contextmenu', handleContextMenu);
    const wheelTarget = (container.querySelector('.xterm-viewport') as HTMLElement | null) ?? container;
    const wheelListener = handleWheel as EventListener;
    container.addEventListener('wheel', wheelListener, { capture: true, passive: false });
    wheelTarget.addEventListener('wheel', wheelListener, { capture: true, passive: false });
    terminalCleanupRef.current = () => {
      container.removeEventListener('paste', handlePaste);
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('wheel', wheelListener, true);
      wheelTarget.removeEventListener('wheel', wheelListener, true);
    };

    let lastResize = '';
    const sendResize = (cols: number, rows: number) => {
      const resize = `${cols}x${rows}`;
      if (resize === lastResize || socket.readyState !== WebSocket.OPEN) return;
      lastResize = resize;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    };
    const queueResize = (cols: number, rows: number) => {
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        sendResize(cols, rows);
      }, 120);
    };
    terminal.onResize(({ cols, rows }) => queueResize(cols, rows));

    const fitAndQueueResize = () => {
      fit.fit();
      queueResize(terminal.cols || 120, terminal.rows || 40);
    };
    window.setTimeout(fitAndQueueResize, 0);
    window.setTimeout(fitAndQueueResize, 120);
    const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(fitAndQueueResize));
    resizeObserver.observe(containerRef.current);
    resizeObserverRef.current = resizeObserver;

    socket.onopen = () => {
      setTerminalStatus('connected');
      terminal.writeln('WebSocket 已连接，启动 codex resume...');
      fit.fit();
      sendResize(terminal.cols || 120, terminal.rows || 40);
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as TerminalEvent;
      if (message.type === 'output' && message.data) terminal.write(message.data);
      if (message.type === 'ready' && message.data) {
        setTerminalStatus('codex-running');
        terminal.writeln(`\r\n$ ${message.data}`);
      }
      if (message.type === 'error') terminal.writeln(`\r\n[error] ${message.data ?? 'unknown error'}`);
      if (message.type === 'exit') {
        terminal.writeln(`\r\n[exit] code=${message.code ?? 'null'} signal=${message.signal ?? 'null'}`);
        setTerminalStatus('disconnected');
      }
    };
    socket.onclose = () => {
      socketRef.current = null;
      setTerminalStatus('disconnected');
      if (!manualCloseRef.current && activeRef.current) {
        setTerminalNotice('连接已断开，正在自动重连到 tmux...');
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connectRef.current();
        }, 1200);
      }
    };
    socket.onerror = () => {
      terminal.writeln('\r\n[error] WebSocket 连接失败');
      setTerminalStatus('disconnected');
    };
  }, [copyTerminalSelection, pasteIntoTerminal, session]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const reconnect = useCallback(() => {
    manualCloseRef.current = false;
    closeSocketAndPty();
    window.setTimeout(() => connectRef.current(), 80);
  }, [closeSocketAndPty]);

  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear();
    terminalRef.current?.focus();
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (!active) return;
    const handle = window.setTimeout(() => {
      if (!socketRef.current) connect();
      fitRef.current?.fit();
      terminalRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [active, connect]);

  return (
    <div className={`terminal-panel${fullscreen ? ' fullscreen' : ''}${active ? '' : ' inactive'}`}>
      <div className="terminal-toolbar">
        <span>客户端终端代理 · {terminalStatusLabel[terminalStatus]}</span>
        <button
          type="button"
          className="icon-button terminal-icon-button"
          onClick={() => setFullscreen((value) => !value)}
          title={fullscreen ? '退出全屏' : '全屏'}
          aria-label={fullscreen ? '退出全屏' : '全屏'}
        >
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button type="button" className="primary-button" onClick={() => void copyTerminalSelection()} disabled={terminalStatus === 'disconnected'}>
          复制选中
        </button>
        <button type="button" className="primary-button" onClick={() => void pasteIntoTerminal()} disabled={terminalStatus === 'disconnected'}>
          粘贴
        </button>
        <button type="button" className="primary-button" onClick={reconnect}>
          重连
        </button>
        <button type="button" className="danger-button" onClick={disconnect} disabled={terminalStatus === 'disconnected'}>
          断开
        </button>
        <button type="button" className="icon-button terminal-icon-button" onClick={onClose} title="关闭终端标签" aria-label="关闭终端标签">
          <X size={16} />
        </button>
      </div>
      {terminalNotice ? <div className="terminal-notice">{terminalNotice}</div> : null}
      {contextMenu ? (
        <div className="terminal-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" onClick={() => { setContextMenu(null); void copyTerminalSelection(); }}>复制</button>
          <button type="button" onClick={() => { setContextMenu(null); void pasteIntoTerminal(); }}>粘贴</button>
          <button type="button" onClick={clearTerminal}>清屏</button>
          <button type="button" onClick={() => { setContextMenu(null); reconnect(); }}>重连</button>
          <button type="button" onClick={() => { setContextMenu(null); onClose(); }}>关闭</button>
        </div>
      ) : null}
      <div className="terminal-surface" ref={containerRef} />
    </div>
  );
}

function App() {
  const [allSessions, setAllSessions] = useState<CodexSession[]>([]);
  const [sessionDetails, setSessionDetails] = useState<Record<string, CodexSession>>({});
  const [recycleArchives, setRecycleArchives] = useState<RecycleArchive[]>([]);
  const [remoteStatuses, setRemoteStatuses] = useState<RemoteAgentStatus[]>([]);
  const [meta, setMeta] = useState<ApiPayload['meta'] | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('all');
  const [machineFilter, setMachineFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [migrationTargets, setMigrationTargets] = useState<Record<string, string>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [copiedResumeId, setCopiedResumeId] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [openedTerminalIds, setOpenedTerminalIds] = useState<string[]>([]);
  const [historyMessages, setHistoryMessages] = useState<HistoryMessage[]>([]);
  const [historyBefore, setHistoryBefore] = useState<number | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadedSessionId, setHistoryLoadedSessionId] = useState<string | null>(null);
  const [recycleQuery, setRecycleQuery] = useState('');

  const refreshRemoteStatuses = useCallback(async () => {
    try {
      const response = await fetch('/api/remote-agents');
      if (!response.ok) return;
      const payload = (await response.json()) as { agents: RemoteAgentStatus[] };
      setRemoteStatuses(payload.agents);
    } catch {
      setRemoteStatuses((current) => current.map((agent) => ({ ...agent, online: false, error: '状态刷新失败', latencyMs: null })));
    }
  }, []);

  const loadSessions = useCallback(async (refreshWorkflow = false) => {
    setLoading(true);
    setError(null);
    const baseParams = new URLSearchParams();
    if (refreshWorkflow) baseParams.set('refresh', '1');

    try {
      const localParams = new URLSearchParams(baseParams);
      localParams.set('remote', '0');
      localParams.set('detail', '0');
      const [localResponse, recycleResponse] = await Promise.all([
        fetch(`/api/sessions?${localParams.toString()}`),
        fetch('/api/recycle-bin'),
      ]);
      if (!localResponse.ok) throw new Error(`HTTP ${localResponse.status}`);
      if (!recycleResponse.ok) throw new Error(`Recycle HTTP ${recycleResponse.status}`);
      const payload = (await localResponse.json()) as ApiPayload;
      const recyclePayload = (await recycleResponse.json()) as RecyclePayload;
      setAllSessions(payload.sessions);
      setRecycleArchives(recyclePayload.archives);
      setMeta(payload.meta);
      setLoading(false);
      void refreshRemoteStatuses();

      if (!refreshWorkflow) {
        const remoteResponse = await fetch('/api/sessions?detail=0');
        if (remoteResponse.ok) {
          const remotePayload = (await remoteResponse.json()) as ApiPayload;
          setAllSessions(remotePayload.sessions);
          setMeta(remotePayload.meta);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
      setLoading(false);
    }
  }, [refreshRemoteStatuses]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void loadSessions();
    }, 150);
    return () => window.clearTimeout(handle);
  }, [loadSessions]);

  const machineOptions = useMemo(() => ['all', ...Array.from(new Set(allSessions.map((session) => session.machineId))).sort()], [allSessions]);

  const visibleSessions = useMemo(
    () =>
      allSessions.filter(
        (session) =>
          filterByTab(session, activeTab) &&
          (machineFilter === 'all' || session.machineId === machineFilter) &&
          matchesSearch(session, query)
      ),
    [activeTab, allSessions, machineFilter, query]
  );

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, { key: string; machineId: string; cwd: string; sessions: CodexSession[] }>();
    for (const session of visibleSessions) {
      const key = sessionGroupKey(session);
      const current =
        groups.get(key) ??
        {
          key,
          machineId: session.machineId,
          cwd: normalizePath(session.cwd) || 'unknown cwd',
          sessions: [],
        };
      current.sessions.push(session);
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) => b.sessions.length - a.sessions.length || a.cwd.localeCompare(b.cwd));
  }, [visibleSessions]);

  const selectedSummary = useMemo(
    () => visibleSessions.find((session) => session.id === selectedId) ?? visibleSessions[0] ?? null,
    [selectedId, visibleSessions]
  );
  const selected = selectedSummary ? (sessionDetails[selectedSummary.id] ?? selectedSummary) : null;
  const visibleSessionIds = useMemo(() => visibleSessions.map((session) => session.id), [visibleSessions]);
  const selectedIdSet = useMemo(() => new Set(selectedSessionIds), [selectedSessionIds]);
  const selectedVisibleCount = useMemo(
    () => visibleSessionIds.filter((id) => selectedIdSet.has(id)).length,
    [selectedIdSet, visibleSessionIds]
  );
  const allVisibleSelected = visibleSessionIds.length > 0 && selectedVisibleCount === visibleSessionIds.length;
  const openedTerminalSessions = useMemo(
    () =>
      openedTerminalIds
        .map((id) => allSessions.find((session) => session.id === id))
        .filter((session): session is CodexSession => Boolean(session)),
    [allSessions, openedTerminalIds]
  );
  const selectedTerminalSession = openedTerminalSessions.find((session) => session.id === selected?.id) ?? null;
  const visibleRecycleArchives = useMemo(() => {
    const needle = (recycleQuery || query).trim().toLowerCase();
    if (!needle) return recycleArchives;
    return recycleArchives.filter((archive) =>
      [archive.sessionId, archive.archiveDir, archive.originalSessionFile ?? '', ...archive.archivedFiles, ...archive.removedOriginalFiles]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [query, recycleArchives, recycleQuery]);

  const titleDraft = selected ? (titleDrafts[selected.id] ?? selected.customTitle ?? selected.title) : '';
  const migrationTarget = selected
    ? (migrationTargets[selected.id] ??
      selected.evaluation.recommendedWorkdir ??
      selected.evaluation.actualWorkdirs[0] ??
      selected.cwd ??
      '')
    : '';
  const migrationAlreadyInPlace = selected ? normalizePath(selected.cwd) === normalizePath(migrationTarget) : false;

  const toggleSessionSelection = useCallback((id: string) => {
    setSelectedSessionIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }, []);

  const toggleVisibleSelection = useCallback(() => {
    setSelectedSessionIds((current) => {
      const currentSet = new Set(current);
      const shouldSelect = !visibleSessionIds.every((id) => currentSet.has(id));
      for (const id of visibleSessionIds) {
        if (shouldSelect) currentSet.add(id);
        else currentSet.delete(id);
      }
      return [...currentSet];
    });
  }, [visibleSessionIds]);

  const toggleGroupSelection = useCallback((ids: string[]) => {
    setSelectedSessionIds((current) => {
      const currentSet = new Set(current);
      const shouldSelect = !ids.every((id) => currentSet.has(id));
      for (const id of ids) {
        if (shouldSelect) currentSet.add(id);
        else currentSet.delete(id);
      }
      return [...currentSet];
    });
  }, []);

  const openTerminal = useCallback((session: CodexSession) => {
    setOpenedTerminalIds((current) => (current.includes(session.id) ? current : [...current, session.id]));
  }, []);

  const closeTerminal = useCallback((id: string) => {
    setOpenedTerminalIds((current) => current.filter((item) => item !== id));
  }, []);

  const copyResumeCommand = useCallback(async (session: CodexSession) => {
    try {
      await navigator.clipboard.writeText(session.resumeCommand);
      setCopiedResumeId(session.id);
      setActionMessage(`已复制恢复命令：${session.resumeCommand}`);
      window.setTimeout(() => {
        setCopiedResumeId((current) => (current === session.id ? null : current));
      }, 1800);
    } catch {
      setActionMessage('复制失败：浏览器阻止访问剪贴板');
    }
  }, []);

  const loadHistory = useCallback(async (session: CodexSession, before: number | null = null) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: '60' });
      if (before !== null) params.set('before', String(before));
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/history?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as HistoryPayload;
      setHistoryLoadedSessionId(session.id);
      setHistoryMessages((current) => (before === null ? payload.messages : [...payload.messages, ...current]));
      setHistoryBefore(payload.nextBefore);
      setHistoryHasMore(payload.hasMore);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setHistoryMessages([]);
      setHistoryBefore(null);
      setHistoryHasMore(false);
      setHistoryLoadedSessionId(null);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [activeTab, selected?.id]);

  useEffect(() => {
    if (!selectedSummary || activeTab === 'recycle' || sessionDetails[selectedSummary.id]) return;
    let cancelled = false;
    void fetch(`/api/sessions/${encodeURIComponent(selectedSummary.id)}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<CodexSession>;
      })
      .then((session) => {
        if (!cancelled) setSessionDetails((current) => ({ ...current, [session.id]: session }));
      })
      .catch(() => {
        // Detail loading is opportunistic; the summary row remains usable.
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, selectedSummary, sessionDetails]);

  const stats = useMemo(() => {
    return allSessions
      .filter((session) => (machineFilter === 'all' || session.machineId === machineFilter) && matchesSearch(session, query))
      .reduce(
      (acc, session) => {
        acc[session.evaluation.recommendation] += 1;
        if (session.kept) acc.kept += 1;
        if (session.activityStatus === 'active') acc.active += 1;
        return acc;
      },
      { keep: 0, review: 0, delete: 0, kept: 0, active: 0 } as Record<Recommendation, number> & {
        kept: number;
        active: number;
      }
      );
  }, [allSessions, machineFilter, query]);

  async function setKept(session: CodexSession, kept: boolean) {
    setBusyId(session.id);
    try {
      const response = await fetch(`/api/sessions/${session.id}/keep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kept }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } finally {
      setBusyId(null);
    }
  }

  async function deleteSession(session: CodexSession) {
    if (!window.confirm(`只删除当前机器 ${session.machineId} 上的会话：${session.id}？会先移入回收站，原 Codex 活跃目录会被清除。`)) return;
    setBusyId(session.id);
    try {
      const response = await fetch(`/api/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } finally {
      setBusyId(null);
    }
  }

  async function deleteSelectedSessions() {
    if (!selectedSessionIds.length) return;
    if (!window.confirm(`将已选中的 ${selectedSessionIds.length} 个会话移入回收站？原位置会被清除。`)) return;
    setBusyId('bulk-delete');
    setActionMessage(null);
    try {
      const response = await fetch('/api/sessions/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, ids: selectedSessionIds }),
      });
      const payload = (await response.json()) as { deleted?: number; failed?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(`已移入回收站 ${payload.deleted ?? 0} 个会话，失败 ${payload.failed ?? 0} 个`);
      setSelectedSessionIds([]);
      await loadSessions();
    } catch (err) {
      setActionMessage(`批量删除失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function pruneRecommended() {
    if (!window.confirm('将所有未手动保留且被建议删除的 Codex 会话移入回收站？原位置会被清除。')) return;
    setBusyId('prune');
    try {
      const response = await fetch('/api/sessions/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } finally {
      setBusyId(null);
    }
  }

  async function pruneNonKept() {
    if (!window.confirm('将所有未进入保留面板的本机 Codex 会话移入回收站？原位置会被清除。')) return;
    setBusyId('prune-non-kept');
    try {
      const response = await fetch('/api/sessions/prune-non-kept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } finally {
      setBusyId(null);
    }
  }

  async function retryFailedSummaries() {
    setBusyId('retry-failed');
    setActionMessage(null);
    try {
      const response = await fetch('/api/evaluations/retry-failed', { method: 'POST' });
      const payload = (await response.json()) as { queued?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(`已加入摘要重试队列 ${payload.queued ?? 0} 个；下次刷新或 AI 重算时会重新生成。`);
      await loadSessions(true);
    } catch (err) {
      setActionMessage(`摘要重试失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function saveTitle(session: CodexSession) {
    setBusyId(`${session.id}:title`);
    try {
      const response = await fetch(`/api/sessions/${session.id}/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: titleDraft }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } finally {
      setBusyId(null);
    }
  }

  async function migrateSession(session: CodexSession) {
    if (!migrationTarget.trim()) return;
    setBusyId(`${session.id}:migrate`);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/sessions/${session.id}/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetProjectDir: migrationTarget.trim() }),
      });
      const payload = (await response.json()) as {
        resumeCommand?: string;
        newSessionId?: string;
        alreadyInTarget?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(
        payload.alreadyInTarget
          ? `当前会话已经绑定到这个目录，无需迁移：${payload.resumeCommand ?? session.resumeCommand}`
          : `已创建项目目录副本：${payload.resumeCommand ?? payload.newSessionId}`
      );
      await loadSessions();
    } catch (err) {
      setActionMessage(`迁移失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function migrateSelectedSameDirectory(session: CodexSession) {
    const target = migrationTarget.trim();
    if (!target || !selectedSessionIds.length) return;
    const targetIds = allSessions
      .filter((item) => selectedSessionIds.includes(item.id) && item.machineId === session.machineId && normalizePath(item.cwd) === normalizePath(session.cwd))
      .map((item) => item.id);
    if (!targetIds.length) return;
    if (!window.confirm(`将当前目录下已选中的 ${targetIds.length} 个会话批量迁移到：${target}？`)) return;
    setBusyId('bulk-migrate');
    let ok = 0;
    let failed = 0;
    for (const id of targetIds) {
      try {
        const response = await fetch(`/api/sessions/${id}/migrate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetProjectDir: target }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setActionMessage(`批量迁移完成：成功 ${ok} 个，失败 ${failed} 个`);
    setBusyId(null);
    await loadSessions();
  }

  async function restoreArchive(archive: RecycleArchive) {
    if (!window.confirm(`恢复回收站会话 ${archive.sessionId} 到原 Codex 目录？`)) return;
    setBusyId(`${archive.sessionId}:restore`);
    try {
      const response = await fetch(`/api/recycle-bin/${encodeURIComponent(archive.sessionId)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } finally {
      setBusyId(null);
    }
  }

  async function purgeArchive(archive: RecycleArchive) {
    if (!window.confirm(`立即永久删除回收站归档 ${archive.sessionId}？这个操作不可恢复。`)) return;
    setBusyId(`${archive.sessionId}:purge`);
    try {
      const response = await fetch(`/api/recycle-bin/${encodeURIComponent(archive.sessionId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">
            <KeyRound size={22} />
          </div>
          <div>
            <h1>Codex 会话清理服务</h1>
            <p>评估、保留、删除本机记录</p>
          </div>
        </div>

        <div className="search-box">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 key / cwd / 机器 / 摘要" />
        </div>

        <div className="machine-filter">
          <Server size={16} />
          <select value={machineFilter} onChange={(event) => setMachineFilter(event.target.value)}>
            {machineOptions.map((machine) => (
              <option key={machine} value={machine}>
                {machine === 'all' ? '全部机器' : machine}
              </option>
            ))}
          </select>
        </div>

        {remoteStatuses.length ? (
          <div className="remote-status-list">
            {remoteStatuses.map((agent) => (
              <button type="button" key={agent.id} onClick={() => void refreshRemoteStatuses()} title="刷新远端机器状态">
                <span className={`remote-dot ${agent.online ? 'online' : 'offline'}`} />
                <strong>{agent.machineId ?? agent.id}</strong>
                <em>{agent.online ? `${agent.latencyMs ?? '?'}ms` : `${agent.id} 暂不可用`}</em>
              </button>
            ))}
          </div>
        ) : null}

        <div className="tabs" role="tablist" aria-label="session filters">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? 'active' : ''}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="summary-strip">
          {metricLabel(activeTab === 'recycle' ? visibleRecycleArchives.length : visibleSessions.length, '当前列表')}
          {metricLabel(stats.kept, '手动保留')}
          {metricLabel(stats.active, '三天活跃')}
          {metricLabel(stats.delete, '删除')}
        </div>

        <div className="filter-note">保留面板是手动标签；推荐保留、复核、建议删除是 AI 分类，可与机器和搜索筛选叠加。</div>

        {activeTab !== 'recycle' ? (
          <div className="bulk-toolbar">
            <button type="button" className="primary-button" disabled={!visibleSessionIds.length} onClick={toggleVisibleSelection}>
              {allVisibleSelected ? '取消当前列表' : '选择当前列表'}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={!selectedSessionIds.length || busyId === 'bulk-delete'}
              onClick={() => void deleteSelectedSessions()}
            >
              删除已选 {selectedSessionIds.length}
            </button>
          </div>
        ) : null}

        <div className="session-list" aria-busy={loading}>
          {loading ? (
            <div className="empty">
              <Loader2 className="spin" size={22} />
              扫描并评估本机 Codex 会话
            </div>
          ) : null}
          {!loading && activeTab !== 'recycle' && visibleSessions.length === 0 ? <div className="empty">没有匹配的会话</div> : null}
          {!loading && activeTab === 'recycle' ? (
            <div className="recycle-search">
              <Search size={16} />
              <input value={recycleQuery} onChange={(event) => setRecycleQuery(event.target.value)} placeholder="搜索回收站 session / 路径" />
            </div>
          ) : null}
          {!loading && activeTab === 'recycle' && visibleRecycleArchives.length === 0 ? <div className="empty">回收站为空</div> : null}
          {activeTab === 'recycle'
            ? visibleRecycleArchives.map((archive) => (
                <div key={archive.archiveDir} className="archive-row">
                  <span className="session-key">{archive.sessionId}</span>
                  <span className="session-summary">删除：{formatDate(archive.deletedAt)} · 过期：{formatDate(archive.expiresAt)}</span>
                  <span className="session-summary">{archive.archiveDir}</span>
                  <span className="archive-actions">
                    <button type="button" className="primary-button" disabled={busyId === `${archive.sessionId}:restore`} onClick={() => void restoreArchive(archive)}>
                      恢复
                    </button>
                    <button type="button" className="danger-button" disabled={busyId === `${archive.sessionId}:purge`} onClick={() => void purgeArchive(archive)}>
                      永久删除
                    </button>
                  </span>
                </div>
              ))
            : groupedSessions.map((group) => {
                const collapsed = collapsedGroups[group.key] ?? true;
                const groupIds = group.sessions.map((session) => session.id);
                const selectedInGroup = groupIds.filter((id) => selectedIdSet.has(id)).length;
                const groupChecked = selectedInGroup === groupIds.length && groupIds.length > 0;
                return (
                  <div key={group.key} className="session-group">
                    <div
                      className="group-header"
                      onClick={() => setCollapsedGroups((current) => ({ ...current, [group.key]: !collapsed }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setCollapsedGroups((current) => ({ ...current, [group.key]: !collapsed }));
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <input
                        type="checkbox"
                        className="session-checkbox"
                        checked={groupChecked}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => toggleGroupSelection(groupIds)}
                        aria-label={`选择目录 ${group.cwd}`}
                        title={selectedInGroup ? `已选择 ${selectedInGroup}/${groupIds.length}` : '选择这个目录'}
                      />
                      {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                      <span>{group.machineId}</span>
                      <strong>{group.cwd}</strong>
                      <em>{group.sessions.length}</em>
                    </div>
                    {collapsed
                      ? null
                      : group.sessions.map((session) => (
                          <div
                            key={session.id}
                            className={`session-row ${selected?.id === session.id ? 'selected' : ''}`}
                            onClick={() => setSelectedId(session.id)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSelectedId(session.id);
                              }
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            <input
                              type="checkbox"
                              className="session-checkbox"
                              checked={selectedIdSet.has(session.id)}
                              onClick={(event) => event.stopPropagation()}
                              onChange={() => toggleSessionSelection(session.id)}
                              aria-label={`选择 ${session.title}`}
                            />
                            <span className={`dot ${recommendationTone[session.evaluation.recommendation]}`} />
                            <span className="session-main">
                              <span className="session-key">{session.title}</span>
                              <span className="session-summary">{session.evaluation.summary}</span>
                            </span>
                            <span className="session-time">
                              {session.kept ? '已保留 · ' : ''}
                              {session.activityStatus === 'active' ? '活跃' : '非活跃'} · {formatDate(session.updatedAt)}
                            </span>
                          </div>
                        ))}
                  </div>
                );
              })}
        </div>
      </aside>

      <section className="detail">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local Codex Records</p>
            <h2>{selected ? selected.title : '未选择会话'}</h2>
          </div>
          <div className="topbar-actions">
            <button type="button" className="icon-button" title="刷新" onClick={() => void loadSessions()}>
              <RefreshCw size={18} />
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={loading}
              title="并发 8 个会话调用 GPT-5.4，重算整段摘要和目录识别"
              onClick={() => void loadSessions(true)}
            >
              <Sparkles size={17} />
              AI 重算
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busyId === 'retry-failed'}
              title="只清空失败摘要缓存，然后重新进入总结工作流"
              onClick={() => void retryFailedSummaries()}
            >
              <RefreshCw size={17} />
              重试失败摘要
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busyId === 'prune'}
              onClick={() => void pruneRecommended()}
            >
              <Trash2 size={17} />
              清理建议删除
            </button>
            <button
              type="button"
              className="danger-button strong-danger"
              disabled={busyId === 'prune-non-kept'}
              onClick={() => void pruneNonKept()}
            >
              <Archive size={17} />
              清理非保留
            </button>
          </div>
        </header>

        {error ? <div className="notice danger">加载失败：{error}</div> : null}

        {openedTerminalSessions.length ? (
          <div className={`detail-grid terminal-dock-grid${selectedTerminalSession ? '' : ' terminal-dock-hidden'}`}>
            <section className="primary-panel terminal-card">
              <div className="panel-heading terminal-dock-heading">
                <h3>当前会话终端</h3>
                {selectedTerminalSession ? <span>{selectedTerminalSession.resumeCommand}</span> : null}
              </div>
              <div className="terminal-stack">
                {openedTerminalSessions.map((session) => (
                  <TerminalConsole
                    key={session.id}
                    session={session}
                    active={selected?.id === session.id}
                    onClose={() => closeTerminal(session.id)}
                  />
                ))}
              </div>
            </section>
          </div>
        ) : null}

        {activeTab === 'recycle' ? (
          <div className="detail-grid">
            <section className="primary-panel">
              <h3>回收站会话记录</h3>
              <p className="long-summary">
                回收站只展示归档元数据和路径；原始会话已从 Codex 活跃目录清除，归档文件会在过期时间后自动删除。
              </p>
              <div className="archive-detail-list">
                {visibleRecycleArchives.map((archive) => (
                  <div className="archive-detail" key={archive.archiveDir}>
                    <strong>{archive.sessionId}</strong>
                    <span>删除时间：{formatDate(archive.deletedAt)}</span>
                    <span>自动清理：{formatDate(archive.expiresAt)}</span>
                    <code>{archive.archiveDir}</code>
                    <div className="archive-actions">
                      <button type="button" className="primary-button" onClick={() => void restoreArchive(archive)}>
                        恢复
                      </button>
                      <button type="button" className="danger-button" onClick={() => void purgeArchive(archive)}>
                        立即永久删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : selected ? (
          <div className="detail-grid">
            <section className="primary-panel">
              <div className="status-line">
                <span className={`status-pill ${recommendationTone[selected.evaluation.recommendation]}`}>
                  {recommendationLabel[selected.evaluation.recommendation]}
                </span>
                <span className="score">score {selected.evaluation.score}</span>
                <span className={`activity ${selected.activityStatus}`}>
                  {selected.activityStatus === 'active' ? '三天内活跃' : `非活跃${selected.inactiveDays ?? '?'}天`}
                </span>
                {selected.kept ? <span className="kept">手动保留</span> : null}
              </div>

              <p className="detail-summary">{selected.evaluation.summary}</p>

              <div className="title-editor">
                <label htmlFor="session-title">保留标题</label>
                <div>
                  <input
                    id="session-title"
                    value={titleDraft}
                    onChange={(event) =>
                      setTitleDrafts((current) => ({ ...current, [selected.id]: event.target.value }))
                    }
                    placeholder="给这个会话起一个标题"
                  />
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busyId === `${selected.id}:title`}
                    onClick={() => void saveTitle(selected)}
                  >
                    保存标题
                  </button>
                </div>
              </div>

              <div className="key-block">
                <TerminalIcon size={18} />
                <code>{selected.resumeCommand}</code>
                <button
                  type="button"
                  className="icon-button"
                  title={copiedResumeId === selected.id ? '已复制' : '复制恢复命令'}
                  onClick={() => void copyResumeCommand(selected)}
                >
                  <Copy size={17} />
                </button>
                {copiedResumeId === selected.id ? <span className="copy-feedback">已复制</span> : null}
              </div>

              <div className="action-row">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busyId === selected.id}
                  onClick={() => void setKept(selected, !selected.kept)}
                >
                  <ShieldCheck size={17} />
                  {selected.kept ? '取消保留' : '保留到面板'}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={busyId === selected.id}
                  onClick={() => void deleteSession(selected)}
                >
                  <Trash2 size={17} />
                  移入回收站
                </button>
                <button type="button" className="primary-button" onClick={() => openTerminal(selected)}>
                  <TerminalIcon size={17} />
                  打开/查看终端
                </button>
              </div>
            </section>

            <section className="primary-panel">
              <h3>整段会话做了什么</h3>
              <p className="long-summary">{selected.evaluation.detailedSummary || selected.evaluation.summary}</p>
            </section>

            <section className="primary-panel">
              <div className="panel-heading">
                <h3>会话历史</h3>
                <button
                  type="button"
                  className="primary-button"
                  disabled={historyLoading || historyLoadedSessionId === selected.id}
                  onClick={() => void loadHistory(selected)}
                >
                  {historyLoadedSessionId === selected.id ? '已加载最近记录' : '加载最近记录'}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={historyLoadedSessionId !== selected.id || !historyHasMore || historyLoading || historyBefore === null}
                  onClick={() => void loadHistory(selected, historyBefore)}
                >
                  更早记录
                </button>
              </div>
              <div className="history-list" aria-busy={historyLoading}>
                {historyMessages.map((message) => (
                  <div className={`history-message ${message.role}`} key={message.index}>
                    <span>{message.role === 'user' ? '用户' : 'Codex'} · {formatDate(message.timestamp)}</span>
                    <p>{message.text}</p>
                  </div>
                ))}
                {!historyMessages.length ? (
                  <div className="empty compact">{historyLoading ? '正在加载会话历史...' : '点击“加载最近记录”后查看历史'}</div>
                ) : null}
              </div>
            </section>

            <section className="secondary-panel">
              <h3>工作目录判断</h3>
              <div className="fact">
                <CheckCircle2 size={16} />
                <span>
                  目录匹配：
                  {selected.evaluation.cwdMatchesWorkdir === null
                    ? '证据不足'
                    : selected.evaluation.cwdMatchesWorkdir
                      ? '会话 cwd 与识别目录一致'
                      : '会话 cwd 可能不是实际工作目录'}
                </span>
              </div>
              <div className="fact">
                <FolderOpen size={17} />
                <span>会话 cwd：{selected.cwd ?? 'unknown cwd'}</span>
              </div>
              {selected.evaluation.actualWorkdirs.length ? (
                selected.evaluation.actualWorkdirs.map((workdir) => (
                  <div className="fact" key={workdir}>
                    <CheckCircle2 size={16} />
                    <span>识别目录：{workdir}</span>
                  </div>
                ))
              ) : (
                <div className="fact muted-fact">
                  <AlertTriangle size={16} />
                  <span>未从整段会话中识别到明确工作目录</span>
                </div>
              )}
              {selected.evaluation.recommendedWorkdir ? (
                <div className={`notice ${migrationAlreadyInPlace ? 'inline-info' : 'inline-warning'}`}>
                  {migrationAlreadyInPlace
                    ? `当前会话已经在对应目录：${selected.evaluation.recommendedWorkdir}`
                    : `建议迁移/继续工作目录：${selected.evaluation.recommendedWorkdir}`}
                </div>
              ) : null}
              <div className="notice inline-info migration-basis">
                迁移依据：
                {selected.evaluation.recommendedWorkdir
                  ? 'AI 从整段会话识别出推荐继续目录'
                  : selected.evaluation.actualWorkdirs.length
                    ? 'AI 从整段会话识别出实际工作目录'
                    : '未识别到明确目录，默认使用会话 cwd'}
              </div>
              <div className="migration-box">
                <input
                  value={migrationTarget}
                  onChange={(event) =>
                    setMigrationTargets((current) => ({ ...current, [selected.id]: event.target.value }))
                  }
                  placeholder="输入本机项目目录"
                />
                <button
                  type="button"
                  className="primary-button"
                  disabled={busyId === `${selected.id}:migrate` || !migrationTarget.trim() || migrationAlreadyInPlace}
                  onClick={() => void migrateSession(selected)}
                >
                  {migrationAlreadyInPlace ? '无需迁移' : '迁移到目录'}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busyId === 'bulk-migrate' || !selectedSessionIds.length || !migrationTarget.trim()}
                  onClick={() => void migrateSelectedSameDirectory(selected)}
                >
                  批量迁移同目录
                </button>
              </div>
              {actionMessage ? <div className="notice inline-info">{actionMessage}</div> : null}
            </section>

            <section className="secondary-panel">
              <h3>评估依据</h3>
              <ul className="reason-list">
                {selected.evaluation.reasons.map((reason) => (
                  <li key={reason}>
                    <CheckCircle2 size={16} />
                    {reason}
                  </li>
                ))}
              </ul>
              <div className="workflow">
                <Sparkles size={16} />
                摘要版本：{selected.evaluation.workflow} · 模型：{selected.evaluation.model} · 状态：
                {selected.evaluation.status === 'ok' ? '成功' : selected.evaluation.status === 'failed' ? '失败后回退' : '规则回退'} · 更新时间：
                {formatDate(selected.evaluation.evaluatedAt)}
              </div>
              {selected.evaluation.error ? <div className="notice inline-warning">摘要失败原因：{selected.evaluation.error}</div> : null}
            </section>

            <section className="facts-panel">
              <h3>机器与远程环境</h3>
              <div className="fact">
                <Server size={17} />
                <span>当前客户端：{selected.machineId}</span>
              </div>
              {selected.evaluation.remoteMachines.length ? (
                selected.evaluation.remoteMachines.map((machine, index) => (
                  <div className="remote-item" key={`${machine.label ?? machine.host ?? machine.ip ?? index}-${index}`}>
                    <strong>{machine.label ?? machine.host ?? machine.ip ?? '远程机器'}</strong>
                    <span>
                      {[machine.user ? `用户 ${machine.user}` : '', machine.host ? `host ${machine.host}` : '', machine.ip ? `ip ${machine.ip}` : '']
                        .filter(Boolean)
                        .join(' · ') || '会话中提到远程环境'}
                    </span>
                    {machine.evidence ? <em>{machine.evidence}</em> : null}
                  </div>
                ))
              ) : (
                <div className="fact muted-fact">
                  <AlertTriangle size={16} />
                  <span>未识别到 SSH、IP 或云端机器线索</span>
                </div>
              )}
            </section>

            <section className="facts-panel">
              <h3>本机位置</h3>
              <div className="fact">
                <FolderOpen size={17} />
                <span>{selected.cwd ?? 'unknown cwd'}</span>
              </div>
              <div className="fact">
                <FileJson size={17} />
                <span>{selected.filePath}</span>
              </div>
              <div className="fact">
                <Archive size={17} />
                <span>{selected.shellSnapshotCount} shell snapshots</span>
              </div>
            </section>

            <section className="metrics-panel">
              <div>{metricLabel(selected.userTurns, '用户回合')}</div>
              <div>{metricLabel(selected.assistantTurns, '助手回合')}</div>
              <div>{metricLabel(selected.messageCount, '消息')}</div>
              <div>{metricLabel(Number(formatBytes(selected.bytes).split(' ')[0]), formatBytes(selected.bytes).split(' ')[1])}</div>
              <div className="wide">
                <Clock3 size={17} />
                {formatDate(selected.startedAt)} - {formatDate(selected.updatedAt)}
              </div>
            </section>
          </div>
        ) : (
          <div className="blank-state">没有可显示的 Codex 会话</div>
        )}

        <footer className="footer">
          <span>Codex home: {meta?.codexHome ?? 'loading'}</span>
          <span>回收站: {meta?.recycleRoot ?? 'loading'} · {meta?.recycleRetentionDays ?? 30}天</span>
          <span>删除模式: {meta?.deleteMode ?? 'archive-then-local-clean'}</span>
        </footer>
      </section>
    </main>
  );
}

export default App;
