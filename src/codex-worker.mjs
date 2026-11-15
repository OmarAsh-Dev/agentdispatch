import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { Schemas } from './prompts.mjs';
import { packagedCodex } from './codex-runtime.mjs';
import { hash } from './policy.mjs';
import { sessionLabel } from './session-label.mjs';
export class CodexRpc {
  constructor(child) {
    this.child=child;this.next=0;this.pending=new Map();this.attention=new Map();this.turns=new Map();this.items=new Map();this.repliesAttempted=new Set();
    this.lines=createInterface({input:child.stdout});
    this.lines.on('line',line=>{try{this.receive(JSON.parse(line));}catch{/* nonprotocol output is not copied to logs */}});
    child.stderr?.on('data',()=>{});
    child.once('exit',()=>this.fail(Error('Codex App Server exited')));
    child.once('error',e=>this.fail(e));
  }
  receive(message) {
    if(message.method) {
      this.onNotification?.(message);
      const p=message.params;
      if(message.method==='serverRequest/resolved')this.attention.set(p.threadId,(this.attention.get(p.threadId)||[]).filter(r=>r.id!==p.requestId));
      if(['turn/started','turn/completed'].includes(message.method)&&p?.turn)this.turns.set(`${p.threadId}:${p.turn.id}`,p.turn);
      if(message.method==='item/completed'&&p?.item){const key=`${p.threadId}:${p.turnId}`;const list=this.items.get(key)||[];list.push(p.item);this.items.set(key,list.slice(-200));}
      if(message.id!=null){const session=message.params?.threadId||'unknown';const list=this.attention.get(session)||[];list.push({id:message.id,method:message.method,params:message.params});this.attention.set(session,list.slice(-20));}
      return;
    }
    const item=this.pending.get(message.id);if(!item)return;
    this.pending.delete(message.id);clearTimeout(item.timer);
    if(message.error)item.reject(Error(`Codex ${item.method}: ${message.error.message}`));else item.resolve(message.result);
  }
  call(method,params={},timeoutMs=20000) {
    return new Promise((resolve,reject)=>{
      const id=++this.next;
      const timer=setTimeout(()=>{this.pending.delete(id);const e=Error(`Codex ${method} outcome unknown after timeout`);e.uncertain=true;reject(e);},timeoutMs);
      this.pending.set(id,{resolve,reject,timer,method});
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});
    });
  }
  notify(method,params={}){this.child.stdin.write(JSON.stringify({method,params})+'\n');}
  async reply(request,result){
    const key=hash(request);
    if(this.dead||this.repliesAttempted.has(key))throw Error('Request reply unavailable or already attempted; inspect before recovery');
    this.repliesAttempted.add(key);
    await new Promise((resolve,reject)=>this.child.stdin.write(JSON.stringify({id:request.id,result})+'\n',e=>e?reject(e):resolve()));
    const thread=request.params.threadId;
    this.attention.set(thread,(this.attention.get(thread)||[]).filter(r=>r!==request));
  }
  fail(e){this.dead=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();}
  close(){
    this.fail(Error('Codex connection closed'));this.lines.close();
    if(!this.child.kill||this.child.exitCode!=null){this.child.stdin.end();return Promise.resolve();}
    return new Promise(resolve=>{const timer=setTimeout(()=>{this.child.kill();resolve();},2000);this.child.once('exit',()=>{clearTimeout(timer);resolve();});this.child.stdin.end();});
  }
}
export class CodexWorker {
  constructor({command,prefixArgs,args=['app-server','--stdio'],spawnFn=spawn,accessMode='scoped'}={}){if(!['scoped','full'].includes(accessMode))throw Error('Invalid access mode');const bundled=packagedCodex();this.command=command||bundled.command;this.env=this.command===bundled.command?{...process.env,...bundled.env}:process.env;this.args=[...(prefixArgs??(command?[]:bundled.prefixArgs)),...args];this.spawn=spawnFn;this.ownedSessions=new Set();this.accessMode=accessMode;}
  async connect(){
    if(this.rpc&&!this.rpc.dead)return;
    await this.rpc?.close();
    const rpc=new CodexRpc(this.spawn(this.command,this.args,{windowsHide:true,env:this.env,stdio:['pipe','pipe','pipe']}));
    try{await rpc.call('initialize',{clientInfo:{name:'kanzo_global_bridge',version:'2.0.0'}});rpc.notify('initialized');this.rpc=rpc;this.ownedSessions.clear();}catch(e){await rpc.close();throw e;}
  }
  async prepare({workspace,mode,sessionId,readScopes=['**'],editScopes=['**']}) {
    if(this.accessMode!=='full'&&(readScopes.length!==1||readScopes[0]!=='**'||(mode==='implementation'&&(editScopes.length!==1||editScopes[0]!=='**'))))throw Error('Installed Codex protocol cannot enforce narrow registered scopes; use OpenCode or explicitly register full workspace scope');
    await this.connect();
    if(this.accessMode!=='full'&&process.platform==='win32'&&['readiness','review','implementation'].includes(mode)){
      const readiness=await this.rpc.call('windowsSandbox/readiness',{});if(readiness.status!=='ready')throw Error(`Codex Windows sandbox is ${readiness.status}; repair the installed app runtime before file work`);
    }
    // An existing orchestrator may be owned by the desktop app. Queue progress
    // to that writer instead of trying to acquire its thread for a read-only ack.
    if(mode==='notification'&&sessionId){
      if(!this.ownedSessions.has(sessionId))return {sessionId,baseline:[],notificationViaQueue:true};
      const turns=await this.rpc.call('thread/turns/list',{threadId:sessionId,limit:1,sortDirection:'desc'});
      if(turns.data?.some(t=>t.status==='inProgress'))throw Error('Orchestrator session is busy');
      return {sessionId,baseline:(turns.data||[]).map(t=>t.id)};
    }
    const params={cwd:workspace,sandbox:this.accessMode==='full'?'danger-full-access':mode==='implementation'?'workspace-write':'read-only',approvalPolicy:this.accessMode==='full'?'never':'on-request'};
    const result=await this.rpc.call(sessionId?'thread/resume':'thread/start',sessionId?{threadId:sessionId,excludeTurns:true,...params}:{...params,serviceName:'kanzo-global-bridge'});
    const id=result.thread.id;
    this.ownedSessions.add(id);
    if(!sessionId)return {sessionId:id,baseline:[],newSession:true};
    const turns=await this.rpc.call('thread/turns/list',{threadId:id,limit:1,sortDirection:'desc'});
    if(turns.data?.some(t=>t.status==='inProgress'))throw Error('Orchestrator session is busy');
    return {sessionId:id,baseline:(turns.data||[]).map(t=>t.id)};
  }
  async send(job,prompt){
    await this.connect();
    const result=await this.rpc.call('turn/start',{threadId:job.sessionId,clientUserMessageId:job.id,input:[{type:'text',text:prompt}],cwd:job.workspace,...(Schemas[job.mode]?{outputSchema:z.toJSONSchema(Schemas[job.mode])}:{})});
    const metadata={turnId:result.turn.id};
    if(job.newSession){metadata.sessionTitle=sessionLabel(job);try{await this.rpc.call('thread/name/set',{threadId:job.sessionId,name:metadata.sessionTitle});metadata.sessionTitlePending=false;}catch{metadata.sessionTitlePending=true;}}
    return metadata;
  }
  async replyApproval(job,requestId,fingerprint,decision){
    if(!['approve_once','decline'].includes(decision))throw Error('Unsupported approval decision');
    const request=this.rpc?.attention.get(job.sessionId)?.find(r=>r.id===requestId);
    if(!request)throw Error('Request is not pending on this live job');
    if(hash(request)!==fingerprint)throw Error('Request changed; inspect its current fingerprint');
    if(!job.turnId||request.params.turnId!==job.turnId)throw Error('Request belongs to another or unknown turn');
    let result;
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method))result={decision:decision==='approve_once'?'accept':'decline'};
    else if(request.method==='mcpServer/elicitation/request'){
      const p=request.params,s=p.requestedSchema;
      if(p.mode!=='form'||p._meta?.codex_approval_kind!=='mcp_tool_call'||s?.type!=='object'||!s.properties||Object.keys(s.properties).length||(s.required||[]).length||Object.keys(s).some(k=>!['type','properties','required','additionalProperties','$schema'].includes(k)))throw Error('Unsupported MCP form; only empty tool-approval forms can be relayed');
      result={action:decision==='approve_once'?'accept':'decline',content:decision==='approve_once'?{}:null};
    }else throw Error('Unsupported native approval request; use its native client');
    await this.rpc.reply(request,result);
  }
  async inspect(job){
    await this.connect();
    if(job.sessionTitlePending){try{await this.rpc.call('thread/name/set',{threadId:job.sessionId,name:job.sessionTitle});job.sessionTitlePending=false;}catch{/* Naming can retry without affecting the worker turn. */}}
    if(job.notificationViaQueue){
      let turnCursor;const turnCursors=new Set();
      do{
        const page=await this.rpc.call('thread/turns/list',{threadId:job.sessionId,limit:20,sortDirection:'desc',...(turnCursor?{cursor:turnCursor}:{})});
        for(const turn of page.data){
          // Another app's live turn can appear interrupted in a disk snapshot.
          // Only a durable completed acknowledgment is conclusive; never resend.
          if(turn.status!=='completed')continue;
          let matched=false,reply=null,cursor;const itemCursors=new Set();
          do{
            const p=await this.rpc.call('thread/items/list',{threadId:job.sessionId,turnId:turn.id,limit:100,...(cursor?{cursor}:{})});
            for(const {item} of p.data){
              if(item?.type==='userMessage'&&item.content?.some(c=>c.type==='text'&&c.text.includes(`Request: ${job.id}.`))){matched=true;reply=null;}
              else if(matched&&item?.type==='agentMessage'&&(!item.phase||item.phase==='final_answer'))reply=item;
            }
            cursor=p.nextCursor;if(cursor&&itemCursors.has(cursor))throw Error('Repeated item cursor during notification recovery');if(cursor)itemCursors.add(cursor);
          }while(cursor);
          if(!matched)continue;
          if(reply)return {status:'completed',text:reply.text,turnId:turn.id,pending:[]};
        }
        turnCursor=page.nextCursor;if(turnCursor&&turnCursors.has(turnCursor))throw Error('Repeated turn cursor during notification recovery');if(turnCursor)turnCursors.add(turnCursor);
      }while(turnCursor);
      return {status:'running',pending:[]};
    }
    // Reading persisted history also works after controller restart; no turn is resent.
    const key=`${job.sessionId}:${job.turnId}`;
    const live=this.rpc.turns?.get(key),liveItems=this.rpc.items?.get(key)||[];
    if(live?.status==='completed'&&liveItems.some(i=>i.type==='agentMessage'))return {status:'completed',text:liveItems.filter(i=>i.type==='agentMessage').at(-1).text,turnId:live.id,pending:[]};
    let page;
    try{page=await this.rpc.call('thread/turns/list',{threadId:job.sessionId,limit:10,sortDirection:'desc'});}
    catch(e){if(/not materialized|rollout .* is empty/.test(e.message))return {status:'running',pending:this.rpc.attention.get(job.sessionId)||[]};throw e;}
    const turn=job.turnId?page.data.find(t=>t.id===job.turnId):page.data.find(t=>!job.baseline?.includes(t.id));
    const pending=(this.rpc.attention.get(job.sessionId)||[]).map(r=>({...r,requestFingerprint:hash(r)}));
    if(!turn)return {status:'running',pending};
    if(turn.status==='inProgress')return {status:pending.length?'needs_attention':'running',pending,turnId:turn.id};
    let items=[],cursor;
    do{const p=await this.rpc.call('thread/items/list',{threadId:job.sessionId,turnId:turn.id,limit:100,...(cursor?{cursor}:{})});items.push(...p.data);cursor=p.nextCursor;}while(cursor);
    const text=items.map(e=>e.item).filter(i=>i?.type==='agentMessage').at(-1)?.text||'';
    return {status:turn.status==='completed'?'completed':'failed',text,error:turn.error,turnId:turn.id,pending};
  }
  async cancel(job){
    if(job.notificationViaQueue)throw Error('A queued notification cannot be unsent; resolve it in the bound chat before recovery');
    await this.connect();
    if(!job.turnId){
      const page=await this.rpc.call('thread/turns/list',{threadId:job.sessionId,limit:100,sortDirection:'desc'});
      const matches=[];
      for(const turn of page.data.filter(t=>!job.baseline?.includes(t.id))){
        const p=await this.rpc.call('thread/items/list',{threadId:job.sessionId,turnId:turn.id,limit:100});
        if(p.data.some(e=>e.item?.type==='userMessage'&&e.item.content?.some(c=>c.type==='text'&&c.text.includes(`Request: ${job.id}.`))))matches.push(turn);
      }
      if(matches.length!==1)throw Error('Cannot resolve unknown Codex turn; workspace remains locked until its outcome is identified');
      job.turnId=matches[0].id;
      if(matches[0].status!=='inProgress')return;
    }
    const page=await this.rpc.call('thread/turns/list',{threadId:job.sessionId,limit:100,sortDirection:'desc'});
    const before=page.data.find(t=>t.id===job.turnId);if(before&&before.status!=='inProgress')return;
    await this.rpc.call('turn/interrupt',{threadId:job.sessionId,turnId:job.turnId});
    for(let attempt=0;attempt<20;attempt++){
      const current=await this.rpc.call('thread/turns/list',{threadId:job.sessionId,limit:100,sortDirection:'desc'});
      const turn=current.data.find(t=>t.id===job.turnId);if(turn&&turn.status!=='inProgress')return;
      await new Promise(r=>setTimeout(r,250));
    }
    throw Error('Codex interruption is not confirmed; workspace remains locked');
  }
  async close(){await this.rpc?.close();this.rpc=null;}
}
