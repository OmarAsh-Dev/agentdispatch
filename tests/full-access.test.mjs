import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexWorker } from '../src/codex-worker.mjs';
import { ScopedOpenCodeApi, Workers } from '../src/workers.mjs';
import { OpenCodeApi } from '../src/adapters.mjs';
import { promptFor } from '../src/prompts.mjs';
import { openCodeRuntime } from '../src/opencode-config.mjs';
test('full-account OpenCode allows all native tools for every worker role',()=>{
  const api=new ScopedOpenCodeApi({url:'http://127.0.0.1:4096',workspace:'D:/Projects/app',model:{},accessMode:'full'});
  for(const mode of ['implementation','discussion'])assert.deepEqual(api.permissionRules(mode),[{permission:'*',pattern:'*',action:'allow'}]);
});
test('full-account Codex uses full access without command prompts for implementation and review',async()=>{
  const worker=new CodexWorker({accessMode:'full'});const calls=[];
  worker.rpc={async call(method,p){calls.push({method,p});if(method==='thread/start')return {thread:{id:'s1'}};throw Error('Full access does not provision a file sandbox');}};
  for(const mode of ['implementation','review','readiness'])await worker.prepare({workspace:'D:/Projects/app',mode,readScopes:['src/**'],editScopes:['src/**']});
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.p.sandbox==='danger-full-access'&&c.p.approvalPolicy==='never'));
});
test('passwordless OpenCode requests omit Authorization without exposing the bridge MCP token',async()=>{
  let headers;const api=new OpenCodeApi({url:'http://127.0.0.1:4096',workspace:'D:/Projects/app',password:null,fetchFn:async(_url,opts)=>{headers=opts.headers;return Response.json({ok:true});}});
  await api.request('/global/health');assert.equal(headers.authorization,undefined);
});
test('full-account Workers passes its policy to each new OpenCode session',async()=>{
  const workers=new Workers({runtime:{openCodeUrl:'http://127.0.0.1:4096'},model:{},accessMode:'full'});
  assert.deepEqual(workers.api({workspace:'D:/Projects/app'}).permissionRules('implementation'),[{permission:'*',pattern:'*',action:'allow'}]);
});
test('passwordless launch configuration is explicit, loopback-only and preserves the MCP token',()=>{
  const before={openCodeUrl:'http://127.0.0.1:4096',openCodePassword:'old',bridgeToken:'keep'};
  assert.deepEqual(openCodeRuntime(before,{openCodeAuth:'none'}),{...before,openCodePassword:null});
  assert.equal(before.openCodePassword,'old');assert.equal(openCodeRuntime(before,{}).openCodePassword,'old');
  assert.throws(()=>openCodeRuntime({...before,openCodeUrl:'http://192.168.1.32:4096'},{openCodeAuth:'none'}),/loopback/i);
  assert.throws(()=>openCodeRuntime(before,{openCodeAuth:'typo'}),/auth/i);
});
test('full-access job prompts retain review duties without contradicting the account access grant',()=>{
  const text=promptFor({id:'job1',agent:'codex',project:'app',workspace:'D:/Projects/app',mode:'review',accessMode:'full'},{});
  assert.match(text,/full Windows.account access/i);assert.match(text,/Do not edit source/);
  assert.doesNotMatch(text,/Never read credential stores/);assert.match(promptFor({mode:'review'},{}),/Never read credential stores/);
});
