import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, Registry } from '../src/registry.mjs';
import { Controller } from '../src/controller.mjs';
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'bridge-controller-'));
  const registry=new Registry(new FileStore(join(dir,'registry.json'),{projects:{}}));await registry.init();
  await registry.start({project:'app',workspace:dir,agent:'codex'});
  const tasks=[{id:1,project:'app',title:'Implement widget',description:'Acceptance: widget renders',tags:['owner:opencode'],status:'todo',human:false}];
  const comments=[];let next=2;
  const board={async snapshot(){return {projects:[{slug:'app'}],tasks:structuredClone(tasks)};},async get(id){const t=tasks.find(t=>`${t.project}#${t.id}`===id);if(!t)throw Error('Missing task');return structuredClone(t);},async update(id,p){const t=tasks.find(t=>`${t.project}#${t.id}`===id);Object.assign(t,structuredClone(p));return t;},async comment(id,body,marker){if(!comments.some(c=>c.marker===marker))comments.push({id,body,marker});},async ensureProject(){},async create(project,title,description){const t={id:next++,project,title,description,tags:[],status:'todo',human:false};tasks.push(t);return structuredClone(t);}};
  const results=new Map(),sent=[];
  const workers={async prepare(job){return {sessionId:job.sessionId||`ses-${job.id}`,baseline:[]};},async send(job,prompt){sent.push({...structuredClone(job),prompt});return {turnId:`turn-${job.id}`};},async inspect(job){return results.get(job.id)||{status:'running'};},async cancel(job){results.set(job.id,{status:'cancelled'});}};
  const store=new FileStore(join(dir,'controller.json'));
  let content='version1';
  const controller=new Controller({registry,store,board,workers,fingerprint:async()=>content});await controller.init();
  return {controller,registry,store,board,workers,tasks,results,sent,comments,content(v){content=v;},finish(mode,result){const job=[...controller.state.jobs].reverse().find(j=>j.mode===mode&&['running','unknown'].includes(j.status));assert.ok(job,`no active ${mode}`);results.set(job.id,{status:'completed',text:JSON.stringify(result)});return job;}};
}
const checks=[{command:'node --test',passed:true,details:'1 test passed'}];
test('optional diagnostic failures do not veto passing required review checks',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  f.finish('implementation',{completed:true,summary:'done',changedFiles:[],checks,needsHumanReview:false});await f.controller.tick();
  f.finish('review',{accepted:true,needsHumanReview:false,summary:'exact artifact verified through supported fallback',checks:[...checks,{command:'optional unavailable diagnostic',passed:false,required:false,details:'Required verification passed through supported command'}],findings:[]});await f.controller.tick();
  assert.ok(f.controller.state.acceptance['app#1']);assert.ok(!f.controller.state.jobs.some(j=>j.reworkOf));
});
test('review acceptance requires a passing required check, with omitted required defaulting true',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  f.finish('implementation',{completed:true,summary:'done',changedFiles:[],checks,needsHumanReview:false});await f.controller.tick();
  f.finish('review',{accepted:true,needsHumanReview:false,summary:'optional check only',checks:[{...checks[0],required:false}],findings:[]});await f.controller.tick();
  assert.ok(!f.controller.state.acceptance['app#1']);
});
test('cancelling a failed preparation never interrupts a session the job did not prepare',async()=>{
  const f=await fixture();f.workers.prepare=async()=>{throw Error('existing session has active writer');};
  await f.controller.launch(f.registry.get('app'),'notification',{message:'progress'},{sessionId:'someone-else'});
  f.workers.cancel=async()=>{throw Error('must not interrupt an unowned turn');};
  const job=f.controller.state.jobs.at(-1);assert.equal(job.status,'needs_attention');
  await f.controller.cancel(job.id);assert.equal(job.status,'cancelled');
});
test('retry reconciles an already queued notification without sending another copy',async()=>{
  const f=await fixture();const job={id:'queued-job',project:'app',workspace:f.registry.get('app').workspace,agent:'codex',mode:'notification',status:'failed',prepared:true,sessionId:'existing',revision:1,notificationKey:'event1',notificationViaQueue:true,queueDelivery:{queued:true}};
  f.controller.state.jobs.push(job);f.controller.state.outbox.push({key:'event1',project:'app',message:'Progress',delivered:false,attempts:3});
  await f.controller.retryNotification({key:'event1'});assert.equal(job.status,'running');assert.equal(f.controller.state.outbox[0].jobId,job.id);assert.equal(f.sent.length,0);
  f.results.set(job.id,{status:'completed',text:'Ack'});await f.controller.tick();assert.equal(f.controller.state.outbox[0].delivered,true);assert.equal(f.sent.filter(j=>j.mode==='notification').length,0);
});
test('startup reconciliation restores a recorded queued notification before automatic scheduling',async()=>{
  const f=await fixture();f.tasks.length=0;
  f.controller.state.jobs.push({id:'older-queued-job',project:'app',workspace:f.registry.get('app').workspace,agent:'codex',mode:'notification',status:'failed',prepared:true,sessionId:'existing',revision:1,notificationKey:'event-old',notificationViaQueue:true,queueDelivery:{queued:true}});
  f.controller.state.outbox.push({key:'event-old',project:'app',message:'Progress',delivered:false,attempts:1,nextAttemptAt:0});await f.controller.save();
  const restored=new Controller({registry:f.registry,store:f.store,board:f.board,workers:f.workers});await restored.init();await restored.tick();
  assert.equal(f.sent.length,0);assert.equal(restored.state.outbox[0].jobId,'older-queued-job');assert.equal(restored.state.jobs[0].status,'running');
  f.results.set('older-queued-job',{status:'completed',text:'Ack'});await restored.tick();assert.equal(restored.state.outbox[0].delivered,true);assert.equal(f.sent.length,0);
});
test('only explicit duplicate-risk confirmation permits a fresh notification attempt',async()=>{
  const f=await fixture();f.tasks.length=0;
  f.controller.state.jobs.push({id:'old-queued',project:'app',mode:'notification',status:'failed',notificationKey:'event1',notificationViaQueue:true,queueDelivery:{queued:true}});
  f.controller.state.outbox.push({key:'event1',project:'app',message:'Progress',delivered:false});
  await f.controller.retryNotification({key:'event1',confirm_unknown:true});await f.controller.tick();
  assert.equal(f.sent.filter(j=>j.mode==='notification').length,1);assert.equal(f.controller.state.outbox[0].resendConfirmed,false);
});
test('explicit approval is persisted once, refuses stale tasks and resumes attention jobs',async()=>{
  const f=await fixture();f.tasks[0].tags=['owner:codex'];await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  const job=f.controller.state.jobs.find(j=>j.mode==='implementation');job.status='needs_attention';job.pausedForAttention=true;f.tasks[0].status='review';
  let replies=0;f.workers.replyApproval=async()=>{replies++;const saved=await f.store.load();assert.equal(saved.jobs.find(j=>j.id===job.id).approvalReplies[0].status,'sending');};
  const input={job_id:job.id,request_id:0,request_fingerprint:'a'.repeat(64),decision:'approve_once',user_confirmed:true};
  await assert.rejects(f.controller.replyApproval({...input,user_confirmed:false}),/user/i);
  f.tasks[0].title='changed';await assert.rejects(f.controller.replyApproval(input),/changed/i);f.tasks[0].title='Implement widget';
  await f.controller.replyApproval(input);assert.equal(replies,1);assert.equal(job.status,'running');assert.equal(job.approvalReplies[0].status,'sent');
  await assert.rejects(f.controller.replyApproval(input),/already|attention/i);assert.equal(replies,1);
});
test('resumed worker clears stale attention and distinct permission requests get separate board reports',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  const job=f.controller.state.jobs.find(j=>j.mode==='implementation');
  f.results.set(job.id,{status:'needs_attention',pending:[{id:'one'}]});await f.controller.tick();
  f.results.set(job.id,{status:'needs_attention',pending:[{id:'two'}]});await f.controller.tick();
  assert.equal(f.comments.filter(c=>c.body.startsWith('Worker needs attention')).length,2);
  f.results.set(job.id,{status:'running'});await f.controller.tick();assert.equal(job.status,'running');assert.deepEqual(job.pending,[]);
});
test('readiness approval can resume a Todo task and an uncertain reply is never resent',async()=>{
  const f=await fixture();await f.controller.tick();const job=f.controller.state.jobs.find(j=>j.mode==='readiness');job.status='needs_attention';
  let replies=0;f.workers.replyApproval=async()=>{replies++;throw Error('write outcome uncertain');};
  const input={job_id:job.id,request_id:0,request_fingerprint:'b'.repeat(64),decision:'approve_once',user_confirmed:true};
  await assert.rejects(f.controller.replyApproval(input),/uncertain/);assert.equal(replies,1);assert.equal(job.approvalReplies[0].status,'unknown');
  await assert.rejects(f.controller.replyApproval(input),/already/);assert.equal(replies,1);assert.equal(f.tasks[0].status,'todo');
  const restored=new Controller({registry:f.registry,store:f.store,board:f.board,workers:f.workers});await restored.init();
  await assert.rejects(restored.replyApproval(input),/already/);assert.equal(replies,1);
});
test('listener does readiness then implementation, review and dependent dispatch without Done',async()=>{
  const f=await fixture();await f.controller.tick();assert.equal(f.sent[0].mode,'readiness');
  f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  assert.equal(f.tasks[0].status,'doing');assert.ok(f.sent.some(j=>j.mode==='implementation'));
  f.finish('implementation',{completed:true,summary:'Implemented',changedFiles:['widget.js'],checks,needsHumanReview:false});await f.controller.tick();
  assert.equal(f.tasks[0].status,'review');assert.ok(f.sent.some(j=>j.mode==='review'));
  f.finish('review',{accepted:true,needsHumanReview:false,summary:'Verified diff',checks,findings:[]});await f.controller.tick();
  assert.ok(f.controller.state.acceptance['app#1']);
  f.tasks.push({...f.tasks[0],id:2,title:'Dependent',description:'Dependencies: app#1\nAcceptance: consumes widget',status:'todo'});
  await f.controller.tick();assert.ok(f.sent.some(j=>j.taskId==='app#2'&&j.mode==='readiness'));
  assert.ok(!f.tasks.some(t=>t.status==='done'));
});
test('an implementer request for human review does not skip independent technical review',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  f.finish('implementation',{completed:true,summary:'Needs acceptance',changedFiles:[],checks,needsHumanReview:true});await f.controller.tick();
  assert.equal(f.sent.filter(j=>j.mode==='review').length,1);
  f.finish('review',{accepted:true,needsHumanReview:false,summary:'Technically verified',checks,findings:[]});await f.controller.tick();
  assert.ok(f.controller.state.acceptance['app#1']);
  assert.equal(f.tasks[0].status,'review');
});
test('a review:human card receives technical review but dependencies wait for Done',async()=>{
  const f=await fixture();f.tasks[0].tags.push('review:human');
  f.tasks.push({...f.tasks[0],id:2,title:'Dependent',description:'Dependencies: app#1',tags:['owner:codex']});
  await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  f.finish('implementation',{completed:true,summary:'Ready for approval',changedFiles:[],checks,needsHumanReview:true});await f.controller.tick();
  assert.equal(f.sent.filter(j=>j.mode==='review').length,1);
  f.finish('review',{accepted:true,needsHumanReview:false,summary:'Technically verified',checks,findings:[]});await f.controller.tick();
  assert.ok(!f.controller.state.acceptance['app#1']);
  assert.match(f.comments.find(c=>c.marker.startsWith('review-')).body,/human approval/i);
  assert.ok(!f.sent.some(j=>j.taskId==='app#2'));
  f.tasks[0].status='done';
  await f.controller.tick();
  assert.ok(f.sent.some(j=>j.taskId==='app#2'&&j.mode==='readiness'));
});
test('a partial implementation is reviewed and the reviewer can still require human input',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  f.finish('implementation',{completed:false,summary:'One check requires credentials',changedFiles:[],checks,needsHumanReview:true});await f.controller.tick();
  f.finish('review',{accepted:false,needsHumanReview:true,summary:'Waiting for credentials',checks,findings:[]});await f.controller.tick();
  assert.ok(!f.controller.state.acceptance['app#1']);
  assert.match(f.comments.find(c=>c.marker.startsWith('review-')).body,/human input is required/i);
  assert.equal(f.tasks[0].status,'review');
});
test('restart and ambiguous sends never launch a second implementation',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});
  f.workers.send=async(job)=>{f.sent.push({...job});throw Error('timeout after send');};await f.controller.tick();
  const count=f.sent.filter(j=>j.mode==='implementation').length;
  const restored=new Controller({registry:f.registry,store:f.store,board:f.board,workers:f.workers,fingerprint:async()=>'version1'});await restored.init();await restored.tick();await restored.tick();
  assert.equal(f.sent.filter(j=>j.mode==='implementation').length,count);assert.equal(count,1);
});
test('changed ownership stops a running implementation and preserves user status',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  f.tasks[0].tags=['owner:codex'];f.tasks[0].status='review';await f.controller.tick();
  assert.ok(f.controller.state.jobs.some(j=>j.mode==='implementation'&&j.status==='cancelled'));assert.equal(f.tasks[0].status,'review');
});
test('goal plan publishes once with complete dependencies and explicit owners',async()=>{
  const f=await fixture();f.tasks.length=0;
  const goal=await f.controller.submitGoal({project:'app',goal:'Build a widget and its consumer',request_id:'goal1'});
  await f.controller.tick();
  f.finish('planning',{summary:'Two tasks',tasks:[{key:'a',title:'Widget',description:'Create widget',acceptanceCriteria:['Widget exists'],owner:'opencode',dependsOn:[],humanReview:false},{key:'b',title:'Consumer',description:'Use widget',acceptanceCriteria:['Consumer works'],owner:'codex',dependsOn:['a'],humanReview:false}]});
  await f.controller.tick();await f.controller.tick();
  assert.equal(f.tasks.length,2);assert.ok(f.tasks[1].description.includes(`app#${f.tasks[0].id}`));
  assert.deepEqual((await f.controller.submitGoal({project:'app',goal:'Build a widget and its consumer',request_id:'goal1'})).id,goal.id);
  await assert.rejects(f.controller.submitGoal({project:'app',goal:'different',request_id:'goal1'}),/different/);
});
test('ready on Review starts once and consumes only ready tag',async()=>{
  const f=await fixture();f.tasks[0].status='review';f.tasks[0].tags.push('READY','keep-me');
  await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  assert.deepEqual(f.tasks[0].tags,['owner:opencode','keep-me']);
  await f.controller.tick();assert.equal(f.sent.filter(j=>j.mode==='implementation').length,1);
});
test('stale orchestrator result cannot assign a task after reassignment',async()=>{
  const f=await fixture();f.tasks[0].tags=[];await f.controller.tick();
  await f.controller.assignOrchestrator({project:'app',agent:'opencode'});
  f.finish('assignment',{owner:'codex',reason:'old decision'});await f.controller.tick();
  assert.deepEqual(f.tasks[0].tags,[]);
});
test('changed content invalidates accepted dependency',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  f.finish('implementation',{completed:true,summary:'done',changedFiles:[],checks,needsHumanReview:false});await f.controller.tick();
  f.finish('review',{accepted:true,needsHumanReview:false,summary:'verified',checks,findings:[]});await f.controller.tick();
  f.tasks.push({...f.tasks[0],id:2,status:'todo',description:'Dependencies: app#1'});f.content('modified');await f.controller.tick();
  assert.ok(!f.sent.some(j=>j.taskId==='app#2'));
});
test('ambiguous Kanzo task creation holds the plan rather than creating duplicates',async()=>{
  const f=await fixture();f.tasks.length=0;await f.controller.submitGoal({project:'app',goal:'Widget',request_id:'g'});await f.controller.tick();
  f.finish('planning',{summary:'one',tasks:[{key:'a',title:'Widget',description:'Create widget',acceptanceCriteria:['works'],owner:'codex',dependsOn:[],humanReview:false}]});
  f.board.create=async()=>{throw Error('unknown outcome');};await f.controller.tick();await f.controller.tick();
  assert.equal(f.controller.state.goals[0].status,'needs_attention');assert.equal(f.tasks.length,0);
});
test('human tasks never invoke any worker',async()=>{
  const f=await fixture();f.tasks[0].human=true;await f.controller.tick();assert.equal(f.sent.length,0);
});
test('claim and review linkage are persisted before remote effects',async()=>{
  const f=await fixture();let persistedClaim=false,persistedReview=false;
  const update=f.board.update;f.board.update=async(id,p)=>{if(p.status==='doing'){const state=await f.store.load();persistedClaim=state.jobs.some(j=>j.mode==='implementation'&&j.taskId===id);}return update(id,p);};
  const send=f.workers.send;f.workers.send=async(job,prompt)=>{if(job.mode==='review'){const state=await f.store.load();persistedReview=!!state.jobs.find(j=>j.id===job.id)?.implementationId;}return send(job,prompt);};
  await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  assert.ok(persistedClaim,'claim must have persisted implementation intent');
  f.finish('implementation',{completed:true,summary:'ok',changedFiles:[],checks,needsHumanReview:false});await f.controller.tick();assert.ok(persistedReview,'review must have persisted source linkage');
});
test('failed worker report is retried if Kanzo is temporarily unavailable',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  const impl=f.controller.state.jobs.find(j=>j.mode==='implementation');f.results.set(impl.id,{status:'failed',text:'Provider failed'});
  const comment=f.board.comment;f.board.comment=async()=>{throw Error('board offline');};await f.controller.tick();
  f.board.comment=comment;await f.controller.tick();assert.equal(f.tasks[0].status,'review');assert.ok(f.comments.some(c=>c.body.includes('Provider failed')));
});
test('a task from an ambiguously published plan cannot escape the planning lock',async()=>{
  const f=await fixture();f.tasks.length=0;await f.controller.submitGoal({project:'app',goal:'Widget',request_id:'g'});await f.controller.tick();
  f.finish('planning',{summary:'one',tasks:[{key:'a',title:'Widget',description:'Create widget',acceptanceCriteria:['works'],owner:'codex',dependsOn:[],humanReview:false}]});
  const create=f.board.create;f.board.create=async(...args)=>{await create(...args);throw Error('lost creation response');};await f.controller.tick();await f.controller.tick();
  assert.equal(f.sent.filter(j=>['assignment','readiness','implementation'].includes(j.mode)).length,0);
});
test('cancellation reporting recovers after Kanzo outage',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  const impl=f.controller.state.jobs.find(j=>j.mode==='implementation');const comment=f.board.comment;f.board.comment=async()=>{throw Error('offline');};await assert.rejects(f.controller.cancel(impl.id));
  f.board.comment=comment;await f.controller.tick();assert.equal(f.tasks[0].status,'review');assert.equal(f.controller.get(impl.id).status,'cancelled');
});
test('lost Review PATCH response reconciles completion instead of cancelling it',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();
  f.finish('implementation',{completed:true,summary:'done',changedFiles:[],checks,needsHumanReview:false});
  const update=f.board.update;let lose=true;f.board.update=async(id,p)=>{const v=await update(id,p);if(p.status==='review'&&lose){lose=false;throw Error('lost response');}return v;};
  await f.controller.tick();await f.controller.tick();
  assert.ok(f.controller.state.jobs.some(j=>j.mode==='review'));assert.ok(f.controller.state.outbox.length>0);assert.equal(f.controller.state.jobs.find(j=>j.mode==='implementation').status,'completed');
});
test('requeue and re-review revoke dependency acceptance immediately',async()=>{
  const f=await fixture();const p=f.registry.get('app');const a=f.tasks[0];a.status='review';
  f.controller.state.acceptance['app#1']={taskFingerprint:(await import('../src/policy.mjs')).taskFingerprint(a),workspace:p.workspace,codeFingerprint:'version1'};
  a.tags.push('ready');assert.equal(await f.controller.dependenciesReady({...a,id:3,description:'Dependencies: app#1',tags:[],status:'todo'}),false);
  a.tags=a.tags.filter(t=>t!=='ready');f.controller.state.jobs.push({id:'impl',project:'app',workspace:p.workspace,taskId:'app#1',taskFingerprint:(await import('../src/policy.mjs')).taskFingerprint(a),mode:'implementation',status:'completed'});
  await f.controller.retryReview('app#1');assert.ok(!f.controller.state.acceptance['app#1']);
});
test('unaccepted transitive prerequisite blocks an accepted direct dependency',async()=>{
  const f=await fixture();const a=f.tasks[0];a.status='review';a.description='Dependencies: app#2';f.tasks.push({...a,id:2,status:'todo',description:'Blocked prerequisite'});
  f.controller.state.acceptance['app#1']={taskFingerprint:(await import('../src/policy.mjs')).taskFingerprint(a),workspace:f.registry.get('app').workspace,codeFingerprint:'version1'};
  assert.equal(await f.controller.dependenciesReady({...a,id:3,description:'Dependencies: app#1'}),false);
});
test('failed notifications can retry and their outbox link exists before send',async()=>{
  const f=await fixture();f.tasks.length=0;f.controller.enqueueNotification('app','completed','n1');
  let linked=false;const send=f.workers.send;f.workers.send=async(job,prompt)=>{const saved=await f.store.load();if(job.mode==='notification')linked=saved.outbox.some(n=>n.jobId===job.id);return send(job,prompt);};
  await f.controller.tick();assert.ok(linked);
  const j=f.controller.state.jobs.find(j=>j.mode==='notification');f.results.set(j.id,{status:'failed',text:'temporary provider error'});await f.controller.tick();
  assert.ok(!f.controller.state.outbox[0].jobId);
});
test('partial publication can reconcile a remotely created marker without duplicating cards',async()=>{
  const f=await fixture();f.tasks.length=0;const g=await f.controller.submitGoal({project:'app',goal:'Widget',request_id:'g'});await f.controller.tick();f.finish('planning',{summary:'one',tasks:[{key:'a',title:'Widget',description:'Create widget',acceptanceCriteria:['works'],owner:'codex',dependsOn:[],humanReview:false}]});
  const create=f.board.create;f.board.create=async(...args)=>{await create(...args);throw Error('lost response');};await f.controller.tick();f.board.create=create;
  await f.controller.resumeGoal(g.id);await f.controller.tick();assert.equal(f.tasks.length,1);assert.equal(f.controller.state.goals[0].status,'published');
});
test('repair intent is linked before its scheduling flag is cleared',async()=>{
  const f=await fixture();await f.controller.tick();f.finish('readiness',{ready:true,reason:'clear'});await f.controller.tick();const first=f.controller.state.jobs.find(j=>j.mode==='implementation');
  f.finish('implementation',{completed:true,summary:'done',changedFiles:[],checks,needsHumanReview:false});await f.controller.tick();
  f.finish('review',{accepted:false,needsHumanReview:false,summary:'bug',checks,findings:['Fix widget output']});await f.controller.tick();
  assert.ok(f.controller.state.jobs.some(j=>j.mode==='implementation'&&j.reworkOf===first.id));
});
test('a failed preparation never consumes an unrelated reply from a supplied session',async()=>{
  const f=await fixture();f.tasks.length=0;await f.registry.assign({project:'app',agent:'codex',sessionId:'existing-user-session'});
  f.workers.prepare=async()=>{throw Error('session busy');};let inspected=false;
  f.workers.inspect=async()=>{inspected=true;return {status:'completed',text:JSON.stringify({summary:'Unrelated reply',tasks:[{key:'a',title:'Wrong task',description:'Unrelated',acceptanceCriteria:['exists'],owner:'codex',dependsOn:[],humanReview:false}]})};};
  await f.controller.submitGoal({project:'app',goal:'Actual goal',request_id:'safe-goal'});await f.controller.tick();await f.controller.tick();assert.equal(inspected,false);assert.equal(f.tasks.length,0);
});
