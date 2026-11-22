import { readFileSync } from 'node:fs';
import { digest } from './metrics.mjs';

export const SHOPPING_SYSTEM = readFileSync(new URL('./prompts/shopping-system.txt',import.meta.url),'utf8').trim();
export const SHOPPING_POLICY = Object.freeze({id:'efficient-price-v1',placement:'prependSystemContext',sha256:digest(SHOPPING_SYSTEM)});
export const SHOPPING_USER_EXAMPLE = readFileSync(new URL('./prompts/five-wishes-user.txt',import.meta.url),'utf8').trim();

export function shoppingPromptHook(_event,ctx={}){
  if(ctx.trigger==='cron'||ctx.sessionKey?.includes(':cron:')||ctx.sessionKey?.includes(':internal-session-effects:'))return;
  return {prependSystemContext:SHOPPING_SYSTEM};
}
