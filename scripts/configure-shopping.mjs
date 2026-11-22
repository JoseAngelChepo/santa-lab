// Opt-in presentation changes in an isolated shopping profile; model settings stay intact.
import { readFile,writeFile,copyFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const state=path.resolve(process.argv[2]||process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),'.openclaw-santa'));
const mode=process.argv[3]||'lean';
if(!['lean','standard'].includes(mode))throw new Error('Usage: node configure-shopping.mjs STATE_DIR [lean|standard]');
const configPath=path.join(state,'openclaw.json'),config=JSON.parse(await readFile(configPath,'utf8'));
const entry=config.plugins?.entries?.['santa-lab'];if(!entry)throw new Error('Install Santa Lab in this profile first');
const dir=path.join(state,'santa-lab');await mkdir(dir,{recursive:true,mode:0o700});
const savedPath=path.join(dir,'tool-presentation-before-lean.json');
await copyFile(configPath,path.join(state,`openclaw.before-${mode}-${Date.now()}.json`));
config.tools??={};entry.config??={};entry.hooks??={};
if(mode==='lean'){
  try{await readFile(savedPath);}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(savedPath,JSON.stringify({toolSearch:config.tools.toolSearch??null,codeMode:config.tools.codeMode??null}),{mode:0o600});}
  config.tools.toolSearch=false;config.tools.codeMode=false;
  entry.config.shoppingMode=true;entry.config.leanShopping=true;entry.hooks.allowPromptInjection=true;
}else{
  const saved=JSON.parse(await readFile(savedPath,'utf8'));
  for(const field of ['toolSearch','codeMode']){if(saved[field]===null)delete config.tools[field];else config.tools[field]=saved[field];}
  delete entry.config.leanShopping;
}
await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({mode,model:config.agents?.defaults?.model?.primary,thinkingDefault:config.agents?.defaults?.thinkingDefault,toolSearch:config.tools.toolSearch??'inherited',codeMode:config.tools.codeMode??'inherited',note:'Reload santa-lab. Model, credentials and completion parameters were not changed.'}));
