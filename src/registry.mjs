import { mkdir, readFile, writeFile, rename, realpath, stat, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, parse } from 'node:path';
export class FileStore {
  constructor(path,initial={}) { this.path=path;this.initial=initial; }
  async load() {try{return JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code==='ENOENT')return structuredClone(this.initial);throw e;}}
  async save(value) {
    await mkdir(dirname(this.path),{recursive:true});
    const temp=`${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});
    await rename(temp,this.path);
  }
}
export async function canonicalWorkspace(workspace) {
  if(typeof workspace!=='string'||!isAbsolute(workspace))throw Error('Workspace must be an absolute directory');
  const resolved=await realpath(workspace);
  if(resolved===parse(resolved).root)throw Error('A drive/filesystem root cannot be a project');
  if(!(await stat(resolved)).isDirectory())throw Error('Workspace must be a directory');
  return resolved.replaceAll('\\','/');
}
export const workspaceKey = value => process.platform==='win32'?value.toLowerCase():value;
export class Registry {
  constructor(store){this.store=store;}
  async init(){this.state=await this.store.load();this.state.projects??={};}
  get(project){const result=this.state.projects[project];if(!result)throw Error(`Unregistered project: ${project}`);return structuredClone(result);}
  list(){return structuredClone(Object.values(this.state.projects));}
  async start({project,workspace,agent,sessionId=null,readScopes=['**'],editScopes=['**']}) {
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(project))throw Error('Invalid project slug');
    if(!['codex','opencode'].includes(agent))throw Error('Invalid orchestrator agent');
    workspace=await canonicalWorkspace(workspace);
    const previous=this.state.projects[project];
    if(previous && workspaceKey(previous.workspace)!==workspaceKey(workspace))throw Error('Project already bound to another workspace');
    if(previous?.orchestrator)return this.get(project);
    for(const scope of [...readScopes,...editScopes])if(typeof scope!=='string'||scope.startsWith('/')||scope.includes('..')||scope.includes(':')||scope.includes('\\'))throw Error('Scopes must be project-relative globs without traversal');
    this.state.projects[project]={project,workspace,readScopes,editScopes,orchestrator:{agent,sessionId,revision:1,source:'first-start'},history:[]};
    await this.store.save(this.state);return this.get(project);
  }
  async assign({project,agent,sessionId=null}) {
    if(!['codex','opencode'].includes(agent))throw Error('Invalid orchestrator agent');
    const previous=this.get(project);
    previous.history.push({...previous.orchestrator,replacedAt:new Date().toISOString()});
    previous.orchestrator={agent,sessionId,revision:previous.orchestrator.revision+1,source:'explicit-assignment'};
    this.state.projects[project]=previous;await this.store.save(this.state);return this.get(project);
  }
  async bindSession(project,revision,sessionId) {
    const p=this.state.projects[project];if(!p || p.orchestrator.revision!==revision)return false;
    p.orchestrator.sessionId=sessionId;await this.store.save(this.state);return true;
  }
}
export async function acquireLock(path) {
  await mkdir(dirname(path),{recursive:true});
  // Never delete a live or ambiguous lock; a verified dead process may be recovered.
  for(let attempt=0;attempt<2;attempt++){
    try{const fd=await open(path,'wx',0o600);await fd.writeFile(String(process.pid));await fd.close();return async()=>{if((await readFile(path,'utf8'))===String(process.pid))await unlink(path);};}
    catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await readFile(path,'utf8'));if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid service lock; inspect it manually');try{process.kill(pid,0);throw Error(`Service already running (${pid})`);}catch(check){if(check.code!=='ESRCH')throw check;await unlink(path);}}
  }
  throw Error('Unable to acquire service lock');
}
