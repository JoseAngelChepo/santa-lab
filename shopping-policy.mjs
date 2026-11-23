import { readFileSync } from 'node:fs';
import { digest } from './metrics.mjs';

export const SHOPPING_SYSTEM = readFileSync(new URL('./prompts/shopping-system.txt',import.meta.url),'utf8').trim();
export const SHOPPING_POLICY = Object.freeze({id:'efficient-price-v1',placement:'prependSystemContext',sha256:digest(SHOPPING_SYSTEM)});
export const SHOPPING_USER_EXAMPLE = readFileSync(new URL('./prompts/five-wishes-user.txt',import.meta.url),'utf8').trim();
export const LEAN_SHOPPING_SYSTEM = readFileSync(new URL('./prompts/shopping-system-lean.txt',import.meta.url),'utf8').trim();
export const SHOPPING_TOOLS = Object.freeze(['firecrawl_search_batch','firecrawl_scrape_batch']);
export const LEAN_SHOPPING_POLICY = Object.freeze({id:'lean-shopping-v2.8-one-pass-validation',placement:'systemPrompt',sha256:digest(LEAN_SHOPPING_SYSTEM),tools:SHOPPING_TOOLS,delivery:'compact-price-evidence-v2.4'});

export function shoppingPromptHook(_event,ctx={}){
  if(ctx.trigger==='cron'||ctx.sessionKey?.includes(':cron:')||ctx.sessionKey?.includes(':internal-session-effects:'))return;
  return {prependSystemContext:SHOPPING_SYSTEM};
}

export function leanShoppingPromptHook(_event,ctx={}){
  if(ctx.trigger==='cron'||ctx.trigger==='heartbeat'||ctx.sessionKey?.includes(':cron:')||ctx.sessionKey?.includes(':internal-session-effects:'))return;
  return {systemPrompt:LEAN_SHOPPING_SYSTEM,toolsAllow:[...SHOPPING_TOOLS]};
}
