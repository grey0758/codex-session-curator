const cache = new Map<string, { retryable: boolean; expiresAt: number }>();

export async function classifyUnknownTerminalError(diagnostic: string): Promise<boolean> {
  if (!diagnostic || diagnostic.length > 180) return false;
  const cached = cache.get(diagnostic);
  if (cached && cached.expiresAt > Date.now()) return cached.retryable;
  const { getEvaluatorEndpoints } = await import('./evaluator.js');
  const endpoint = getEvaluatorEndpoints().find((item) => item.model.toLowerCase().includes('deepseek'));
  if (!endpoint) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let retryable = false;
  try {
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.apiKeys[0]}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: 'system', content: 'Classify one redacted Codex terminal error. Return JSON only: {"retryable_upstream":boolean,"confidence":number}. True only for explicit transient API, transport, rate limit, or provider failures. For task errors, user interruption, uncertainty or insufficient evidence return false.' },
          { role: 'user', content: diagnostic },
        ],
        temperature: 0,
        max_tokens: 120,
        stream: false,
        ...(endpoint.model.toLowerCase().includes('flash') ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: controller.signal,
    });
    if (response.ok) {
      const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw = result.choices?.[0]?.message?.content ?? '';
      const match = raw.match(/\{[\s\S]*\}/);
      const verdict = match ? JSON.parse(match[0]) as { retryable_upstream?: unknown; confidence?: unknown } : null;
      retryable = verdict?.retryable_upstream === true && Number(verdict.confidence) >= 0.9;
    }
  } catch { /* ambiguity fails closed */ }
  finally { clearTimeout(timer); }
  cache.set(diagnostic, { retryable, expiresAt: Date.now() + 10 * 60_000 });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return retryable;
}
