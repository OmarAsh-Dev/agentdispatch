import { CodexWorker } from '../src/codex-worker.mjs';
const w=new CodexWorker();
try{await w.connect();for(const method of ['windowsSandbox/readiness','configRequirements/read']){try{console.log(JSON.stringify({method,result:await w.rpc.call(method,{})}));}catch(e){console.log(JSON.stringify({method,error:e.message}));}}
if(process.argv.includes('--setup')){
  const completion=new Promise(resolve=>{w.rpc.onNotification=m=>{if(m.method==='windowsSandbox/setupCompleted')resolve(m.params);};});
  const started=await w.rpc.call('windowsSandbox/setupStart',{mode:'elevated',cwd:process.cwd()});console.log(JSON.stringify({setup:started}));
  if(started.started){const result=await Promise.race([completion,new Promise(resolve=>setTimeout(()=>resolve({error:'Setup still pending after 120 seconds'}),120000))]);console.log(JSON.stringify({setupCompleted:result}));}
}
const result=await w.rpc.call('command/exec',{command:['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','-NoProfile','-Command','Write-Output GLOBAL_SANDBOX_CHECK'],cwd:process.cwd(),sandboxPolicy:{type:'readOnly'},timeoutMs:10000});console.log(JSON.stringify({sandboxCommand:result}));}finally{await w.close();}
