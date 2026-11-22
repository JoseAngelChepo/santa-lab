import path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { loadEnvFile } from 'node:process';
import { Lab } from './lab.mjs';
import { firecrawlTools } from './firecrawl.mjs';
import { shoppingPromptHook,SHOPPING_POLICY,SHOPPING_USER_EXAMPLE } from './shopping-policy.mjs';

export default {
  id:'santa-lab',name:'Santa Lab',description:'Transparent per-call Cerebras tracking and explicit strategies.',
  register(api){
    let lab;
    const cfg=api.pluginConfig||{};
    if(cfg.shoppingMode===true)api.on('before_prompt_build',shoppingPromptHook);
    const transport=channel('santa-lab.provider.v1');
    const capture=event=>lab?.capture(event);
    for(const tool of firecrawlTools({record:event=>lab?.network(event)}))api.registerTool(tool);
    for(const type of ['llm_input','llm_output','model_call_started','model_call_ended','before_tool_call','after_tool_call','agent_end']){
      api.on(type,(event,ctx)=>{lab?.event(type,event,ctx);});
    }
    api.registerService({
      id:'santa-lab',apiVersion:2,
      async start(ctx){
        try{loadEnvFile(path.join(ctx.stateDir,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
        lab=new Lab({port:cfg.port||18891,dataDir:cfg.dataDir||path.join(ctx.stateDir,'santa-lab'),launcher:cfg.launcher,logger:ctx.logger,...(cfg.shoppingMode===true?{promptPolicy:SHOPPING_POLICY,defaultPrompt:SHOPPING_USER_EXAMPLE}:{})});
        await lab.start();
        transport.subscribe(capture);
      },
      async stop(){transport.unsubscribe(capture);await lab?.stop();lab=undefined;}
    });
  }
};
