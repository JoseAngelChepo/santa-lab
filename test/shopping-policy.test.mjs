import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../index.mjs';
import {shoppingPromptHook,SHOPPING_SYSTEM,SHOPPING_POLICY,SHOPPING_USER_EXAMPLE} from '../shopping-policy.mjs';

test('shopping strategy uses the system hook and leaves user requests unchanged',()=>{
  const event={prompt:'Find a camera',messages:[]};const original=structuredClone(event);
  assert.deepEqual(shoppingPromptHook(event,{trigger:'user'}),{prependSystemContext:SHOPPING_SYSTEM});assert.deepEqual(event,original);
  assert.ok(!/AirPods|10328|target\.com|129\.99/.test(SHOPPING_SYSTEM));
  assert.ok(!/firecrawl|tool_call|valida|paralelo/i.test(SHOPPING_USER_EXAMPLE));
  assert.equal(SHOPPING_POLICY.sha256.length,64);
  assert.equal(shoppingPromptHook(event,{sessionKey:'agent:main:internal-session-effects:review'}),undefined);
  assert.equal(shoppingPromptHook(event,{trigger:'cron'}),undefined);
});
test('policy is opt-in and registers on the native prompt-build boundary',()=>{
  for(const enabled of [false,true]){
    const hooks=[];plugin.register({pluginConfig:{shoppingMode:enabled},registerTool(){},registerService(){},on(name,fn){hooks.push([name,fn]);}});
    assert.equal(hooks.filter(([name])=>name==='before_prompt_build').length,enabled?1:0);
  }
});
