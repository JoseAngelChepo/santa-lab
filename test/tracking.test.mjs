import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { officialRate,summarize,applyStrategy,redact } from '../metrics.mjs';
import { Lab,validateStrategy } from '../lab.mjs';
import { wrapCerebrasTracking } from '../instrumentation/tracking.ts';

test('official mean is unweighted, excludes missing timings and failures, includes reasoning in completion count',()=>{
  const calls=[{status:'completed',usage:{completion_tokens:1000},timing:{completion_time:1},tps:1000},{status:'completed',usage:{completion_tokens:1},timing:{completion_time:.004},tps:250},{status:'error',tps:99999},{status:'completed',tps:null}];
  assert.equal(summarize(calls).mean,625);assert.equal(summarize(calls).p90,1000);assert.equal(summarize(calls).missingTiming,1);assert.equal(officialRate({completion_tokens:1001},{completion_time:1}),1001);assert.equal(officialRate({completion_tokens:1},{completion_time:0}),null);
});
test('baseline does not mutate or replace payload; overrides record before and after',()=>{
  const payload={temperature:1,messages:[{role:'user',content:'gifts'}]};
  assert.equal(applyStrategy(payload,{mode:'baseline',temperature:0}).body,payload);
  const result=applyStrategy(payload,{mode:'experiment',temperature:0,reasoningEffort:'low'});
  assert.equal(payload.temperature,1);assert.equal(result.body.temperature,0);assert.equal(result.changes.length,2);assert.deepEqual(result.body.messages,payload.messages);
  assert.throws(()=>validateStrategy({mode:'experiment',temperature:-1}));assert.deepEqual(validateStrategy({mode:'baseline',temperature:0}),{mode:'baseline',version:1});
});
test('redaction removes keys and known credential from nested prompt and output',()=>{
  assert.deepEqual(redact({apiKey:'secret',messages:[{content:'Do not reveal abcdefghijk'}]},['abcdefghijk']),{apiKey:'[REDACTED]',messages:[{content:'Do not reveal [REDACTED]'}]});
});
test('native wrapper preserves request object, endpoint, response and stream events',async()=>{
  const diagnostics=channel('santa-lab.provider.v1'),seen=[];const listener=e=>{seen.push(e);if(e.type==='payload')e.observation.payload.temperature=99;};diagnostics.subscribe(listener);
  const payload={temperature:.2,messages:[{role:'user',content:'hello'}]},model={id:'moonshotai-kimi-k3.1-pro-trial',provider:'cerebras',baseUrl:'https://api.cerebras.ai/v1'};
  const done={role:'assistant',content:[{type:'text',text:'hello'}],serverGeneration:{outputTokens:100,completionMs:100},stopReason:'stop'};
  const events=[{type:'text_delta',delta:'hello'},{type:'done',message:done}];let sent;
  const inner=async(m,ctx,opts)=>{assert.equal(m,model);assert.equal(opts.apiKey,'test-key');assert.equal(await opts.onPayload(payload,m),undefined);sent=JSON.stringify(payload);await opts.onResponse({status:200,headers:{'x-request-id':'upstream'}},m);return {push(){},end(){},result:async()=>done,async *[Symbol.asyncIterator](){yield* events;}};};
  try{const wrapped=wrapCerebrasTracking({streamFn:inner});const stream=await wrapped(model,{}, {requestId:'call-a',apiKey:'test-key'});const actual=[];for await(const event of stream)actual.push(event);assert.deepEqual(actual,events);assert.equal(await stream.result(),done);assert.equal(sent,JSON.stringify(payload));assert.equal(payload.temperature,.2);assert.ok(seen.every(e=>e.callId==='call-a'));assert.equal(seen.find(e=>e.type==='end').message.serverGeneration.outputTokens,100);assert.ok(seen.some(e=>e.type==='first-delta'));}finally{diagnostics.unsubscribe(listener);}
});
test('plugin correlates native IDs and stores official server timing separately from wall time',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'santa-lab-test-'));const lab=new Lab({dataDir:dir,key:'test-secret-abc'});
  try{
    lab.event('llm_input',{runId:'native-run',sessionId:'sid',model:'kimi',provider:'cerebras',prompt:'five gifts'},{});
    const run=lab.store.runs()[0];lab.event('model_call_started',{runId:'native-run',callId:'call-1'},{});
    lab.capture({type:'start',callId:'call-1',at:new Date().toISOString()});const observation={payload:{temperature:1}};
    lab.capture({type:'payload',callId:'call-1',observation});assert.equal(observation.replacement,undefined);
    lab.capture({type:'end',callId:'call-1',at:new Date().toISOString(),elapsedMs:10000,message:{content:[],usage:{input:200,output:100,reasoningTokens:30},serverGeneration:{outputTokens:100,completionMs:50},stopReason:'stop'}});
    const detail=lab.store.run(run.id);assert.equal(detail.summary.mean,2000);assert.equal(detail.calls[0].wallMs,10000);assert.equal(detail.calls[0].correlation,'native-call-id');assert.equal(detail.calls[0].requestHash,detail.calls[0].sentHash);
  }finally{await lab.stop();rmSync(dir,{recursive:true,force:true});}
});
test('dashboard rejects foreign origins and mutation requests without application header',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'santa-lab-http-'));const lab=new Lab({port:0,dataDir:dir,logger:{info(){}}});await lab.start();lab.port=lab.server.address().port;
  try{const url=`http://127.0.0.1:${lab.port}`;assert.equal((await fetch(`${url}/api/status`)).status,200);assert.equal((await fetch(`${url}/api/runs`,{method:'POST',body:'{}'})).status,403);assert.equal((await fetch(`${url}/api/status`,{headers:{origin:'https://foreign.test'}})).status,403);}finally{await lab.stop();rmSync(dir,{recursive:true,force:true});}
});
test('retries reusing the same native call ID remain separate and errors never become a completed manual run',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'santa-lab-retry-'));const lab=new Lab({dataDir:dir});
  try{
    lab.event('llm_input',{runId:'retry-run',sessionId:'sid',prompt:'gifts'},{});
    const run=lab.store.runs()[0];
    for(let attempt=0;attempt<3;attempt++){
      lab.event('model_call_started',{runId:'retry-run',callId:'same-call'},{});
      lab.capture({type:'start',callId:'same-call',at:new Date().toISOString()});
      lab.capture({type:'end',callId:'same-call',at:new Date().toISOString(),message:{content:[],stopReason:'error',errorMessage:'429 high traffic'}});
    }
    lab.event('agent_end',{runId:'retry-run',success:true,messages:[]},{});
    const detail=lab.store.run(run.id);assert.equal(detail.calls.length,3);assert.equal(new Set(detail.calls.map(c=>c.id)).size,3);assert.equal(detail.summary.mean,null);assert.equal(detail.summary.errors,3);assert.equal(detail.status,'failed');
  }finally{await lab.stop();rmSync(dir,{recursive:true,force:true});}
});
test('background cron cannot adopt the pending baseline or contaminate its mean',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'santa-lab-scope-'));const lab=new Lab({dataDir:dir});
  try{
    lab.pending={id:'baseline',sessionId:'baseline-session'};
    lab.store.put('run',{id:'baseline',status:'queued',strategy:{mode:'baseline'}});
    lab.event('llm_input',{runId:'cron-run',sessionId:'cron-session',prompt:'memory maintenance'},{sessionKey:'agent:main:cron:job:run:abc'});
    lab.event('model_call_started',{runId:'cron-run',callId:'cron-call'},{sessionKey:'agent:main:cron:job:run:abc'});
    lab.capture({type:'start',callId:'cron-call',at:new Date().toISOString()});
    lab.capture({type:'end',callId:'cron-call',at:new Date().toISOString(),message:{content:[],usage:{output:100},serverGeneration:{outputTokens:100,completionMs:1},stopReason:'stop'}});
    assert.equal(lab.store.run('baseline').calls.length,0);assert.equal(lab.store.run('baseline').summary.mean,null);
    lab.event('llm_input',{runId:'workshop',sessionId:'internal-session-effects-skill-workshop-review_test',prompt:'maintenance'},{sessionKey:'agent:main:internal-session-effects:skill-workshop-review_test'});
    lab.event('model_call_started',{runId:'workshop',callId:'workshop-call'},{sessionKey:'agent:main:internal-session-effects:skill-workshop-review_test'});
    lab.capture({type:'start',callId:'workshop-call',at:new Date().toISOString()});
    assert.equal(lab.activeRuns.size,0);assert.equal(lab.store.get('call','workshop-call:attempt:1'),null);
    lab.event('llm_input',{runId:'shopping',sessionId:'baseline-session',prompt:'five gifts'},{sessionKey:'agent:main:explicit:baseline-session'});
    lab.event('model_call_started',{runId:'shopping',callId:'shop-call'},{sessionKey:'agent:main:explicit:baseline-session'});
    lab.capture({type:'start',callId:'shop-call',at:new Date().toISOString()});
    lab.capture({type:'end',callId:'shop-call',at:new Date().toISOString(),message:{content:[],usage:{output:100},serverGeneration:{outputTokens:100,completionMs:100},stopReason:'stop'}});
    assert.equal(lab.store.run('baseline').summary.mean,1000);assert.equal(lab.store.run('baseline').calls.length,1);
    lab.store.put('call',{id:'historical-background',runId:'baseline',scope:'background',status:'completed',tps:99999,usage:{completion_tokens:99999},timing:{completion_time:1}});
    assert.equal(lab.store.run('baseline').summary.mean,1000);assert.equal(lab.store.runs()[0].summary.mean,1000);
    lab.event('agent_end',{runId:'shopping',success:true,messages:[]},{});
    lab.event('llm_input',{runId:'shopping',sessionId:'baseline-session',prompt:'retry'},{sessionKey:'agent:main:explicit:baseline-session'});
    assert.equal(lab.store.list('run').length,1);
  }finally{lab.pending=null;await lab.stop();rmSync(dir,{recursive:true,force:true});}
});
