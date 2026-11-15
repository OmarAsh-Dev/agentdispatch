import { OpenCodeApi } from './adapters.mjs';
import { CodexWorker } from './codex-worker.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packagedCodex } from './codex-runtime.mjs';
import { sessionLabel } from './session-label.mjs';
export class ScopedOpenCodeApi extends OpenCodeApi {
  constructor(options){super(options);this.readScopes=options.readScopes||['**'];this.editScopes=options.editScopes||['**'];this.accessMode=options.accessMode||'scoped';}
  permissionRules(mode) {
    if(this.accessMode==='full')return [{permission:'*',pattern:'*',action:'allow'}];
    const paths=scope=>{
      const absolute=`${this.workspace}/${scope}`;const driveRelative=absolute.replace(/^[A-Za-z]:\//,'');
      return [...new Set([scope,absolute,driveRelative,...[scope,absolute,driveRelative].map(v=>v.replaceAll('/','\\'))])];
    };
    const allow=(permission,scopes)=>scopes.flatMap(s=>paths(s).map(pattern=>({permission,pattern,action:'allow'})));
    return [
      {permission:'*',pattern:'*',action:'ask'},
      ...['using-superpowers','using-agent-skills','test-driven-development','verification-before-completion','systematic-debugging','executing-plans','git-workflow-and-versioning','code-review-and-quality'].map(pattern=>({permission:'skill',pattern,action:'allow'})),
      {permission:'read',pattern:'*',action:'deny'},
      ...allow('read',this.readScopes),
      ...['glob','grep','list'].map(permission=>({permission,pattern:'*',action:'deny'})),
      {permission:'edit',pattern:'*',action:'deny'},
      ...(mode==='implementation'?allow('edit',this.editScopes):[]),
      ...['read','edit'].flatMap(permission=>['**/.state/**','**/.env*','**/.git/**','**/auth.json','**/credentials*','**/.ssh/**'].flatMap(pattern=>[pattern,pattern.replaceAll('/','\\')].map(p=>({permission,pattern:p,action:'deny'})))),
      {permission:'external_directory',pattern:'*',action:'deny'},
      {permission:'bash',pattern:'*',action:mode==='implementation'?'ask':'deny'},
    ];
  }
}
export class Workers {
  constructor({runtime,model,codexCommand,codexPrefixArgs,accessMode='scoped',codex=new CodexWorker({command:codexCommand,prefixArgs:codexPrefixArgs,accessMode})}){if(!['scoped','full'].includes(accessMode))throw Error('Invalid access mode');const bundled=packagedCodex();this.runtime=runtime;this.model=model;this.accessMode=accessMode;this.codex=codex;this.codexCommand=codexCommand||bundled.command;this.codexPrefixArgs=codexPrefixArgs??(codexCommand?[]:bundled.prefixArgs);}
  async notifyCoordinator(threadId,message){
    const packaged=packagedCodex();const env=this.codexCommand===packaged.command?{...process.env,...packaged.env}:process.env;
    const {stdout,stderr}=await promisify(execFile)(this.codexCommand,[...this.codexPrefixArgs,'queue','--thread',threadId,'--message',message,'--resume'],{windowsHide:true,env,timeout:20000,maxBuffer:64000});
    return {queued:true,wakeConfirmed:!(/warning|failed|unable/i.test(stderr)),detail:(stdout+'\n'+stderr).trim().slice(0,2000)};
  }
  api(job){return new ScopedOpenCodeApi({url:this.runtime.openCodeUrl,password:this.runtime.openCodePassword,workspace:job.workspace,model:this.model,readScopes:job.readScopes,editScopes:job.editScopes,accessMode:this.accessMode});}
  async prepare(job){
    if(job.agent==='codex')return this.codex.prepare(job);
    const api=this.api(job);await api.health();
    const sessionId=job.sessionId||(await api.createSession(sessionLabel(job),job.mode==='implementation'?'implementation':'discussion')).id;
    const before=await api.inspect(sessionId);if(before.busy||before.pending.length)throw Error('OpenCode session is busy or needs attention');
    if(job.sessionId)await api.refreshPermissions(sessionId,job.mode==='implementation'?'implementation':'discussion');
    return {sessionId,baseline:before.messages.map(m=>m.id)};
  }
  async send(job,prompt){
    if(job.agent==='codex'&&job.notificationViaQueue)return {queueDelivery:await this.notifyCoordinator(job.sessionId,prompt)};
    if(job.agent==='codex')return this.codex.send(job,prompt);
    await this.api(job).send(job.sessionId,prompt,this.model,job.mode==='implementation'?'implementation':'discussion');return {};
  }
  async inspect(job){
    if(job.agent==='codex')return this.codex.inspect(job);
    const r=await this.api(job).inspect(job.sessionId);
    if(r.pending.length)return {status:'needs_attention',pending:r.pending};
    const replies=r.messages.filter(m=>m.role==='assistant'&&!job.baseline.includes(m.id));const final=replies.at(-1);
    if(!final?.completed||r.busy)return {status:'running'};
    return {status:replies.some(m=>m.error)?'failed':'completed',text:final.text||'',error:replies.find(m=>m.error)?.error};
  }
  async cancel(job){
    if(job.agent==='codex')return this.codex.cancel(job);
    const api=this.api(job);await api.abort(job.sessionId);
    for(let attempt=0;attempt<20;attempt++){if(!(await api.inspect(job.sessionId)).busy)return;await new Promise(r=>setTimeout(r,250));}
    throw Error('OpenCode cancellation is not confirmed; workspace remains locked');
  }
  async health(){
    let openCode,codex;
    try{openCode=await this.api({workspace:process.cwd()}).health();}catch(e){openCode={healthy:false,error:e.message};}
    try{await this.codex.connect();codex={connected:true,windowsSandbox:await this.codex.rpc.call('windowsSandbox/readiness',{})};}catch(e){codex={connected:false,error:e.message};}
    return {openCode,codex,model:this.model};
  }
  async answer(job,questionId,answers){if(job.agent!=='opencode')throw Error('Answer Codex questions in its session');return this.api(job).answerQuestion(questionId,answers);}
  async replyApproval(job,requestId,fingerprint,decision){if(job.agent!=='codex')throw Error('This approval relay is only for Codex');return this.codex.replyApproval(job,requestId,fingerprint,decision);}
  async close(){await this.codex.close();}
}
