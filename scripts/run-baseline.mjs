import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const [label,outputFile,...options] = process.argv.slice(2);
if(!outputFile)throw new Error('Usage: node run-baseline.mjs LABEL OUTPUT_JSON [--reload] [--prompt-file FILE]');
const promptIndex=options.indexOf('--prompt-file');
if(promptIndex>=0&&!options[promptIndex+1])throw new Error('--prompt-file requires a file');
if(options.includes('--reload')){
  let launcher=process.env.SANTA_LAB_LAUNCHER||fileURLToPath(new URL('../.local/openclaw-launcher.mjs',import.meta.url));
  if(!process.env.SANTA_LAB_LAUNCHER)try{await access(launcher);}catch{launcher=fileURLToPath(new URL('../../santa.sh',import.meta.url));}
  const result=await promisify(execFile)(launcher,['plugins','reload','santa-lab'],{timeout:120000,maxBuffer:1024*1024});
  process.stdout.write(result.stdout);
}
const root='http://127.0.0.1:18891';
const status=await(await fetch(`${root}/api/status`)).json();
const prompt=promptIndex>=0?await readFile(options[promptIndex+1],'utf8'):status.baselinePrompt;
const response=await fetch(`${root}/api/runs`,{method:'POST',headers:{'content-type':'application/json','x-santa-lab':'1'},body:JSON.stringify({label,prompt,strategy:{mode:'baseline'}})});
const run=await response.json();if(!response.ok)throw new Error(JSON.stringify(run));
await writeFile(outputFile,JSON.stringify(run,null,2),{mode:0o600});
console.log(JSON.stringify({id:run.id,sessionId:run.sessionId,startedAt:run.startedAt,promptHash:run.promptHash,strategy:run.strategy}));
