import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { KanzoHttp } from '../src/kanzo-http.mjs';
import { CodexRpc, CodexWorker } from '../src/codex-worker.mjs';
import { ScopedOpenCodeApi, Workers } from '../src/workers.mjs';
import { hash } from '../src/policy.mjs';
test('Codex notifications queue to their existing writer and wait for an exact completed acknowledgment',async()=>{
  const codex=new CodexWorker();let completed=false,delivered=false;const methods=[];
  codex.rpc={async call(method){methods.push(method);if(method==='thread/turns/list')return {data:[{id:'existing-turn',status:completed?'completed':'inProgress'}]};if(method==='thread/items/list')return {data:[{item:{type:'userMessage',content:[{type:'text',text:delivered?'Request: notification-1.':'unrelated earlier request'}]}},{item:{type:'agentMessage',phase:'final_answer',text:'Acknowledged'}}],nextCursor:null};throw Error('Must not take over the writer');}};
  const job={id:'notification-1',agent:'codex',workspace:'D:/Projects/app',mode:'notification',sessionId:'existing'};
  Object.assign(job,await codex.prepare(job));assert.equal(job.notificationViaQueue,true);assert.ok(!methods.includes('thread/resume'));
  const w=new Workers({runtime:{},model:{},codex});let sends=0;w.notifyCoordinator=async(id,prompt)=>{assert.equal(id,'existing');assert.match(prompt,/notification-1/);sends++;return {queued:true,wakeConfirmed:false};};
  Object.assign(job,await w.send(job,'Request: notification-1. Progress only.'));assert.equal(sends,1);assert.equal(job.queueDelivery.queued,true);
  completed=true;assert.equal((await w.inspect(job)).status,'running');
  delivered=true;completed=false;assert.equal((await w.inspect(job)).status,'running');
  completed=true;assert.equal((await w.inspect(job)).text,'Acknowledged');assert.equal((await w.inspect(job)).status,'completed');
});
test('a Codex orchestrator owned by this connection receives direct notification turns',async()=>{
  const w=new CodexWorker();const methods=[];w.rpc={async call(method){methods.push(method);if(method==='thread/start')return {thread:{id:'owned'}};if(method==='thread/turns/list')return {data:[{id:'old',status:'completed'}]};throw Error('Do not resume a writer already owned here');}};
  await w.prepare({workspace:'D:/Projects/app',mode:'notification'});
  const prepared=await w.prepare({workspace:'D:/Projects/app',mode:'notification',sessionId:'owned'});
  assert.equal(prepared.notificationViaQueue,undefined);assert.deepEqual(prepared.baseline,['old']);assert.ok(!methods.includes('thread/resume'));
});
test('queued acknowledgment recovery searches older turn and item pages without resending',async()=>{
  const w=new CodexWorker();const calls=[];w.rpc={async call(method,p){calls.push({method,p});
    if(method==='thread/turns/list')return p.cursor?{data:[{id:'older',status:'completed'}],nextCursor:null}:{data:[{id:'newer',status:'completed'}],nextCursor:'older-turns'};
    if(p.turnId==='newer')return {data:[],nextCursor:null};
    return p.cursor?{data:[{item:{type:'agentMessage',phase:'final_answer',text:'Recovered acknowledgment'}}],nextCursor:null}:{data:[{item:{type:'userMessage',content:[{type:'text',text:'Request: n-old.'}]}}],nextCursor:'later-items'};
  }};
  assert.equal((await w.inspect({id:'n-old',sessionId:'s1',notificationViaQueue:true})).text,'Recovered acknowledgment');
  assert.ok(calls.some(c=>c.p.cursor==='older-turns'));assert.ok(calls.some(c=>c.p.cursor==='later-items'));
});
test('a foreign-writer interrupted history snapshot is not notification failure or permission to resend',async()=>{
  const w=new CodexWorker();let status='interrupted';w.rpc={async call(method){return method==='thread/turns/list'?{data:[{id:'t1',status}]}:{data:[{item:{type:'userMessage',content:[{type:'text',text:'Request: n1.'}]}},{item:{type:'agentMessage',phase:'final_answer',text:'Ack'}}]};}};
  const job={id:'n1',sessionId:'foreign',notificationViaQueue:true};
  assert.equal((await w.inspect(job)).status,'running');status='completed';assert.equal((await w.inspect(job)).status,'completed');
});
test('Codex one-time approval binds exact live request and rejects stale, foreign and repeated replies',async()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const sent=[];child.stdin.on('data',v=>sent.push(JSON.parse(v.toString())));
  const w=new CodexWorker();w.rpc=new CodexRpc(child);
  const request={id:0,method:'mcpServer/elicitation/request',params:{threadId:'s1',turnId:'t1',mode:'form',_meta:{codex_approval_kind:'mcp_tool_call'},requestedSchema:{type:'object',properties:{}}}};
  w.rpc.receive(request);
  const job={sessionId:'s1',turnId:'t1'};
  await assert.rejects(w.replyApproval({...job,sessionId:'other'},0,hash(request),'approve_once'),/pending|request/i);
  await assert.rejects(w.replyApproval(job,0,'0'.repeat(64),'approve_once'),/changed|fingerprint/i);
  await assert.rejects(w.replyApproval({...job,turnId:'other'},0,hash(request),'approve_once'),/turn/i);
  request.params.turnId=null;await assert.rejects(w.replyApproval(job,0,hash(request),'approve_once'),/turn/i);request.params.turnId='t1';
  await assert.rejects(w.replyApproval(job,0,hash(request),'acceptForSession'),/decision/i);
  assert.equal(sent.length,0);
  await w.replyApproval(job,0,hash(request),'approve_once');
  assert.deepEqual(sent,[{id:0,result:{action:'accept',content:{}}}]);
  assert.equal(w.rpc.attention.get('s1').length,0);
  await assert.rejects(w.replyApproval(job,0,hash(request),'approve_once'),/pending|request/i);
  await w.rpc.close();
});
test('Codex approval relay refuses nonempty MCP forms and supports only one-time command/file decisions',async()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const sent=[];child.stdin.on('data',v=>sent.push(JSON.parse(v.toString())));
  const w=new CodexWorker();w.rpc=new CodexRpc(child);const job={sessionId:'s1',turnId:'t1'};
  const form={id:1,method:'mcpServer/elicitation/request',params:{threadId:'s1',turnId:'t1',mode:'form',_meta:{codex_approval_kind:'mcp_tool_call'},requestedSchema:{type:'object',properties:{secret:{type:'string'}}}}};
  w.rpc.receive(form);await assert.rejects(w.replyApproval(job,1,hash(form),'approve_once'),/unsupported|form/i);assert.equal(sent.length,0);
  for(const [id,method,decision] of [[2,'item/commandExecution/requestApproval','approve_once'],[3,'item/fileChange/requestApproval','decline']]){
    const request={id,method,params:{threadId:'s1',turnId:'t1'}};w.rpc.receive(request);await w.replyApproval(job,id,hash(request),decision);
  }
  assert.deepEqual(sent,[{id:2,result:{decision:'accept'}},{id:3,result:{decision:'decline'}}]);
  w.rpc.receive({method:'serverRequest/resolved',params:{threadId:'s1',requestId:1}});
  assert.deepEqual(w.rpc.attention.get('s1'),[]);await w.rpc.close();
});
test('Codex never repeats a native reply after an uncertain stdin write',async()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  let writes=0;child.stdin.write=(_raw,callback)=>{writes++;callback(Error('uncertain write'));};
  const w=new CodexWorker();w.rpc=new CodexRpc(child);
  const request={id:0,method:'item/fileChange/requestApproval',params:{threadId:'s1',turnId:'t1'}};w.rpc.receive(request);
  const job={sessionId:'s1',turnId:'t1'};
  await assert.rejects(w.replyApproval(job,0,hash(request),'approve_once'),/uncertain/);
  await assert.rejects(w.replyApproval(job,0,hash(request),'approve_once'),/already/);assert.equal(writes,1);await w.rpc.close();
});
test('Kanzo uses structured shared-board API, validates slugs and scopes updates',async()=>{
  const calls=[];
  const board=new KanzoHttp('http://localhost:4242/#all',async(url,opts)=>{
    calls.push({url,opts});
    return Response.json(url.includes('/board')?{projects:[],tasks:[{id:2,project:'app',title:'x',description:'',tags:[],status:'todo',human:false}]}:{task:{id:2,project:'app',title:'x',description:'',tags:[],status:'todo',human:false},comments:[],waits_on:[]});
  });
  assert.equal((await board.snapshot()).tasks.length,1);
  assert.equal((await board.get('app#2')).id,2);
  await board.update('app#2',{status:'review',tags:['owner:codex']});
  assert.ok(calls.some(c=>c.opts?.method==='PATCH' && JSON.parse(c.opts.body).tags==='owner:codex'));
  await assert.rejects(board.get('other#2'),/project/);
  assert.throws(()=>new KanzoHttp('http://evil.com:4242'),/loopback/);
});
test('Codex RPC handles replies and records permission requests without approving them',async()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const requests=[];
  child.stdin.on('data',raw=>{for(const l of raw.toString().trim().split('\n')){const m=JSON.parse(l);requests.push(m);if(m.id&&m.method)child.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\n');}});
  const rpc=new CodexRpc(child);assert.deepEqual(await rpc.call('initialize',{}),{ok:true});
  child.stdout.write(JSON.stringify({id:40,method:'item/commandExecution/requestApproval',params:{threadId:'s1'}})+'\n');
  await new Promise(r=>setImmediate(r));
  assert.equal(rpc.attention.get('s1')[0].method,'item/commandExecution/requestApproval');
  assert.ok(!requests.some(m=>m.id===40));rpc.close();
});
test('Codex reads actual paginated item envelopes',async()=>{
  const w=new CodexWorker();w.rpc={attention:new Map(),async call(method){return method==='thread/turns/list'?{data:[{id:'t1',status:'completed'}]}:{data:[{turnId:'t1',item:{type:'agentMessage',text:'actual result'}}],nextCursor:null};}};
  assert.equal((await w.inspect({sessionId:'s1',turnId:'t1'})).text,'actual result');
});
test('OpenCode global scopes are explicit and read-only roles cannot edit or shell',()=>{
  const api=new ScopedOpenCodeApi({url:'http://127.0.0.1:4096',password:'x',workspace:'D:/Projects/Example',model:{providerID:'p',modelID:'m'},readScopes:['src/**'],editScopes:['src/**']});
  const rules=api.permissionRules('implementation');
  assert.ok(rules.some(r=>r.permission==='edit'&&r.pattern==='src/**'&&r.action==='allow'));
  assert.ok(!rules.some(r=>r.action==='allow'&&r.pattern.includes('dashboard')));
  assert.ok(api.permissionRules('discussion').some(r=>r.permission==='bash'&&r.action==='deny'));
  assert.ok(!api.permissionRules('discussion').some(r=>r.permission==='edit'&&r.action==='allow'));
});
test('new Codex threads have no history until first user message',async()=>{
  const w=new CodexWorker();w.rpc={async call(method){if(method==='thread/start')return {thread:{id:'new'}};throw Error('thread is not materialized yet');}};
  assert.deepEqual(await w.prepare({workspace:'D:/Projects/app',mode:'discussion'}),{sessionId:'new',baseline:[],newSession:true});
});
test('Codex tolerates the storage materialization race without resending a turn',async()=>{
  const w=new CodexWorker();w.rpc={attention:new Map(),async call(){throw Error('rollout at path is empty');}};
  assert.equal((await w.inspect({sessionId:'fresh',turnId:'t1'})).status,'running');
});
test('unknown Codex send cannot be declared cancelled without resolving its turn',async()=>{
  const w=new CodexWorker();let calls=0;w.rpc={async call(){calls++;return {data:[]};}};
  await assert.rejects(w.cancel({id:'unknown',sessionId:'s1',baseline:[]}),/resolve|unknown|identify/i);assert.ok(calls>0);
});
test('Codex rejects narrow scopes its installed protocol cannot enforce',async()=>{
  const w=new CodexWorker();w.rpc={async call(){return {thread:{id:'new'}};}};
  await assert.rejects(w.prepare({workspace:'D:/Projects/app',mode:'discussion',readScopes:['src/**'],editScopes:['src/**']}),/scope/i);
});
test('reused OpenCode sessions refresh their role permissions before any send',async()=>{
  const w=new Workers({runtime:{},model:{}});let refreshed=false;w.api=()=>({async health(){},async refreshPermissions(id,mode){assert.equal(id,'existing');assert.equal(mode,'discussion');refreshed=true;},async inspect(){return {messages:[],pending:[],busy:false};}});
  await w.prepare({agent:'opencode',sessionId:'existing',mode:'planning'});assert.ok(refreshed);
});
test('Codex shutdown allows native writer cleanup before forced termination',async()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;let killed=false;child.kill=()=>{killed=true;};
  child.stdin.on('finish',()=>setImmediate(()=>{child.exitCode=0;child.emit('exit',0);}));
  const rpc=new CodexRpc(child);await rpc.close();assert.equal(killed,false);
});
