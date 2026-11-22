// One-time repair of development captures. Preserve every record and original assignment.
import { Store } from '../store.mjs';
const store=new Store(process.argv[2]);
const events=store.list('event'),runs=store.list('run'),destinations=new Map(),background=new Set();
for(const event of events){
  const native=event.data?.runId||event.context?.runId,key=event.context?.sessionKey;
  if(key?.includes(':cron:'))background.add(native);
  const match=key?.match(/^agent:main:explicit:santa-lab-([a-f0-9-]+)$/);
  if(match&&runs.some(r=>r.id===match[1]))destinations.set(native,match[1]);
}
store.db.exec('BEGIN IMMEDIATE');
try{
  for(const call of store.list('call')){
    const native=(call.nativeCallId||call.id).split(':model:')[0];const destination=destinations.get(native);
    if(destination&&destination!==call.runId)store.patch('call',call.id,{runId:destination,originalCapturedRunId:call.originalCapturedRunId||call.runId,correlation:'reconciled-native-session-and-call-id'});
    if(background.has(native))store.patch('call',call.id,{scope:'background'});
  }
  for(const event of events){const native=event.data?.runId||event.context?.runId,destination=destinations.get(native);if(destination&&destination!==event.runId)store.patch('event',event.id,{runId:destination,originalCapturedRunId:event.originalCapturedRunId||event.runId});}
  for(const run of runs){
    const native=[...destinations].find(([,id])=>id===run.id)?.[0];
    if(native){const matching=events.find(e=>(e.data?.runId||e.context?.runId)===native&&e.context?.sessionKey?.includes(`santa-lab-${run.id}`));const summary=store.run(run.id).summary;store.patch('run',run.id,{openclawRunId:native,sessionKey:matching?.context?.sessionKey,scope:'experiment',status:summary.measuredCalls?'interrupted':'failed',endedAt:run.endedAt||new Date().toISOString(),error:summary.measuredCalls?'Captura inicial reconciliada; ejecución incompleta, no usar como baseline válida.':'Cerebras devolvió errores 429; no se completó la búsqueda y no hay TPS válido.',reconciliation:{version:1,reason:'Scope initial captures by exact session and native call ID; preserve original assignments.'}});}
    else if(background.has(run.openclawRunId))store.patch('run',run.id,{scope:'background',label:'Mantenimiento · fuera de baseline'});
  }
  store.db.exec('COMMIT');console.log('Reconciled initial captures by exact session. No records deleted.');
}catch(error){store.db.exec('ROLLBACK');throw error;}finally{store.close();}
