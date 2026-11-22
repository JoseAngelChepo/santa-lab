import http from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from './store.mjs';
import { applyStrategy, digest, officialRate } from './metrics.mjs';

const publicDir=fileURLToPath(new URL('./public/',import.meta.url));
export const BASELINE_PROMPT='Find five Christmas gifts from real stores: one for a child, a teenager, a cook, a reader, and an outdoor enthusiast. Search all five in one firecrawl_search_batch, then verify product pages in one firecrawl_scrape_batch. Batch unresolved items together. Use tool_search and tool_call if the tools are deferred. Return exactly five distinct products with their names, stores, published prices/currencies and direct links. Never invent products, prices or URLs.';

async function readBody(req,limit=20*1024*1024) {let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks);}
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
export function validateStrategy(s={mode:'baseline'}) {
  if(!['baseline','experiment'].includes(s.mode))throw new Error('Invalid strategy mode');
  if(s.mode==='baseline')return {mode:'baseline',version:1};
  const result={mode:'experiment',version:1};
  if(s.temperature!=null){if(!Number.isFinite(s.temperature)||s.temperature<0||s.temperature>2)throw new Error('Temperature: 0–2');result.temperature=s.temperature;}
  if(s.reasoningEffort!=null){if(!['low','medium','high','max'].includes(s.reasoningEffort))throw new Error('Unsupported reasoning effort');result.reasoningEffort=s.reasoningEffort;}
  if(s.maxCompletionTokens!=null){if(!Number.isInteger(s.maxCompletionTokens)||s.maxCompletionTokens<128||s.maxCompletionTokens>16384)throw new Error('Output limit: 128–16384');result.maxCompletionTokens=s.maxCompletionTokens;}
  return result;
}

export class Lab {
  constructor({port=18891,dataDir,launcher,logger=console,key=process.env.CEREBRAS_API_KEY,promptPolicy=null,defaultPrompt=BASELINE_PROMPT}){
    this.promptPolicy=promptPolicy;this.defaultPrompt=defaultPrompt;
    this.port=port;this.dataDir=dataDir;this.launcher=launcher;this.logger=logger;this.key=key;this.callRuns=new Map();this.toolRuns=new Map();this.nativeAttempts=new Map();this.ignoredCalls=new Set();
    this.store=new Store(dataDir,[key,process.env.FIRECRAWL_API_KEY]);this.activeRuns=new Map();this.nativeRuns=new Map();this.pending=null;this.child=null;this.closing=false;
    for(const r of this.store.list('run').reverse())if(r.openclawRunId&&!this.nativeRuns.has(r.openclawRunId))this.nativeRuns.set(r.openclawRunId,r.id);
    // A previous process cannot leave a completed-looking run behind.
    for(const run of this.store.list('run'))if(['queued','running'].includes(run.status))this.store.patch('run',run.id,{status:'interrupted',endedAt:new Date().toISOString(),error:'The previous process ended before closing this run.'});
    for(const run of this.store.list('run'))if(run.protocol?.measurement&&!run.captureSchema)this.store.patch('run',run.id,{status:'interrupted',error:'Initial diagnostic capture: OpenClaw reused callId across retries and this version retained only the last attempt. Events are preserved. Not a valid baseline.'});
  }
  event(type,event,ctx={}){
    if(this.closing)return;
    // Background maintenance is not an experiment and must never adopt a pending baseline.
    if(ctx.sessionKey?.includes(':cron:')||ctx.trigger==='cron'||ctx.sessionKey?.includes(':internal-session-effects:')||event.sessionId?.startsWith('internal-session-effects-')){
      if(event.callId)this.ignoredCalls.add(event.callId);
      return;
    }
    const nativeId=event.runId||ctx.runId;
    let runId=this.activeRuns.get(nativeId)||this.nativeRuns.get(nativeId);
    if(type==='llm_input'){
      const matchesPending=this.pending&&(event.sessionId===this.pending.sessionId||ctx.sessionKey===`agent:main:explicit:${this.pending.sessionId}`);
      runId ||= (matchesPending?this.pending.id:null) || randomUUID();this.activeRuns.set(nativeId,runId);this.nativeRuns.set(nativeId,runId);
      if(!this.store.get('run',runId))this.store.put('run',{id:runId,label:'Manual chat',strategy:{mode:'baseline',version:1},startedAt:new Date().toISOString(),status:'running',prompt:event.prompt});
      this.store.patch('run',runId,{openclawRunId:nativeId,sessionKey:ctx.sessionKey,sessionId:event.sessionId,provider:event.provider,model:event.model,status:'running',inputSnapshot:event});
    }
    if(type==='model_call_started' || type==='model_call_ended'){
      if(runId && event.callId){this.callRuns.set(event.callId,runId);const capturedId=this.nativeAttempts.get(event.callId)||event.callId;if(this.store.get('call',capturedId))this.store.patch('call',capturedId,{runId,correlation:'native-call-id'});}
    }
    if(!runId)return;
    if(type==='before_tool_call'&&event.toolCallId)this.toolRuns.set(event.toolCallId,runId);
    this.store.put('event',{id:randomUUID(),runId,type,at:new Date().toISOString(),data:event,context:{agentId:ctx.agentId,sessionKey:ctx.sessionKey,runId:nativeId}});
    if(type==='agent_end'){
      const owned=this.store.get('run',runId)?.runnerManaged;
      this.store.patch('run',runId,{...(owned?{}:{status:event.success&&this.store.run(runId).summary.measuredCalls>0?'completed':'failed',endedAt:new Date().toISOString()}),lastAgentAttemptSuccess:event.success,agentDurationMs:event.durationMs,error:event.error,finalMessages:event.messages});
      this.activeRuns.delete(nativeId);
    }
  }
  currentRun(){const ids=[...new Set([...this.activeRuns.values()])];return ids.length===1?this.store.get('run',ids[0]):ids.length===0?this.pending:null;}
  network(event){
    if(this.closing)return;
    const runId=this.toolRuns.get(event.toolCallId);
    this.store.put('event',{id:`${event.id}:${event.phase}`,runId:runId||null,type:'firecrawl_request',at:event.at,data:event,context:{correlation:runId?'native-tool-call-id':'unattributed'}});
  }
  capture(event){
    if(this.closing)return;
    const nativeId=event.callId;
    if(this.ignoredCalls.has(nativeId))return;
    if(event.type==='start'){
      const count=this.store.list('call').filter(c=>(c.nativeCallId||c.id)===nativeId).length;
      this.nativeAttempts.set(nativeId,`${nativeId}:attempt:${count+1}`);
    }
    const id=this.nativeAttempts.get(nativeId)||nativeId, old=this.store.get('call',id);
    const nativeRunId=this.callRuns.get(nativeId);
    const current=nativeRunId?this.store.get('run',nativeRunId):null;
    if(event.type==='start'){
      this.store.put('call',{id,nativeCallId:nativeId,runId:current?.id||null,correlation:nativeRunId?'native-call-id':current?'single-active-run':'unattributed',startedAt:event.at,status:'running',model:event.model,provider:event.provider,strategy:current?.strategy||{mode:'baseline',version:1},instrumentation:'public provider wrapStreamFn / onPayload / onResponse; native stream result'});
    }else if(event.type==='payload'){
      const original=event.observation.payload;
      const strategy=current?.strategy||{mode:'baseline',version:1};
      const shaped=applyStrategy(original,strategy);
      if(shaped.changes.length)event.observation.replacement=shaped.body;
      this.store.patch('call',id,{request:shaped.body,originalRequest:shaped.changes.length?original:undefined,requestHash:digest(original),sentHash:digest(shaped.body),requestBytes:Buffer.byteLength(JSON.stringify(shaped.body)),changes:shaped.changes,strategy,payloadObservedAtMs:event.elapsedMs,payloadBoundary:'onPayload after prior callback; before serialization (not a packet capture)'});
    }else if(event.type==='response'){
      this.store.patch('call',id,{httpStatus:event.status,headersReceivedMs:event.elapsedMs,upstreamRequestId:event.requestId});
    }else if(event.type==='first-delta' || event.type==='first-visible'){
      this.store.patch('call',id,{[event.type==='first-delta'?'firstDeltaMs':'firstVisibleMs']:event.elapsedMs});
    }else if(event.type==='end'){
      const msg=event.message,g=msg.serverGeneration;
      const usage={prompt_tokens:msg.usage?.contextUsage?.promptTokens??((msg.usage?.input||0)+(msg.usage?.cacheRead||0)+(msg.usage?.cacheWrite||0)),uncached_prompt_tokens:msg.usage?.input,completion_tokens:g?.outputTokens??msg.usage?.output,completion_tokens_details:{reasoning_tokens:msg.usage?.reasoningTokens??null},cached_tokens:msg.usage?.cacheRead};
      const timing=g?{completion_time:g.completionMs/1000}:null;
      const content=msg.content||[];
      this.store.patch('call',id,{status:['error','aborted'].includes(msg.stopReason)?'error':'completed',endedAt:event.at,wallMs:event.elapsedMs,usage,timing,tps:officialRate(usage,timing),text:content.filter(c=>c.type==='text').map(c=>c.text).join(''),reasoning:content.filter(c=>c.type==='thinking').map(c=>c.thinking).join(''),toolCalls:content.filter(c=>c.type==='toolCall'),finishReason:msg.stopReason,error:msg.errorMessage,upstreamRequestId:msg.responseId||old?.upstreamRequestId,message:msg,timingSource:'official patch serverGeneration; queue/prefill not exposed at this boundary'});
    }else if(event.type==='error'){
      this.store.patch('call',id,{status:'error',error:event.error,wallMs:event.elapsedMs,endedAt:event.at});
    }
  }
  async createRun(input){
    if(this.closing)throw new Error('Service stopping');
    if(!this.launcher)throw new Error('Configure the OpenClaw launcher path');
    if(this.child||this.pending||this.activeRuns.size)throw Object.assign(new Error('A run is already active. Wait for it to finish.'),{status:409});
    const strategy=validateStrategy(input.strategy);const prompt=String(input.prompt||this.defaultPrompt).trim();if(!prompt||prompt.length>30000)throw new Error('Empty or oversized prompt');
    const id=randomUUID(),label=String(input.label||'Baseline · five gifts').slice(0,120);
    const run={id,label,prompt,strategy,captureSchema:2,runnerManaged:true,status:'queued',startedAt:new Date().toISOString(),sessionId:`santa-lab-${id}`,protocol:{measurement:'official-server-mean-v1',instrumentation:'native provider wrapper; direct Cerebras connection; no headers persisted',correlation:'native OpenClaw requestId/callId plus per-invocation attempt; unattributed calls excluded'},promptHash:digest(prompt)};
    run.protocol.promptPolicy=this.promptPolicy;
    this.store.put('run',run);this.pending=run;
    const promptFile=path.join(this.dataDir,`prompt-${id}.txt`);await writeFile(promptFile,prompt,{mode:0o600});
    const args=['agent','--agent','main','--session-id',run.sessionId,'--message-file',promptFile,'--timeout','900','--json'];
    let stdout='',stderr='',settled=false;
    try{this.child=spawn(this.launcher,args,{stdio:['ignore','pipe','pipe'],detached:true,env:process.env});}
    catch(error){this.pending=null;this.store.patch('run',id,{status:'failed',error:error.message});await unlink(promptFile).catch(()=>{});throw error;}
    const child=this.child;const limit=8*1024*1024;
    child.stdout.on('data',chunk=>{if(stdout.length<limit)stdout+=chunk.toString();});child.stderr.on('data',chunk=>{if(stderr.length<limit)stderr+=chunk.toString();});
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},930000);
    const settle=async(code,error)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(this.closing){await unlink(promptFile).catch(()=>{});return;}
      let execution;try{const start=stdout.indexOf('{');execution=JSON.parse(stdout.slice(start));}catch{}
      const current=this.store.get('run',id);const result=execution?.result||execution;
      const text=result?.payloads?.map(p=>p.text||'').join('\n')||'';
      const urls=[...new Set([...text.matchAll(/https?:\/\/[^\s<>"\])}]+/g)].map(m=>m[0].replace(/[.,;]+$/,'')))];
      const summary=this.store.run(id).summary;
      const failure=error||code!==0||!text||summary.measuredCalls===0||result?.meta?.aborted;
      this.store.patch('run',id,{status:current?.cancelRequested?'interrupted':failure?'failed':'completed',endedAt:new Date().toISOString(),exitCode:code,error:error?.message||current?.error||(failure&&!text?'The agent did not produce a valid final response.':undefined),finalText:text,productLinks:urls,quality:{status:'needs-review',note:'Extracted links alone do not prove five real products; inspect tool and page evidence.'},cliResult:execution,cliStderr:stderr,cliStdout:execution?undefined:stdout});
      this.pending=null;this.child=null;await unlink(promptFile).catch(()=>{});
    };
    child.once('error',error=>void settle(null,error));child.once('close',code=>void settle(code));
    return run;
  }
  async cancelRun(id){
    const run=this.store.get('run',id);
    if(!run||this.pending?.id!==id)throw new Error('This run is not active');
    if(!run.openclawRunId||!run.sessionKey)throw new Error('The agent is still starting. Try again in a few seconds.');
    const child=spawn(this.launcher,['gateway','call','chat.abort','--params',JSON.stringify({sessionKey:run.sessionKey,runId:run.openclawRunId})],{stdio:['ignore','ignore','pipe'],env:process.env});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    if(code!==0)throw new Error('OpenClaw could not stop the run');
    this.store.patch('run',id,{cancelRequested:true,status:'interrupted',endedAt:new Date().toISOString(),error:'Run stopped; all attempts are preserved.'});
    return {ok:true};
  }
  async handle(req,res){
    try{
      if(this.closing){json(res,503,{error:'Service stopping'});return;}
      const allowed=[`127.0.0.1:${this.port}`,`localhost:${this.port}`];if(!allowed.includes(req.headers.host)){json(res,403,{error:'Local host required'});return;}
      const url=new URL(req.url,`http://127.0.0.1:${this.port}`);
      if(req.headers.origin&&!allowed.map(host=>`http://${host}`).includes(req.headers.origin)){json(res,403,{error:'Same-origin access required'});return;}
      if(req.method==='POST'){
        if(req.headers['x-santa-lab']!=='1'){json(res,403,{error:'Local application header required'});return;}
        if(url.pathname==='/api/runs'){json(res,201,await this.createRun(JSON.parse((await readBody(req,65536)).toString())));return;}
        const cancel=url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/cancel$/);if(cancel){json(res,200,await this.cancelRun(cancel[1]));return;}
        json(res,404,{error:'Not found'});return;
      }
      if(req.method!=='GET'){json(res,405,{error:'GET required'});return;}
      if(url.pathname==='/api/status'){json(res,200,{name:'Santa Lab',version:'0.1.0',baselinePrompt:this.defaultPrompt,promptPolicy:this.promptPolicy,busy:!!this.child||!!this.pending||this.activeRuns.size>0,upstream:'https://api.cerebras.ai/v1',port:this.port,unattributedCalls:this.store.list('call').filter(c=>!c.runId).length});return;}
      if(url.pathname==='/api/runs'){json(res,200,this.store.runs());return;}
      const match=url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)(\/export)?$/);
      if(match){const run=this.store.run(match[1]);if(!run){json(res,404,{error:'Run not found'});return;}if(match[2])res.setHeader('content-disposition',`attachment; filename="santa-lab-${run.id}.json"`);json(res,200,run);return;}
      const file={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[url.pathname];
      if(file){const data=await readFile(path.join(publicDir,file));res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(data);return;}
      json(res,404,{error:'Not found'});
    }catch(error){if(!res.headersSent)json(res,error.status||400,{error:error.message});else res.destroy();}
  }
  async start(){await mkdir(this.dataDir,{recursive:true,mode:0o700});this.server=http.createServer((req,res)=>void this.handle(req,res));await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',resolve);});this.logger.info(`Santa Lab: http://127.0.0.1:${this.port}`);}
  async stop(){this.closing=true;if(this.pending)this.store.patch('run',this.pending.id,{status:'interrupted',endedAt:new Date().toISOString(),error:'The service stopped during the run.'});if(this.child){try{process.kill(-this.child.pid,'SIGTERM');}catch{}}if(this.server){this.server.closeIdleConnections();await new Promise(resolve=>this.server.close(resolve));}this.store.close();}
}
