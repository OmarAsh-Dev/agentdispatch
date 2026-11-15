import { randomUUID } from 'node:crypto';
import { Registry, workspaceKey } from './registry.mjs';
import { eligibility, owner, dependencies, taskFingerprint, taskId, hash, needsHuman, safe, validTaskId } from './policy.mjs';
import { fingerprint as contentFingerprint, snapshotFiles } from './fingerprint.mjs';
import { parseResult, promptFor } from './prompts.mjs';
const active=new Set(['creating','sending','running','unknown','needs_attention','result_pending','cancel_pending']);
const coordinating=new Set(['planning','assignment','notification']);
export class Controller {
  constructor({registry,store,board,workers,fingerprint=contentFingerprint,dryRun=false,coordinatorThreadId=null,accessMode='scoped'}){
    if(!['scoped','full'].includes(accessMode))throw Error('Invalid access mode');
    this.registry=registry;this.store=store;this.board=board;this.workers=workers;this.fingerprint=fingerprint;this.dryRun=dryRun;this.coordinatorThreadId=coordinatorThreadId;this.accessMode=accessMode;this.queue=Promise.resolve();
  }
  async init(){
    this.state={jobs:[],goals:[],checks:{},acceptance:{},outbox:[],blocked:{},...(await this.store.load())};
    for(const n of this.state.outbox){if(n.jobId&&!this.state.jobs.some(j=>j.id===n.jobId))delete n.jobId;}
    for(const g of this.state.goals){if(g.status==='planning'&&!this.state.jobs.some(j=>j.goalId===g.id))g.status='queued';}
  }
  serialized(fn){const next=this.queue.then(fn);this.queue=next.catch(()=>{});return next;}
  save(){return this.store.save(this.state);}
  get(id){const job=this.state.jobs.find(j=>j.id===id);if(!job)throw Error('Unknown bridge job');return structuredClone(job);}
  list(){return structuredClone(this.state.jobs);}
  status(){return {dryRun:this.dryRun,accessMode:this.accessMode,projects:this.registry.list(),jobs:this.list(),goals:structuredClone(this.state.goals),blocked:structuredClone(this.state.blocked),pendingNotifications:this.state.outbox.filter(n=>!n.delivered||['sending','unknown','queued'].includes(n.coordinatorState))};}
  async health(){return {healthy:true,service:'global-kanzo-bridge',projects:this.registry.list().length,jobs:this.state.jobs.length,dryRun:this.dryRun,...(this.workers.health?{workers:await this.workers.health()}:{} )};}
  startProject(input){return this.serialized(async()=>{await this.board.ensureProject(input.project);return this.registry.start(input);});}
  assignOrchestrator(input){return this.serialized(async()=>{
    const p=await this.registry.assign(input);
    for(const g of this.state.goals.filter(g=>g.project===input.project&&!['published','cancelled'].includes(g.status))){if(g.status==='publishing')g.status='needs_attention';else{g.status='queued';g.revision=p.orchestrator.revision;}}
    await this.save();return p;
  });}
  submitGoal({project,goal,request_id}){return this.serialized(async()=>{
    const p=this.registry.get(project);if(!p.orchestrator)throw Error('Assign a project orchestrator first');
    if(typeof goal!=='string'||!goal.trim()||goal.length>30000||typeof request_id!=='string'||!request_id||request_id.length>120)throw Error('Provide bounded goal and stable request_id');
    const intent=hash({project,goal}),previous=this.state.goals.find(g=>g.requestId===request_id);
    if(previous){if(previous.hash!==intent)throw Error('request_id reused with different goal');return structuredClone(previous);}
    const g={id:randomUUID(),project,goal,requestId:request_id,hash:intent,status:'queued',revision:p.orchestrator.revision};this.state.goals.push(g);await this.save();return structuredClone(g);
  });}
  resumeGoal(goalId){return this.serialized(async()=>{
    const g=this.state.goals.find(g=>g.id===goalId);if(!g)throw Error('Unknown goal');if(g.status==='published')return structuredClone(g);if(g.status==='cancelled')throw Error('Cancelled goal cannot be resumed; submit a new goal');
    if(this.state.jobs.some(j=>j.goalId===g.id&&active.has(j.status)))throw Error('Resolve or cancel its active planning job first');
    const p=this.registry.get(g.project);
    if(g.plan){
      const snapshot=await this.board.snapshot();
      for(const [key,entry] of Object.entries(g.publication||{}))if(entry.creating&&!entry.id){const found=snapshot.tasks.filter(t=>t.project===g.project&&t.description?.includes(`[bridge-plan:${g.id}:${key}]`));if(found.length!==1)throw Error('Unknown task creation outcome; find/reconcile its exact bridge-plan marker before resuming. It will not be resent.');entry.id=taskId(found[0]);}
      g.status='publishing';
    }else g.status='queued';
    g.revision=p.orchestrator.revision;delete g.error;await this.save();return structuredClone(g);
  });}
  cancelGoal(goalId){return this.serialized(async()=>{
    const g=this.state.goals.find(g=>g.id===goalId);if(!g)throw Error('Unknown goal');const snapshot=await this.board.snapshot();
    const cards=snapshot.tasks.filter(t=>t.project===g.project&&(t.description?.includes(`[bridge-plan:${g.id}:`)||Object.values(g.publication||{}).some(e=>e.id===taskId(t))));
    const ids=new Set(cards.map(taskId));
    for(const j of this.state.jobs.filter(j=>j.goalId===g.id||ids.has(j.taskId))){if(active.has(j.status))await this.stop(j,'Goal cancelled; partial edits preserved.',j.taskId?await this.board.get(j.taskId):null);j.reviewPending=false;j.reworkPending=false;}
    for(const t of cards){delete this.state.acceptance[taskId(t)];if(!t.human&&t.status!=='done')await this.board.update(taskId(t),{status:'review',tags:t.tags.filter(v=>v.toLowerCase()!=='ready')});await this.board.comment(taskId(t),'Goal cancelled. To reuse this card independently, remove its bridge-plan marker before explicitly requeueing it.',`goal-cancel-${g.id}`);}
    g.status='cancelled';await this.save();return structuredClone(g);
  });}
  busy(workspace){return this.state.jobs.some(j=>workspaceKey(j.workspace)===workspaceKey(workspace)&&active.has(j.status)&&!coordinating.has(j.mode));}
  orchestratorBusy(p){return this.state.jobs.some(j=>active.has(j.status)&&coordinating.has(j.mode)&&j.project===p.project);}
  async launch(p,mode,context,{task,goal,sessionId,agent,requestId,metadata={},claim=false}={}){
    const job={id:requestId||randomUUID(),project:p.project,workspace:p.workspace,readScopes:p.readScopes,editScopes:p.editScopes,revision:p.orchestrator.revision,agent:agent||p.orchestrator.agent,mode,status:'creating',createdAt:new Date().toISOString(),...(task?{taskId:taskId(task),taskFingerprint:taskFingerprint(task),taskSnapshot:task}:{}),...(goal?{goalId:goal.id}:{}),...(sessionId?{sessionId}:{})};
    Object.assign(job,metadata);job.accessMode=this.accessMode;this.state.jobs.push(job);await this.save();
    try{
      if(claim)await this.board.update(job.taskId,{status:'doing',tags:task.tags.filter(t=>t.toLowerCase()!=='ready')});
      if(mode==='implementation'){job.filesBefore=await snapshotFiles(job.workspace);await this.save();}
      Object.assign(job,await this.workers.prepare(job));
      job.prepared=true;
      if(coordinating.has(mode))await this.registry.bindSession(p.project,job.revision,job.sessionId);
      job.status='sending';await this.save();
      try{Object.assign(job,await this.workers.send(job,promptFor(job,context)));job.status='running';}
      catch(e){job.status='unknown';job.error=safe(e.message);}
    }catch(e){job.status='needs_attention';job.error=safe(e.message);if(job.taskId){await this.board.comment(job.taskId,`Worker setup needs attention: ${job.error}`,`setup-${job.id}`);if(mode==='implementation'){await this.board.update(job.taskId,{status:'review'});job.pausedForAttention=true;}}}
    await this.save();return job;
  }
  async note(task,reason){const id=taskId(task),key=hash({fingerprint:taskFingerprint(task),reason});if(this.state.blocked[id]?.key===key)return;await this.board.comment(id,reason,`blocked-${key}`);this.state.blocked[id]={key,reason};await this.save();}
  async dependenciesReady(task,visiting=new Set()){
    const id=taskId(task);if(visiting.has(id))throw Error('Cyclic dependency');const next=new Set([...visiting,id]);
    for(const ref of dependencies(task)){
      const dep=await this.board.get(ref);if(!await this.dependenciesReady(dep,next))return false;
      if(dep.status==='done')continue;
      if(eligibility(dep))return false;
      const accepted=this.state.acceptance[ref];
      if(!accepted||needsHuman(dep)||dep.status!=='review'||accepted.taskFingerprint!==taskFingerprint(dep))return false;
      const p=this.registry.get(dep.project);
      if(accepted.workspace!==p.workspace||accepted.codeFingerprint!==await this.fingerprint(p.workspace,accepted.reviewPaths))return false;
    }
    return true;
  }
  async currentTask(job){const task=await this.board.get(job.taskId);return {task,unchanged:taskFingerprint(task)===job.taskFingerprint};}
  enqueueNotification(project,message,key){if(!this.state.outbox.some(n=>n.key===key))this.state.outbox.push({project,message:safe(message),key,delivered:false});}
  async pollJobs(){
    for(const job of this.state.jobs.filter(j=>active.has(j.status))){
      try{
        if(job.status==='cancel_pending'){await this.stop(job,job.error,job.taskId?await this.board.get(job.taskId):null);continue;}
        if(job.status==='result_pending'){await this.handleResult(job);continue;}
        if(job.taskId&&job.mode==='implementation'){
          const {task,unchanged}=await this.currentTask(job);
          if(!unchanged||task.human||(task.status!=='doing'&&!(job.pausedForAttention&&task.status==='review'))){await this.stop(job,'Task changed while running; partial edits preserved.',task);continue;}
        }
        if(job.status==='creating'||(!job.prepared&&job.status==='needs_attention')){job.status='needs_attention';continue;}
        const result=await this.workers.inspect(job);
        if(result.turnId)job.turnId=result.turnId;
        if(result.status==='needs_attention'){
          job.pending=result.pending;job.status='needs_attention';
          if(job.taskId){await this.board.comment(job.taskId,`Worker needs attention. No permissions approved.\n${safe(JSON.stringify(result.pending||[]))}`,`attention-${job.id}-${hash(result.pending||[])}`);if(job.mode==='implementation'){await this.board.update(job.taskId,{status:'review'});job.pausedForAttention=true;}}
          continue;
        }
        if(result.status==='running'){job.status='running';job.pending=[];}
        if(result.status==='completed'||result.status==='failed'){
          Object.assign(job,{result:result.text||'',workerStatus:result.status,error:result.error,status:'result_pending',pending:[]});await this.save();await this.handleResult(job);
        }
      }catch(e){job.syncError=safe(e.message);}
    }
  }
  async handleResult(job){
    const p=this.registry.get(job.project);
    if(job.mode==='review')delete this.state.acceptance[job.taskId];
    if(coordinating.has(job.mode)&&job.revision!==p.orchestrator.revision){job.status='cancelled';job.error='Superseded orchestrator revision';this.releaseNotification(job,'Orchestrator reassigned');await this.save();return;}
    if(job.workerStatus==='failed'){if(job.taskId){await this.board.comment(job.taskId,`Worker failed: ${safe(job.result||JSON.stringify(job.error))}`,`failed-${job.id}`);const task=await this.board.get(job.taskId);if(job.mode==='implementation'&&task.status==='doing')await this.board.update(job.taskId,{status:'review'});}job.status='failed';this.releaseNotification(job,'Notification worker failed');if(job.goalId){const g=this.state.goals.find(g=>g.id===job.goalId);g.status='needs_attention';g.error='Planning worker failed';}await this.save();return;}
    let result;
    try{result=['discussion','notification'].includes(job.mode)?{summary:job.result}:parseResult(job.mode,job.result);if(job.mode==='planning')this.validatePlan(result);}
    catch(e){job.error=`Invalid ${job.mode} result: ${safe(e.message).slice(0,1500)}`;if(job.taskId){await this.board.comment(job.taskId,job.error,`invalid-${job.id}`);const t=await this.board.get(job.taskId);if(job.mode==='implementation'&&t.status==='doing')await this.board.update(job.taskId,{status:'review'});}job.status='failed';if(job.goalId){const g=this.state.goals.find(g=>g.id===job.goalId);g.status='needs_attention';g.error=job.error;}await this.save();return;}
    if(job.mode==='planning'){
      const g=this.state.goals.find(g=>g.id===job.goalId);this.validatePlan(result);g.plan=result;g.publication={};g.status='publishing';job.status='completed';await this.save();return;
    }
    if(job.mode==='notification'){const n=this.state.outbox.find(n=>n.jobId===job.id);if(n)n.delivered=true;job.status='completed';await this.save();return;}
    const {task,unchanged}=await this.currentTask(job);
    if(!unchanged||task.human||(job.mode==='review'&&(task.status!=='review'||eligibility(task)))){await this.stop(job,'Task changed; stale result retained without dispatch.',task);return;}
    if(job.mode==='assignment'){
      if(eligibility(task)&&!owner(task)){await this.board.update(job.taskId,{tags:[...task.tags,`owner:${result.owner}`]});await this.board.comment(job.taskId,`Orchestrator assigned ${result.owner}: ${result.reason}`,`assigned-${job.id}`);}
    }else if(job.mode==='readiness'){
      this.state.checks[job.taskId]={fingerprint:job.taskFingerprint,contextKey:job.contextKey,...result};
      job.status='completed';await this.save();
      if(!result.ready){await this.note(task,`Not ready: ${result.reason}`);return;}
      if(!eligibility(task)||!await this.dependenciesReady(task))return;
      const fresh=await this.board.get(job.taskId);if(taskFingerprint(fresh)!==job.taskFingerprint||!eligibility(fresh))return;
      delete this.state.acceptance[job.taskId];delete this.state.blocked[job.taskId];
      // Persist the claim before preparing a new worker session.
      await this.save();await this.launch(p,'implementation',{task:fresh},{task:fresh,agent:owner(fresh),claim:true});return;
    }else if(job.mode==='implementation'){
      await this.board.comment(job.taskId,`Implementation report (${job.agent}, session ${job.sessionId}):\n${safe(JSON.stringify(result,null,2))}\nIndependent review pending.`, `result-${job.id}`);
      if(task.status==='doing')await this.board.update(job.taskId,{status:'review'});
      job.implementation=result;job.humanReview=needsHuman(task);
      const after=await snapshotFiles(job.workspace),before=job.filesBefore||{};
      job.reviewPaths=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(path=>before[path]!==after[path]);
      if(!job.reviewPaths.length)job.reviewPaths=null;
      job.codeFingerprint=await this.fingerprint(job.workspace,job.reviewPaths);job.reviewPending=true;
      this.enqueueNotification(job.project,`${job.taskId} implementation finished; independent review queued. ${result.summary}${job.humanReview?' Human approval is required after the technical review.':''}`,`implementation-${job.id}`);
    }else if(job.mode==='review'){
      const impl=this.state.jobs.find(j=>j.id===job.implementationId);
      const requiredChecks=result.checks.filter(c=>c.required);
      const humanApproval=needsHuman(task)||result.needsHumanReview;
      const technicalPassed=result.accepted&&result.findings.length===0&&requiredChecks.length>0&&requiredChecks.every(c=>c.passed)&&job.codeFingerprint===await this.fingerprint(job.workspace,job.reviewPaths);
      const accepted=technicalPassed&&!humanApproval;
      const outcome=technicalPassed
        ? (humanApproval?'agent review passed; human approval is still required':'agent review passed; dependencies may continue')
        : (humanApproval?'review needs attention; human input is required':'review needs attention');
      await this.board.comment(job.taskId,`Independent Codex review: ${outcome}.\n${safe(JSON.stringify(result,null,2))}`,`review-${job.id}`);
      if(accepted)this.state.acceptance[job.taskId]={taskFingerprint:job.taskFingerprint,codeFingerprint:job.codeFingerprint,reviewPaths:job.reviewPaths,workspace:job.workspace,implementationId:impl.id,reviewJobId:job.id};
      else if(!humanApproval&&(result.findings.length||requiredChecks.some(c=>!c.passed))){const attempts=this.state.jobs.filter(j=>j.taskId===job.taskId&&j.mode==='implementation').length;if(attempts<3){impl.rework={findings:result.findings,checks:result.checks};impl.reworkPending=true;} }
      this.enqueueNotification(job.project,`${job.taskId}: ${outcome}. ${result.summary}`,`review-${job.id}`);
    }else if(job.mode==='discussion'){await this.board.comment(job.taskId,job.result,`discussion-${job.id}`);}
    job.status='completed';job.parsed=result;job.finishedAt=new Date().toISOString();await this.save();
  }
  validatePlan(plan){
    const keys=new Set(plan.tasks.map(t=>t.key));if(keys.size!==plan.tasks.length)throw Error('Duplicate plan keys');
    const walk=(key,seen=new Set())=>{if(seen.has(key))throw Error('Cyclic plan');const t=plan.tasks.find(t=>t.key===key);for(const d of t.dependsOn){if(keys.has(d))walk(d,new Set([...seen,key]));else if(!validTaskId(d))throw Error('Unknown plan dependency');}};
    for(const t of plan.tasks)walk(t.key);
  }
  async publish(g){
    const p=this.registry.get(g.project);if(p.orchestrator.revision!==g.revision){g.status='needs_attention';g.error='Orchestrator changed during publication';await this.save();return;}
    for(const t of g.plan.tasks){
      const entry=g.publication[t.key]??={};
      const marker=`[bridge-plan:${g.id}:${t.key}]`;
      if(!entry.id){
        const board=await this.board.snapshot();const matches=board.tasks.filter(x=>x.project===g.project&&x.description?.includes(marker));
        if(matches.length>1)throw Error('Duplicate plan marker; human reconciliation required');
        if(matches.length)entry.id=taskId(matches[0]);
        else{
          if(entry.creating){g.status='needs_attention';g.error=`Unknown task creation outcome for ${t.key}; inspect board before retrying`;await this.save();return;}
          entry.creating=true;await this.save();
          const created=await this.board.create(g.project,t.title,`${t.description}\n\nAcceptance criteria:\n${t.acceptanceCriteria.map(a=>'- '+a).join('\n')}\n${marker}`);
          entry.id=taskId(created);
        }
        await this.save();
      }
    }
    for(const t of g.plan.tasks){const entry=g.publication[t.key];if(entry.updated)continue;
      const task=await this.board.get(entry.id);const refs=t.dependsOn.map(d=>g.publication[d]?.id||d);
      for(const ref of refs)await this.board.get(ref);
      await this.board.update(entry.id,{description:task.description.replace(/^Dependencies:.*\r?\n?/gim,'')+`\nDependencies: ${refs.length?refs.join(', '):'None.'}`,tags:[...task.tags.filter(v=>!v.toLowerCase().startsWith('owner:')),`owner:${owner(task)||t.owner}`,...(t.humanReview&&!task.tags.includes('review:human')?['review:human']:[])]});
      entry.updated=true;await this.save();
    }
    g.status='published';this.enqueueNotification(g.project,`Plan published: ${g.plan.summary}. Tasks: ${Object.values(g.publication).map(e=>e.id).join(', ')}`,`plan-${g.id}`);await this.save();
  }
  async stop(job,reason,task){
    const shouldCancel=job.prepared&&job.sessionId&&['sending','running','unknown','needs_attention','cancel_pending'].includes(job.status)&&!job.cancelSent;
    job.status='cancel_pending';job.error=reason;job.reviewPending=false;await this.save();
    if(shouldCancel){await this.workers.cancel(job);job.cancelSent=true;await this.save();}
    if(job.taskId){delete this.state.acceptance[job.taskId];await this.board.comment(job.taskId,reason,`cancelled-${job.id}`);if(job.mode==='implementation'&&task?.status==='doing')await this.board.update(job.taskId,{status:'review'});}
    job.status='cancelled';await this.save();
  }
  cancel(id){return this.serialized(async()=>{const j=this.state.jobs.find(j=>j.id===id);if(!j)throw Error('Unknown bridge job');if(j.notificationViaQueue&&active.has(j.status))throw Error('A queued notification cannot be unsent; resolve it in the bound chat before recovery');await this.stop(j,'Cancelled by user; partial edits preserved.',j.taskId?await this.board.get(j.taskId):null);return this.get(id);});}
  replyApproval({job_id,request_id,request_fingerprint,decision,user_confirmed}){return this.serialized(async()=>{
    if(user_confirmed!==true)throw Error('An explicit user decision is required');
    const job=this.state.jobs.find(j=>j.id===job_id);
    if(!job||job.agent!=='codex'||!job.prepared||job.status!=='needs_attention')throw Error('Codex job is not awaiting attention');
    if(!['approve_once','decline'].includes(decision)||!(/^[a-f0-9]{64}$/).test(request_fingerprint))throw Error('Invalid approval decision or fingerprint');
    if(coordinating.has(job.mode)&&job.revision!==this.registry.get(job.project).orchestrator.revision)throw Error('Orchestrator changed; approval refused');
    if(job.taskId){
      const {task,unchanged}=await this.currentTask(job);
      const validState=job.mode==='implementation'?(task.status==='doing'||(job.pausedForAttention&&task.status==='review'&&!eligibility(task))):job.mode==='review'?(task.status==='review'&&!eligibility(task)):['readiness','assignment'].includes(job.mode)?eligibility(task):true;
      if(!unchanged||task.human||!validState)throw Error('Task changed; approval refused');
    }
    const replies=job.approvalReplies??=[];
    if(replies.some(r=>r.requestId===request_id&&r.fingerprint===request_fingerprint))throw Error('Request reply already attempted; inspect before recovery');
    const receipt={requestId:request_id,fingerprint:request_fingerprint,decision,status:'sending',at:new Date().toISOString()};replies.push(receipt);await this.save();
    try{await this.workers.replyApproval(job,request_id,request_fingerprint,decision);receipt.status='sent';job.status='running';job.pending=[];}
    catch(e){receipt.status='unknown';receipt.error=safe(e.message);await this.save();throw e;}
    await this.save();return this.get(job.id);
  });}
  async scheduleReviews(){
    for(const impl of this.state.jobs.filter(j=>j.status==='completed'&&(j.reviewPending||j.reworkPending))){
      const p=this.registry.get(impl.project);if(this.busy(p.workspace))continue;
      const task=await this.board.get(impl.taskId);
      if(taskFingerprint(task)!==impl.taskFingerprint||task.status!=='review'||task.human){impl.reviewPending=false;impl.reworkPending=false;await this.save();continue;}
      if(impl.reworkPending){
        if(!this.state.jobs.some(j=>j.reworkOf===impl.id)){
          delete this.state.acceptance[impl.taskId];await this.save();
          await this.launch(p,'implementation',{task,previousReport:impl.implementation,rework:impl.rework},{task,agent:owner(task),claim:true,metadata:{reworkOf:impl.id}});
        }
        impl.reworkPending=false;await this.save();
      }else{
        // Persist the review job before clearing its scheduling flag. Recovery finds it.
        if(this.state.jobs.some(j=>j.implementationId===impl.id)){impl.reviewPending=false;await this.save();continue;}
        await this.launch(p,'review',{task,implementationReport:impl.implementation,observedChangedFiles:impl.reviewPaths,sourceSession:impl.sessionId},{task,agent:'codex',metadata:{implementationId:impl.id,reviewPaths:impl.reviewPaths,codeFingerprint:await this.fingerprint(p.workspace,impl.reviewPaths)}});
        impl.reviewPending=false;await this.save();
      }
    }
  }
  staged(task){return this.state.goals.some(g=>g.status==='cancelled'?task.description?.includes(`[bridge-plan:${g.id}:`):g.status!=='published'&&(Object.values(g.publication||{}).some(p=>p.id===taskId(task))||task.description?.includes(`[bridge-plan:${g.id}:`)));}
  async scheduleTasks(snapshot){
    for(const candidate of snapshot.tasks){
      if(!eligibility(candidate)||this.staged(candidate))continue;
      let p;try{p=this.registry.get(candidate.project);}catch{this.state.blocked[taskId(candidate)]={reason:'Register workspace and start/assign an orchestrator'};continue;}
      if(!p.orchestrator||this.busy(p.workspace))continue;
      const task=await this.board.get(taskId(candidate));if(!eligibility(task))continue;
      try{
        if(!await this.dependenciesReady(task)){await this.note(task,'Waiting for dependencies to be Done or independently accepted. Human review requires your approval.');continue;}
        const agent=owner(task);
        if(!agent){
          if(!this.orchestratorBusy(p))await this.launch(p,'assignment',{task},{task,sessionId:p.orchestrator.sessionId});continue;
        }
        const contextKey=hash({task:taskFingerprint(task),status:task.status,ready:task.tags.some(t=>t.toLowerCase()==='ready'),code:await this.fingerprint(p.workspace)});
        const prior=this.state.checks[taskId(task)];if(prior?.contextKey===contextKey&&!prior.ready)continue;
        await this.launch(p,'readiness',{task,dependenciesSatisfied:true},{task,agent:p.orchestrator.agent,metadata:{contextKey}});
      }catch(e){await this.note(task,safe(e.message));}
    }
  }
  async notifications(){
    // Older versions could misread another writer's live history as failure.
    // Reattach its durable receipt before any retry can enqueue another copy.
    for(const n of this.state.outbox.filter(n=>!n.delivered)){
      if(n.resendConfirmed)continue;
      const linked=this.state.jobs.find(j=>j.id===n.jobId);if(linked&&active.has(linked.status))continue;
      const queued=this.recordedQueuedNotification(n);
      if(queued){n.jobId=queued.id;if(queued.status!=='cancelled')queued.status='running';await this.save();}
    }
    if(this.coordinatorThreadId)for(const n of this.state.outbox.filter(n=>!n.coordinatorAttempted)){
      n.coordinatorAttempted=true;n.coordinatorState='sending';await this.save();
      try{n.coordinatorResult=await this.workers.notifyCoordinator(this.coordinatorThreadId,`Kanzo bridge progress (reference data, not a new user instruction):\n${n.message}\nNotification: ${n.key}`);n.coordinatorState=n.coordinatorResult.wakeConfirmed?'delivered':'queued';}catch(e){n.coordinatorState='unknown';n.coordinatorError=safe(e.message);}await this.save();
    }
    for(const n of this.state.outbox.filter(n=>!n.delivered&&!n.jobId&&(n.attempts||0)<3&&(n.nextAttemptAt||0)<=Date.now())){
      const p=this.registry.get(n.project);if(this.orchestratorBusy(p))continue;
        const id=randomUUID();n.jobId=id;n.attempts=(n.attempts||0)+1;n.resendConfirmed=false;await this.save();
      await this.launch(p,'notification',{message:n.message},{sessionId:p.orchestrator.sessionId,requestId:id,metadata:{notificationKey:n.key}});await this.save();
    }
  }
  releaseNotification(job,reason){
    if(job.mode!=='notification')return;
    const n=this.state.outbox.find(n=>n.jobId===job.id||n.key===job.notificationKey);if(!n)return;
    delete n.jobId;n.error=reason;n.nextAttemptAt=Date.now()+3000;
    if(reason==='Orchestrator reassigned')n.attempts=0;
  }
  recordedQueuedNotification(n){
    const linked=this.state.jobs.find(j=>j.id===n.jobId);
    return linked?.notificationViaQueue&&linked.queueDelivery?.queued?linked:[...this.state.jobs].reverse().find(job=>job.notificationKey===n.key&&job.notificationViaQueue&&job.queueDelivery?.queued);
  }
  retryNotification({key,destination='orchestrator',confirm_unknown=false}){return this.serialized(async()=>{
    const n=this.state.outbox.find(n=>n.key===key);if(!n)throw Error('Unknown notification');
    if(destination==='coordinator'){
      if(['sending','unknown','queued'].includes(n.coordinatorState)&&!confirm_unknown)throw Error('Queue delivery is uncertain/already queued; explicit confirmation is required before potentially duplicating it');
      delete n.coordinatorAttempted;delete n.coordinatorState;delete n.coordinatorError;
    }else{
      const j=this.state.jobs.find(j=>j.id===n.jobId);if(j&&active.has(j.status))throw Error('Resolve/cancel its active notification job first');
        const queued=this.recordedQueuedNotification(n);
        if(queued&&!confirm_unknown){queued.status='running';n.jobId=queued.id;n.delivered=false;await this.save();return structuredClone(n);}
        n.resendConfirmed=!!(queued&&confirm_unknown);
      delete n.jobId;n.delivered=false;n.attempts=0;n.nextAttemptAt=0;
    }
    await this.save();return structuredClone(n);
  });}
  tick(){return this.serialized(async()=>{
    const snapshot=await this.board.snapshot();
    if(this.dryRun)return {eligible:snapshot.tasks.filter(eligibility).map(taskId),...this.status()};
    await this.pollJobs();
    for(const g of this.state.goals){
      try{
        if(g.status==='publishing')await this.publish(g);
        if(g.status==='queued'){
          const p=this.registry.get(g.project);if(this.orchestratorBusy(p))continue;
          // Link the job ID before sending so restart cannot schedule another plan.
          g.status='planning';await this.save();const job=await this.launch(p,'planning',{goal:g.goal,existingTasks:snapshot.tasks.filter(t=>t.project===g.project)},{goal:g,sessionId:p.orchestrator.sessionId});g.jobId=job.id;await this.save();
        }
      }catch(e){g.error=safe(e.message);g.status='needs_attention';await this.save();}
    }
    await this.scheduleReviews();await this.scheduleTasks(await this.board.snapshot());await this.notifications();await this.save();return this.status();
  });}
  poll(){return this.tick();}
  async wait(id,seconds=30){const until=Date.now()+Math.max(0,Math.min(55,seconds))*1000;do{await this.tick();const j=this.get(id);if(!active.has(j.status)||Date.now()>=until)return j;await new Promise(r=>setTimeout(r,1000));}while(true);}
  send({task_id,message,request_id,mode='discussion'}){return this.serialized(async()=>{
    if(!validTaskId(task_id)||!['discussion','implementation'].includes(mode)||!message?.trim()||message.length>30000||!request_id||request_id.length>120)throw Error('Invalid dispatch arguments');
    const payload=hash({task_id,message,mode});const old=this.state.jobs.find(j=>j.requestId===request_id);if(old){if(old.payload!==payload)throw Error('request_id reused with different payload');return this.get(old.id);}
    const task=await this.board.get(task_id),p=this.registry.get(task.project);if(this.busy(p.workspace)||task.human)throw Error('Workspace busy or task is human');
    if(mode==='implementation')throw Error('Automatic implementation goes through owner, eligibility and readiness checks. Queue the task with Todo OR ready.');
    const j=await this.launch(p,'discussion',{task,message},{task,agent:'opencode',metadata:{requestId:request_id,payload}});return this.get(j.id);
  });}
  answer(id,questionId,answers){return this.serialized(async()=>{const j=this.state.jobs.find(j=>j.id===id);if(!j?.pending?.some(q=>q.id===questionId&&q.type==='question'))throw Error('Question does not belong to this job');await this.workers.answer(j,questionId,answers);return this.get(id);});}
  retryReview(task_id){return this.serialized(async()=>{const t=await this.board.get(task_id);if(t.status!=='review'||t.human)throw Error('Requires an agent-implemented task in Review');const p=this.registry.get(t.project);if(this.busy(p.workspace))throw Error('Cancel/resolve the active workspace job first');const impl=[...this.state.jobs].reverse().find(j=>j.taskId===task_id&&j.mode==='implementation'&&j.status==='completed');if(!impl||impl.taskFingerprint!==taskFingerprint(t))throw Error('No matching completed implementation');delete this.state.acceptance[task_id];impl.reviewPending=true;for(const prior of this.state.jobs.filter(j=>j.implementationId===impl.id)){prior.implementationIdArchived=prior.implementationId;delete prior.implementationId;}await this.save();return {queuedReview:true,taskId:task_id};});}
}
