// Attach a completed CLI continuation to its captured run. Never changes calls or TPS.
import { readFile, writeFile } from 'node:fs/promises';
import { Store } from '../store.mjs';

const [dataDir, parentId, runId, cliFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: node record-continuation.mjs DATA_DIR PARENT_ID RUN_ID CLI_JSON OUTPUT_JSON');
const raw = await readFile(cliFile, 'utf8');
const cli = JSON.parse(raw.slice(raw.indexOf('{')));
const result = cli.result || cli;
const text = result.payloads?.map(p => p.text || '').join('\n') || '';
const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s<>"\])}]+/g)].map(m => m[0].replace(/[.,;]+$/, '')))];
const store = new Store(dataDir);
try {
  const parent = store.run(parentId), run = store.run(runId);
  if (!parent || !run || run.sessionId !== parent.sessionId || run.status !== 'completed') throw new Error('Expected a completed continuation in the same session');
  if (urls.length !== 5 || !text) throw new Error('Expected exactly five final product URLs');
  const evidence = urls.map(url => {
    const matches = run.events.filter(e => e.type === 'firecrawl_request' && e.data.phase === 'end' && e.data.kind === 'scrape' && e.data.url === url && e.data.ok && e.data.data?.data?.metadata?.statusCode === 200);
    const event = matches.at(-1);
    if (!event) throw new Error(`Missing successful page evidence for ${url}`);
    const page = event.data.data.data;
    return { url, gift: event.data.gift, eventId: event.id, title: page.metadata.title, pageStatus: page.metadata.statusCode, capturedAt: event.at, markdownChars: page.markdown.length };
  });
  store.patch('run', parentId, { continuationRunId: runId });
  store.patch('run', runId, {
    label: 'Baseline 03 · continuación tras 429 · cinco regalos',
    parentRunId: parentId,
    finalText: text,
    productLinks: urls,
    quality: { status: 'reviewed', note: 'Five distinct retail product pages reviewed against captured Firecrawl markdown; names and published prices checked. Resumed session: do not present as an uninterrupted clean run.', evidence },
  });
  const completed = store.run(runId);
  await writeFile(outputFile, JSON.stringify({
    protocol: 'Baseline started in a new session; initial attempt failed on upstream 429; continuation resumed the same session without parameter overrides. Segment means are separate.',
    initial: { id: parentId, status: parent.status, summary: parent.summary },
    continuation: { id: runId, status: completed.status, summary: completed.summary },
    finalText: text, evidence,
    calls: [...parent.calls, ...completed.calls].map(c => ({ id: c.id, runId: c.runId, status: c.status, startedAt: c.startedAt, tps: c.tps, usage: c.usage, timing: c.timing, error: c.error, changes: c.changes, parameters: { model: c.request?.model, reasoning_effort: c.request?.reasoning_effort, temperature: c.request?.temperature ?? 'omitted', max_completion_tokens: c.request?.max_completion_tokens }, tools: c.toolCalls?.map(t => t.name) })),
  }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ parentId, runId, verifiedProductPages: evidence.length, summary: completed.summary, outputFile }));
} finally { store.close(); }
