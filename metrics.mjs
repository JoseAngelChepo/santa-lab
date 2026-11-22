import { createHash } from 'node:crypto';

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 8)) value = value.split(secret).join('[REDACTED]');
    return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]').replace(/\bcsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  return value;
}

// Matches the official patch: completion_tokens / completion_time, no -1.
export function officialRate(usage, timing) {
  const n = usage?.completion_tokens, t = timing?.completion_time;
  return Number.isFinite(n) && n > 0 && Number.isFinite(t) && t > 0 ? n / t : null;
}

export function summarize(calls) {
  const eligible = calls.filter(c => c.status === 'completed' && Number.isFinite(c.tps) && c.tps > 0);
  const rates = eligible.map(c => c.tps).sort((a,b) => a-b);
  return {
    calls: calls.length, measuredCalls: rates.length, missingTiming: calls.filter(c => c.status === 'completed' && c.tps == null).length,
    errors: calls.filter(c => c.status === 'error').length,
    mean: rates.length ? rates.reduce((a,b) => a+b,0) / rates.length : null,
    p90: rates.length ? rates[Math.ceil(rates.length * .9)-1] : null,
    inputTokens: calls.reduce((n,c) => n+(c.usage?.prompt_tokens || 0),0),
    outputTokens: calls.reduce((n,c) => n+(c.usage?.completion_tokens || 0),0),
    reasoningTokens: calls.reduce((n,c) => n+(c.usage?.completion_tokens_details?.reasoning_tokens || 0),0),
    // Diagnostic only. Never substitute this for the official arithmetic mean.
    weightedTps: eligible.length ? eligible.reduce((n,c) => n+c.usage.completion_tokens,0) / eligible.reduce((n,c) => n+c.timing.completion_time,0) : null
  };
}

export function applyStrategy(body, strategy) {
  if (!strategy || strategy.mode === 'baseline') return { body, changes: [] };
  const next = structuredClone(body), changes = [];
  const mappings = [['temperature','temperature'],['reasoningEffort','reasoning_effort'],['maxCompletionTokens','max_completion_tokens']];
  for (const [key,field] of mappings) if (strategy[key] != null) {
    changes.push({ field, before: next[field] ?? null, after: strategy[key] }); next[field] = strategy[key];
  }
  return { body: next, changes };
}
