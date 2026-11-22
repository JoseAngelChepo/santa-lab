// Read-only comparison of complete experiment segments. Does not call a model.
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { summarize } from '../metrics.mjs';

const [dbFile, oldIds, newIds, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: node compare-delivery.mjs DB OLD_IDS_COMMA NEW_IDS_COMMA OUTPUT_JSON');
const db = new DatabaseSync(dbFile, { readOnly: true });
const get = (kind,id) => JSON.parse(db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id).data);
const related = (kind,id) => db.prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.runId')=?").all(kind,id).map(r=>JSON.parse(r.data));
function group(ids) {
  const runs=ids.split(',').map(id=>get('run',id));
  const calls=runs.flatMap(r=>related('call',r.id)).filter(c=>c.scope!=='background').sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
  const events=runs.flatMap(r=>related('event',r.id));
  const net=events.filter(e=>e.type==='firecrawl_request'&&e.data.phase==='end').map(e=>e.data);
  const successfulPages=net.filter(e=>e.kind==='scrape'&&e.ok);
  const pageCounts=Object.fromEntries([...new Set(successfulPages.map(e=>e.url))].map(url=>[url,successfulPages.filter(e=>e.url===url).length]));
  const finished=calls.filter(c=>c.status==='completed'&&c.tps);
  const firstRequest=finished[0]?.request||{};
  const systemChars=(firstRequest.messages||[]).filter(m=>m.role==='system').reduce((n,m)=>n+String(m.content||'').length,0);
  const end=runs.at(-1).endedAt;
  return {
    runs:runs.map(r=>({id:r.id,label:r.label,status:r.status,startedAt:r.startedAt,endedAt:r.endedAt,promptHash:r.promptHash,promptPolicy:r.protocol?.promptPolicy,productLinks:r.productLinks,finalText:r.finalText||[...calls].reverse().find(c=>c.runId===r.id&&c.text)?.text})),
    summary:{...summarize(calls),elapsedSeconds:end?(Date.parse(end)-Date.parse(runs[0].startedAt))/1000:null,activeSegmentSeconds:runs.every(r=>r.endedAt)?runs.reduce((n,r)=>n+(Date.parse(r.endedAt)-Date.parse(r.startedAt))/1000,0):null,reasoningTokensPerMeasuredCall:finished.length?finished.reduce((n,c)=>n+(c.usage?.completion_tokens_details?.reasoning_tokens||0),0)/finished.length:null,modelGenerationSeconds:finished.reduce((n,c)=>n+(c.timing?.completion_time||0),0),inputFirst:finished[0]?.usage?.prompt_tokens,inputLast:finished.at(-1)?.usage?.prompt_tokens,modelInputsContainingTruncation:calls.filter(c=>c.request?.messages?.some(m=>typeof m.content==='string'&&m.content.includes('[truncated]'))).length,lastToolResultTruncated:calls.filter(c=>c.status==='completed'&&c.request?.messages?.at(-1)?.content?.includes('[truncated]')).length,firecrawlRequests:net.length,firecrawlErrors:net.filter(e=>!e.ok).length,searchRequests:net.filter(e=>e.kind==='search').length,scrapeRequests:net.filter(e=>e.kind==='scrape').length,successfulRepeatedScrapes:successfulPages.length-Object.keys(pageCounts).length,pageCounts},
    presentation:{firstSystemChars:systemChars,firstToolNames:(firstRequest.tools||[]).map(t=>t.function?.name),firstRequestBytes:finished[0]?.requestBytes},
    calls:calls.map((c,i)=>({index:i+1,id:c.id,status:c.status,error:c.error,tps:c.tps,usage:c.usage,timing:c.timing,wallMs:c.wallMs,parameters:Object.fromEntries(Object.entries(c.request||{}).filter(([k])=>!['messages','tools'].includes(k))),overrides:c.changes,requestedTools:c.toolCalls})),
  };
}
try {
  const before=group(oldIds),after=group(newIds);
  const params=g=>[...new Set(g.calls.filter(c=>c.status==='completed').map(c=>JSON.stringify(c.parameters)))];
  const report={protocol:'Observed comparison, not proof of a causal speedup. Inspect model, parameter, prompt-hash and policy differences. Before may contain multiple segments after retries; report elapsed and active times separately. Artificial status/token-padding calls must not be included in shopping runs.',before,after,checks:{beforeParameterSets:params(before),afterParameterSets:params(after),sameInitialPromptHash:before.runs[0].promptHash!=null&&before.runs[0].promptHash===after.runs[0].promptHash,afterNoParameterOverrides:after.calls.every(c=>!c.overrides?.length)}};
  await writeFile(outputFile,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({before:before.summary,after:after.summary,checks:report.checks},null,2));
} finally { db.close(); }
