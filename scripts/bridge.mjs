import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile);
const [command='status',...args]=process.argv.slice(2);
async function call(name,input){
  const client=new Client({name:'global-bridge-cli',version:'2.0.0'});
  try{await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve(root,'scripts/mcp-launcher.mjs')],cwd:root,stderr:'pipe'}));const result=await client.callTool({name,arguments:input},undefined,{timeout:65000});const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');if(result.isError)throw Error(text);return JSON.parse(text);}finally{await client.close();}
}
try{
  if(command==='status'){console.log(JSON.stringify(await call('bridge_status',{}),null,2));}
  else if(command==='start'){await run(process.execPath,[resolve(root,'scripts/start-opencode.mjs')],{cwd:root,windowsHide:true}).catch(()=>{});await run(process.execPath,[resolve(root,'scripts/start-codex.mjs')],{cwd:root,windowsHide:true}).catch(()=>{});const r=await run(process.execPath,[resolve(root,'scripts/start-bridge.mjs')],{cwd:root,windowsHide:true});console.log(r.stdout.trim());}
  else if(['start-project','launch'].includes(command)){
    const [agent,project,workspace]=args;if(!['codex','opencode'].includes(agent)||!project||!workspace)throw Error('Usage: bridge start-project|launch codex|opencode PROJECT ABSOLUTE_WORKSPACE');
    console.log(JSON.stringify(await call('project_start',{agent,project,workspace}),null,2));
    if(command==='launch'){
      const config=JSON.parse(await readFile(resolve(root,'bridge.config.json'),'utf8'));
      const exe=agent==='codex'?(config.codexCommand||'codex'):resolve(root,'node_modules/opencode-windows-x64/bin/opencode.exe');
      const child=spawn(exe,agent==='codex'?[...(config.codexPrefixArgs||[]),'-C',workspace]:[workspace],{cwd:workspace,stdio:'inherit',windowsHide:false});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code||0;});
    }
  }
  else if(command==='assign'){const [project,agent,sessionId]=args;console.log(JSON.stringify(await call('orchestrator_assign',{project,agent,...(sessionId?{sessionId}:{})}),null,2));}
  else if(command==='goal'){const [project,request_id,goalFile]=args;if(!goalFile)throw Error('Usage: bridge goal PROJECT STABLE_REQUEST_ID GOAL_TEXT_FILE');console.log(JSON.stringify(await call('orchestrator_goal',{project,request_id,goal:await readFile(resolve(goalFile),'utf8')}),null,2));}
  else if(command==='cancel'){console.log(JSON.stringify(await call('opencode_cancel',{job_id:args[0]}),null,2));}
  else if(command==='retry-review'){console.log(JSON.stringify(await call('bridge_retry_review',{task_id:args[0]}),null,2));}
  else if(command==='resume-goal'){console.log(JSON.stringify(await call('orchestrator_resume_goal',{goal_id:args[0]}),null,2));}
  else if(command==='cancel-goal'){console.log(JSON.stringify(await call('orchestrator_cancel_goal',{goal_id:args[0]}),null,2));}
  else if(command==='retry-notification'){console.log(JSON.stringify(await call('bridge_retry_notification',{key:args[0],destination:args[1]||'orchestrator',confirm_unknown:args.includes('--confirm-duplicate-risk')}),null,2));}
  else if(command==='stop'){
    // Validate the PID's real command via PowerShell before stopping our service.
    const {stdout}=await run('powershell.exe',['-NoProfile','-File',resolve(root,'scripts/stop.ps1'),'-Root',root],{windowsHide:true});console.log(stdout.trim());
  }
  else throw Error('Commands: status, start, stop, start-project, launch, assign, goal, cancel, retry-review, resume-goal, cancel-goal, retry-notification');
}catch(e){console.error(e.message);process.exitCode=1;}
