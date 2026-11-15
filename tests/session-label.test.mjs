import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionLabel } from '../src/session-label.mjs';
import { CodexWorker } from '../src/codex-worker.mjs';
test('session labels identify task, role and attempt while orchestrators keep a stable name',()=>{
  assert.equal(sessionLabel({project:'app',taskId:'app#2',agent:'codex',mode:'implementation',id:'12345678-xxxx'}),'Kanzo app#2 · implementation · 12345678');
  assert.equal(sessionLabel({project:'app',agent:'codex',mode:'notification',id:'x'}),'Kanzo app · orchestrator (codex)');
});
test('a naming failure never repeats a sent Codex turn and is repaired during polling',async()=>{
  const w=new CodexWorker();let turns=0,names=0;w.rpc={attention:new Map(),async call(method){if(method==='turn/start'){turns++;return {turn:{id:'t1'}};}if(method==='thread/name/set'){if(++names===1)throw Error('not yet materialized');return {};}return {data:[]};}};
  const job={id:'12345678-xxxx',project:'app',taskId:'app#2',agent:'codex',mode:'implementation',workspace:'D:/Projects/app',sessionId:'s1',newSession:true};
  Object.assign(job,await w.send(job,'task'));assert.equal(turns,1);assert.equal(job.turnId,'t1');assert.equal(job.sessionTitlePending,true);
  await w.inspect(job);assert.equal(job.sessionTitlePending,false);assert.equal(names,2);assert.equal(turns,1);
});
