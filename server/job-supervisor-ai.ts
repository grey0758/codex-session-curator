import type { CodexJobEvent, CodexResumeJob, CodexSupervisorDecision } from './codex-jobs.js';

export interface SemanticSupervisorDecision {
  decision: CodexSupervisorDecision;
  reason: string;
  guidance: string | null;
  confidence: number;
}

interface SupervisorEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
}

let nextRequestAt = 0;

function readEndpoint(): SupervisorEndpoint | null {
  const baseUrl = (
    process.env.CURATOR_SUPERVISOR_LLM_BASE_URL ||
    process.env.CURATOR_LLM_BASE_URL ||
    process.env.BASE_URL ||
    ''
  ).replace(/\/$/, '');
  const model =
    process.env.CURATOR_SUPERVISOR_LLM_MODEL ||
    process.env.CURATOR_LLM_MODEL ||
    process.env.MODEL ||
    '';
  const apiKey =
    process.env.CURATOR_SUPERVISOR_LLM_API_KEY ||
    process.env.CURATOR_LLM_API_KEY ||
    process.env.API_KEY ||
    '';
  if (!baseUrl || !model || !apiKey) return null;
  return {
    baseUrl,
    model,
    apiKey,
    maxTokens: Number(process.env.CURATOR_SUPERVISOR_LLM_MAX_TOKENS || 500),
    temperature: Number(process.env.CURATOR_SUPERVISOR_LLM_TEMPERATURE || 0.1),
  };
}

function rpmLimit(): number {
  const raw = Number(process.env.CURATOR_SUPERVISOR_LLM_RPM || process.env.CURATOR_LLM_RPM || 20);
  if (!Number.isFinite(raw)) return 20;
  return Math.max(1, Math.min(120, Math.floor(raw)));
}

async function waitForSlot(): Promise<void> {
  const intervalMs = Math.ceil(60_000 / rpmLimit());
  const now = Date.now();
  const scheduledAt = Math.max(now, nextRequestAt);
  nextRequestAt = scheduledAt + intervalMs;
  const waitMs = scheduledAt - now;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[redacted]')
    .replace(/\bnvapi-[A-Za-z0-9_-]{12,}\b/g, 'nvapi-[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]+/gi, '$1=[redacted]');
}

function parseDecision(value: unknown): SemanticSupervisorDecision | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const decision = typeof item.decision === 'string' ? item.decision : '';
  if (!['continue', 'needs_guidance', 'stop', 'retry', 'completed', 'failed'].includes(decision)) return null;
  const confidence = Number(item.confidence);
  return {
    decision: decision as CodexSupervisorDecision,
    reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.slice(0, 600) : 'AI supervisor returned a decision',
    guidance: typeof item.guidance === 'string' && item.guidance.trim() ? item.guidance.slice(0, 2000) : null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
  };
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export async function evaluateJobSemantics(input: {
  job: CodexResumeJob;
  events: CodexJobEvent[];
  policy?: unknown;
}): Promise<SemanticSupervisorDecision | null> {
  const endpoint = readEndpoint();
  if (!endpoint) return null;

  const eventLines = input.events
    .slice(-40)
    .map((event) => `${event.seq} ${event.type} ${event.message} ${JSON.stringify(event.data ?? {})}`.slice(0, 900))
    .join('\n');
  const outputTail = redactSensitiveText(input.job.outputTail.slice(-10_000));
  const prompt = [
    '你是 Codex worker 的语义监督器。规则/policy 已由系统单独执行，你只做语义判断。',
    '请判断 worker 是否跑偏、卡住、重复失败、需要补充指导、应该停止或重派。',
    '只输出 JSON，不要输出解释文本。schema:',
    '{"decision":"continue|needs_guidance|stop|retry|completed|failed","reason":"中文原因","guidance":"需要注入给 worker 的中文指导或 null","confidence":0.0}',
    '',
    `job: ${JSON.stringify({
      id: input.job.id,
      status: input.job.status,
      mode: input.job.mode,
      sessionId: input.job.sessionId,
      cwd: input.job.cwd,
      startedAt: input.job.startedAt,
      updatedAt: input.job.updatedAt,
      error: input.job.error,
      supervisor: input.job.supervisor,
      structuredReport: input.job.structuredReport,
      policy: input.policy ?? input.job.policy,
      policyState: input.job.policyState,
    })}`,
    '',
    'recent events:',
    redactSensitiveText(eventLines),
    '',
    'outputTail:',
    outputTail,
  ].join('\n');

  await waitForSlot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.CURATOR_SUPERVISOR_LLM_TIMEOUT_MS || 45_000));
  try {
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: endpoint.temperature,
        max_tokens: endpoint.maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? '';
    return parseDecision(extractJson(content));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
