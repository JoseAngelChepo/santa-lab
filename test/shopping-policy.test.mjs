import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../index.mjs';
import {shoppingPromptHook,leanShoppingPromptHook,SHOPPING_SYSTEM,SHOPPING_POLICY,SHOPPING_USER_EXAMPLE,LEAN_SHOPPING_SYSTEM,SHOPPING_TOOLS} from '../shopping-policy.mjs';

test('shopping strategy uses the system hook and leaves user requests unchanged',()=>{
  const event={prompt:'Find a camera',messages:[]};const original=structuredClone(event);
  assert.deepEqual(shoppingPromptHook(event,{trigger:'user'}),{prependSystemContext:SHOPPING_SYSTEM});assert.deepEqual(event,original);
  assert.ok(!/AirPods|10328|target\.com|129\.99/.test(SHOPPING_SYSTEM));
  assert.ok(!/firecrawl|tool_call|valida|paralelo/i.test(SHOPPING_USER_EXAMPLE));
  assert.equal(SHOPPING_POLICY.sha256.length,64);
  assert.equal(shoppingPromptHook(event,{sessionKey:'agent:main:internal-session-effects:review'}),undefined);
  assert.equal(shoppingPromptHook(event,{trigger:'cron'}),undefined);
});
test('lean mode replaces irrelevant system context, narrows tools and preserves the user input',()=>{
  const event={prompt:'Find a manual coffee grinder',messages:[]};const original=structuredClone(event);
  assert.deepEqual(leanShoppingPromptHook(event,{trigger:'user'}),{systemPrompt:LEAN_SHOPPING_SYSTEM,toolsAllow:[...SHOPPING_TOOLS]});
  assert.deepEqual(event,original);assert.ok(LEAN_SHOPPING_SYSTEM.length<1800);
  assert.ok(!/AirPods|Hydro Flask|Shopify|Quick status check/.test(LEAN_SHOPPING_SYSTEM));
  assert.equal(leanShoppingPromptHook(event,{trigger:'heartbeat'}),undefined);
  const hooks=[];plugin.register({pluginConfig:{shoppingMode:true,leanShopping:true},registerTool(){},registerService(){},on(name,fn){hooks.push([name,fn]);}});
  assert.equal(hooks.find(([name])=>name==='before_prompt_build')[1],leanShoppingPromptHook);
});
test('policy is opt-in and registers on the native prompt-build boundary',()=>{
  for(const enabled of [false,true]){
    const hooks=[];plugin.register({pluginConfig:{shoppingMode:enabled},registerTool(){},registerService(){},on(name,fn){hooks.push([name,fn]);}});
    assert.equal(hooks.filter(([name])=>name==='before_prompt_build').length,enabled?1:0);
  }
});
