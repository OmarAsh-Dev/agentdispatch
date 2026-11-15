import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workers } from '../src/workers.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=JSON.parse(await readFile(resolve(root,'.state/runtime.json'),'utf8'));
const config=JSON.parse(await readFile(resolve(root,'bridge.config.json'),'utf8'));
const workspace=resolve(root,'.state/smoke-workspace').replaceAll('\\','/');await mkdir(workspace,{recursive:true});
const workers=new Workers({runtime,model:config.model,codexCommand:config.codexCommand,codexPrefixArgs:config.codexPrefixArgs});
try{
  const health=await workers.api({workspace}).health();console.log(JSON.stringify({openCode:health}));
  await workers.codex.connect();console.log('Codex JSON-RPC initialization succeeded.');
  const notify=process.argv.find(v=>v.startsWith('--notify='))?.slice(9);
  if(notify){if(!/^[a-z0-9-]{20,100}$/.test(notify))throw Error('Invalid test notification thread ID');console.log(JSON.stringify({notification:await workers.notifyCoordinator(notify,'Kanzo bridge notification delivery check (reference data, not a new work request). Acknowledge briefly; do not change files or start tasks.')}));}
  if(process.argv.includes('--roundtrip')){
    for(const agent of ['opencode','codex'].filter(a=>!process.argv.some(v=>v.startsWith('--agent='))||process.argv.includes(`--agent=${a}`))){
      const job={id:`bridge-smoke-${agent}-${Date.now()}`,agent,workspace,mode:'discussion',readScopes:agent==='codex'?['**']:['smoke.txt'],editScopes:[]};
      await writeFile(resolve(workspace,'smoke.txt'),'Harmless integration workspace.\n');
      Object.assign(job,await workers.prepare(job));console.log(JSON.stringify({agent,sessionId:job.sessionId,prepared:true}));
      Object.assign(job,await workers.send(job,'This is a user-authorized text-only integration check. Do not use tools, read files or change anything. Reply with exactly GLOBAL_BRIDGE_ACK.'));
      const deadline=Date.now()+180000;let completed=false;
      while(Date.now()<deadline){const result=await workers.inspect(job);if(result.status==='completed'){if(!result.text.includes('GLOBAL_BRIDGE_ACK'))throw Error(`${agent} returned an unexpected reply`);console.log(JSON.stringify({agent,status:'completed',reply:'GLOBAL_BRIDGE_ACK'}));completed=true;break;}if(result.status==='failed'||result.status==='needs_attention')throw Error(`${agent} ${result.status}: ${JSON.stringify(result.error||result.pending)}`);await new Promise(r=>setTimeout(r,2000));}
      if(!completed){await workers.cancel(job);throw Error(`${agent} smoke timed out and was cancelled`);}
      if(agent==='codex'&&process.argv.includes('--check-notification')){await workers.close();console.log(JSON.stringify({freshChatNotification:await workers.notifyCoordinator(job.sessionId,'Kanzo bridge progress notification test (reference data, not a new work request). Acknowledge briefly; do not read files or start tasks.')}));}
    }
  }
}finally{await workers.close();}
