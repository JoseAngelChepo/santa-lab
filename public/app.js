const $=id=>document.getElementById(id);
const fmt=(value,digits=0)=>value==null?'—':Number(value).toLocaleString('es-MX',{maximumFractionDigits:digits});
const seconds=ms=>ms==null?'—':`${fmt(ms/1000,2)} s`;
const stamp=s=>new Date(s).toLocaleString('es-MX',{timeZone:'America/Mexico_City',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const statusText={queued:'En cola',running:'En ejecución',completed:'Finalizada',failed:'Falló',error:'Error',interrupted:'Interrumpida'};
let selected=new URLSearchParams(location.search).get('run'),callId=null,tab='input',run=null,lastRender='',busy=false;
function node(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
function pre(value){const n=node('pre',typeof value==='string'?value:JSON.stringify(value,null,2));return n;}
async function api(path,options){const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw new Error(data.error||'Solicitud fallida');return data;}
function openForm(){ $('dialog').showModal();$('form-error').textContent=''; }
$('new-run').onclick=openForm;$('first-run').onclick=openForm;$('close-dialog').onclick=()=>$('dialog').close();
$('cancel').onclick=async()=>{if(!run)return;$('cancel').disabled=true;try{await api(`/api/runs/${run.id}/cancel`,{method:'POST',headers:{'x-santa-lab':'1'}});await refresh();}catch(error){$('notice').textContent=error.message;}finally{$('cancel').disabled=false;}};
$('form').elements.mode.onchange=e=>{$('experiment-fields').disabled=e.target.value!=='experiment';};
$('form').onsubmit=async event=>{
  event.preventDefault();const f=event.currentTarget.elements;const strategy={mode:f.mode.value};
  if(strategy.mode==='experiment'){if(f.temperature.value!=='')strategy.temperature=Number(f.temperature.value);if(f.reasoningEffort.value)strategy.reasoningEffort=f.reasoningEffort.value;if(f.maxCompletionTokens.value!=='')strategy.maxCompletionTokens=Number(f.maxCompletionTokens.value);}
  const submit=event.currentTarget.querySelector('[type=submit]');submit.disabled=true;
  try{const created=await api('/api/runs',{method:'POST',headers:{'content-type':'application/json','x-santa-lab':'1'},body:JSON.stringify({label:f.label.value,prompt:f.prompt.value,strategy})});selected=created.id;callId=null;lastRender='';history.replaceState(null,'',`?run=${selected}`);$('dialog').close();await refresh();}catch(error){$('form-error').textContent=error.message;}finally{submit.disabled=false;}
};
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.tab;renderInspection();});
function block(label,value){const wrap=node('section');wrap.append(node('div',label,'section-label'),Object.assign(pre(value),{className:'json-block'}));return wrap;}
function renderInspection(){
  const call=run?.calls.find(c=>c.id===callId);const pane=$('inspection');pane.replaceChildren();document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===tab)));
  if(!call){$('call-title').textContent='Esperando la primera llamada';$('call-status').textContent='';$('call-facts').replaceChildren();pane.append(node('p','Aquí aparecerá el payload real de la solicitud.','fine'));return;}
  $('call-title').textContent=`Llamada ${run.calls.indexOf(call)+1}`;$('call-status').textContent=statusText[call.status]||call.status;$('call-status').className=`status ${call.status==='error'?'error':''}`;
  const facts=[['TPS',fmt(call.tps,1)],['Generación',seconds(call.timing?.completion_time*1000||null)],['Primera delta¹',seconds(call.firstDeltaMs)],['Input',fmt(call.usage?.prompt_tokens)],['Output',fmt(call.usage?.completion_tokens)],['Reasoning',fmt(call.usage?.completion_tokens_details?.reasoning_tokens)]];
  $('call-facts').replaceChildren(...facts.map(([label,value])=>{const n=node('span',`${label}  `);n.append(node('strong',value));return n;}));
  if(tab==='input'){
    const {messages,tools,...params}=call.request||{};pane.append(block('PARÁMETROS EFECTIVOS',{...params,tools_count:tools?.length||0}));
    if(tools?.length){const d=node('details',null,'message-card');d.append(node('summary',`${tools.length} herramientas · ver esquemas completos`,'message-role'),pre(tools));pane.append(d);}
    for(const [i,message] of (messages||[]).entries()){
      const card=node('details',null,'message-card');const summary=node('summary',`${i+1} · ${String(message.role||'message').toUpperCase()}${message.name?' · '+message.name:''}`,'message-role');card.append(summary,pre(message));if(message.role==='user')card.open=true;pane.append(card);
    }
    pane.append(node('p',call.payloadBoundary||'Pendiente de enviar.','fine'));
  }else if(tab==='output'){
    if(call.error)pane.append(block('ERROR',call.error));pane.append(block('RESPUESTA VISIBLE',call.text||'Sin texto visible'));
    if(call.reasoning)pane.append(block('RAZONAMIENTO DEVUELTO POR EL ENDPOINT',call.reasoning));
    if(call.toolCalls?.length)pane.append(block('SOLICITUDES DE HERRAMIENTAS',call.toolCalls));
  }else if(tab==='meta'){
    const {request,originalRequest,message,text,reasoning,toolCalls,...metadata}=call;pane.append(block('METADATOS Y TIEMPOS',metadata));pane.append(node('p','¹ Tiempo observado hasta la primera delta de texto, razonamiento o herramienta. No es el TTFT interno del servidor. Los tiempos de cola y prefill no están disponibles en este hook.','fine'));
  }else{pane.append(block('ESTRATEGIA',call.strategy));pane.append(block('CAMBIOS APLICADOS',call.changes?.length?call.changes:'Ninguno. Baseline de observación.'));pane.append(block('HUELLA ANTES / DESPUÉS',{original:call.requestHash,effective:call.sentHash,equal:call.requestHash===call.sentHash}));}
}
function renderRun(){
  $('empty').hidden=true;$('content').hidden=false;$('title').textContent=run.label;$('subtitle').textContent=`${stamp(run.startedAt)} CDMX · ${statusText[run.status]||run.status} · ${run.model||'Kimi K3.1 Pro'}`;
  $('mode').textContent=run.strategy.mode==='baseline'?'OBSERVACIÓN':'EXPERIMENTO';$('export').hidden=false;$('export').href=`/api/runs/${run.id}/export`;
  $('cancel').hidden=!run.runnerManaged||!['queued','running'].includes(run.status);
  const s=run.summary;$('mean').textContent=fmt(s.mean,1);$('p90').textContent=fmt(s.p90,1);$('wall').textContent=seconds(new Date(run.endedAt||Date.now())-new Date(run.startedAt));$('calls-count').textContent=`${s.measuredCalls} / ${s.calls}`;
  $('coverage').textContent=`${s.missingTiming} sin timing · ${s.errors} con error`;
  $('notice').textContent=run.error?`La prueba reportó un error: ${run.error}`:s.errors?`${s.errors} llamada(s) fallaron. La media excluye errores y llamadas sin timing.`:s.missingTiming?'Hay llamadas sin tiempos del servidor. La media tiene cobertura parcial.':'';
  $('prompt').textContent=run.prompt;$('strategy').textContent=JSON.stringify(run.strategy,null,2);$('tokens').textContent=`${fmt(s.inputTokens)} tokens de entrada · ${fmt(s.outputTokens)} de salida · razonamiento: consulta la cobertura en cada llamada · ${run.events.filter(e=>e.type==='after_tool_call').length} herramientas ejecutadas`;
  const buttons=run.calls.map((call,index)=>{
    const b=node('button',null,`call ${call.id===callId?'active':''}`);const top=node('div',null,'call-top');top.append(node('strong',`Llamada ${String(index+1).padStart(2,'0')}`),node('span',`${fmt(call.tps)} TPS`));b.append(top,node('p',`${call.toolCalls?.length?'Tool calls · '+call.toolCalls.length:'Respuesta'} · ${statusText[call.status]||call.status}\n${fmt(call.usage?.prompt_tokens)} in / ${fmt(call.usage?.completion_tokens)} out · ${seconds(call.wallMs)}`));b.onclick=()=>{callId=call.id;renderRun();};return b;
  });$('call-list').replaceChildren(...buttons);if(!run.calls.length)$('call-list').append(node('p','La prueba está preparando el agente.','fine'));renderInspection();
  const events=run.events.filter(e=>['before_tool_call','after_tool_call','agent_end','firecrawl_request'].includes(e.type));$('event-count').textContent=`${events.length} EVENTOS`;
  $('events').replaceChildren(...events.map(e=>{const n=node('details',null,'event');const label=e.type==='firecrawl_request'?`FIRECRAWL ${e.data.kind.toUpperCase()} · ${e.data.phase} · ${e.data.gift} · ${e.data.parallelism} en paralelo`:`${e.type==='before_tool_call'?'INICIO':e.type==='after_tool_call'?'FIN':'AGENTE'} · ${e.data.toolName||e.type}`;n.append(node('summary',`${label} ${e.data.durationMs!=null?'· '+seconds(e.data.durationMs):''}`),pre(e.data));return n;}));
  $('result').textContent=run.finalText||(['queued','running'].includes(run.status)?'El agente está trabajando…':'Sin respuesta final. Revisa las llamadas y los eventos.');
  $('product-links').replaceChildren(...(run.productLinks||[]).map((url,i)=>{const a=node('a',`${i+1}. ${url}`);try{if(!['http:','https:'].includes(new URL(url).protocol))return node('span','Enlace no válido');}catch{return node('span','Enlace no válido');}a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}));
}
async function refresh(){
  if(busy)return;busy=true;
  try{
    const [status,runs]=await Promise.all([api('/api/status'),api('/api/runs')]);$('connection').textContent=status.busy?'Prueba en ejecución':'Gateway conectado';$('form').querySelector('[type=submit]').disabled=status.busy;$('run-count').textContent=runs.length;
    if(!$('form').elements.prompt.value)$('form').elements.prompt.value=status.baselinePrompt;
    if(!selected&&runs.length)selected=runs[0].id;
    $('runs').replaceChildren(...runs.map(r=>{const b=node('button',null,`run-item ${r.id===selected?'active':''}`);b.append(node('strong',r.label),node('span',`${fmt(r.summary.mean)} TPS · ${statusText[r.status]||r.status}`));b.onclick=()=>{selected=r.id;callId=null;lastRender='';history.replaceState(null,'',`?run=${selected}`);void refresh();};return b;}));
    if(selected){const next=await api(`/api/runs/${selected}`);const serialized=JSON.stringify(next);if(serialized!==lastRender){run=next;lastRender=serialized;if(!run.calls.some(c=>c.id===callId))callId=run.calls[0]?.id||null;renderRun();}}
    if(status.unattributedCalls)$('notice').textContent+=` ${status.unattributedCalls} llamada(s) sin correlación, excluidas de las pruebas.`;
  }catch(error){$('connection').textContent='Sin conexión';$('notice').textContent=error.message;}finally{busy=false;}
}
void refresh();setInterval(()=>void refresh(),2000);
