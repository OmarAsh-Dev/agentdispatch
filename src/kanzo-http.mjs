import { z } from 'zod';
import { validTaskId, safe } from './policy.mjs';
const Task=z.object({id:z.number().int().positive(),project:z.string().regex(/^[a-z0-9][a-z0-9-]*$/),title:z.string(),description:z.string().default(''),tags:z.array(z.string()),status:z.string(),human:z.boolean()}).passthrough();
export class KanzoHttp {
  constructor(url='http://localhost:4242/#all',fetchFn=fetch) {
    const parsed=new URL(url);
    if(parsed.protocol!=='http:'||!['localhost','127.0.0.1'].includes(parsed.hostname)||parsed.username||parsed.password)throw Error('Kanzo must use numeric/localhost loopback HTTP');
    this.url=parsed.origin;this.fetch=fetchFn;
  }
  async request(path,method='GET',body) {
    const res=await this.fetch(`${this.url}${path}`,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!res.ok)throw Error(`Kanzo ${method} failed (HTTP ${res.status})`);
    return res.json();
  }
  async snapshot(){const v=await this.request('/api/board?project=all&done=all');return {...v,tasks:z.array(Task).parse(v.tasks)};}
  async get(id) {
    if(!validTaskId(id))throw Error('Invalid task ID');
    const [project,number]=id.split('#');const v=await this.request(`/api/tasks/${number}`);const t=Task.parse(v.task);
    if(t.project!==project)throw Error('Task project mismatch');
    const native=(v.waits_on||[]).map(d=>typeof d==='string'?d:`${d.project}#${d.id}`);
    return {...t,...(native.length?{dependencies:native}:{}),commentsData:v.comments||[]};
  }
  async update(id,patch){await this.get(id);const value={...patch};if(Array.isArray(value.tags))value.tags=value.tags.join(',');if(value.status==='done')throw Error('Controller cannot mark Done');return this.request(`/api/tasks/${id.split('#')[1]}`,'PATCH',value);}
  async comment(id,body,marker) {
    const t=await this.get(id);
    if(marker&&t.commentsData.some(c=>c.body?.includes(`[bridge:${marker}]`)))return;
    return this.request(`/api/tasks/${t.id}/comments`,'POST',{body:`Agent bridge\n${safe(body).slice(0,16000)}${marker?`\n[bridge:${marker}]`:''}`});
  }
  create(project,title,description){return this.request('/api/tasks','POST',{project,title,description});}
  async ensureProject(project){const b=await this.snapshot();if(!b.projects.some(p=>p.slug===project))await this.request('/api/projects','POST',{slug:project,name:project});}
}
