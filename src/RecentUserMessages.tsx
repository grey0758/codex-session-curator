import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FileText } from 'lucide-react';

import { fetchRecentUserMessages, getCachedRecentUserMessages, sessionKey } from './RecentUserMessagesData';
import type { HistoryMessage, SessionIdentity } from './RecentUserMessagesData';

interface RecentUserMessagesState {
  messages: HistoryMessage[];
  loading: boolean;
  error: boolean;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function RecentUserMessageCard({ sessionId, message }: { sessionId: string; message: HistoryMessage }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(message.text.length > 240);

  useEffect(() => {
    if (expanded || !textRef.current) return;
    const element = textRef.current;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setCanExpand(message.text.length > 240 || element.scrollHeight > element.clientHeight + 1);
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [expanded, message.text]);

  return (
    <article className={expanded ? 'expanded' : undefined} data-recent-user-message data-role="user" data-session-id={sessionId}>
      <span>用户发送</span>
      <p className="recent-message-text" ref={textRef}>{message.text}</p>
      {message.precedingContext?.length ? (
        <details className="recent-context-details">
          <summary><FileText size={14} />系统上下文 ({message.precedingContext.length})</summary>
          <div className="recent-context-content">
            {message.precedingContext.map((context, index) => (
              <section key={`${context.kind}:${index}`}><strong>{context.label}</strong><pre>{context.text}</pre></section>
            ))}
          </div>
        </details>
      ) : null}
      <div className="recent-message-footer">
        {message.timestamp ? <em>{formatDate(message.timestamp)}</em> : <span />}
        {canExpand ? (
          <button type="button" className="recent-message-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
            <ChevronDown size={15} />{expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function RecentUserMessages({ session }: { session: SessionIdentity }) {
  const identity = useMemo(() => ({ id: session.id, machineId: session.machineId, agent: session.agent }), [session.id, session.machineId, session.agent]);
  const key = sessionKey(identity);
  const [state, setState] = useState<RecentUserMessagesState>(() => {
    const cached = getCachedRecentUserMessages(identity);
    return { messages: cached ? [...cached.messages].reverse() : [], loading: !cached, error: false };
  });

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedRecentUserMessages(identity);
    void fetchRecentUserMessages(identity).then((payload) => {
      if (!cancelled) setState({ messages: [...payload.messages].reverse(), loading: false, error: false });
    }).catch(() => {
      if (!cancelled) setState({ messages: cached ? [...cached.messages].reverse() : [], loading: false, error: !cached });
    });

    const refresh = () => {
      if (document.hidden) return;
      const previous = getCachedRecentUserMessages(identity);
      void fetchRecentUserMessages(identity).then((payload) => {
        if (!cancelled && payload !== previous) setState({ messages: [...payload.messages].reverse(), loading: false, error: false });
      }).catch(() => {});
    };
    const interval = window.setInterval(refresh, 12_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [identity]);

  return (
    <div className="recent-dialogue" data-session-id={identity.id} aria-busy={state.loading}>
      {state.messages.map((message) => (
        <RecentUserMessageCard key={`${key}:${message.index}`} sessionId={identity.id} message={message} />
      ))}
      {state.loading ? <div className="empty compact">正在读取最近用户消息...</div> : null}
      {!state.loading && state.error ? <div className="empty compact">最近用户消息读取失败</div> : null}
      {!state.loading && !state.error && !state.messages.length ? <div className="empty compact">暂无用户消息</div> : null}
    </div>
  );
}
