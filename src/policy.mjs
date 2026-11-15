import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const taskId = task => `${task.project}#${task.id}`;
export const tags = task => (task.tags || []).map(t=>t.toLowerCase());
export const validTaskId = value => /^[a-z0-9][a-z0-9-]*#[1-9]\d*$/.test(value);
export function owner(task) {
  if(tags(task).some(t=>t.startsWith('owner:')&&!['owner:codex','owner:opencode','owner:opencode-glm-5.3'].includes(t)))throw Error('Unsupported owner; explicit ownership is reserved and will not be reassigned');
  const found=[...new Set(tags(task).filter(t=>['owner:codex','owner:opencode','owner:opencode-glm-5.3'].includes(t)).map(t=>t==='owner:codex'?'codex':'opencode'))];
  if(found.length>1) throw Error('Conflicting task owners');
  return found[0] || null;
}
export function eligibility(task) {
  return !task.human && !['doing','done'].includes(task.status) && (task.status==='todo'||tags(task).includes('ready'));
}
export function dependencies(task) {
  const structured=task.dependencies ?? task.waits_for;
  const line=task.description?.match(/^Dependencies:\s*([^\n]*)/im)?.[1]?.trim();
  const refs=[];
  for(const input of [structured,line]){
    if(input==null || input==='' || /^(none|no|n\/a)[.!]?$/i.test(String(input)))continue;
    const parsed=Array.isArray(input)?input.map(d=>typeof d==='object'?`${d.project}#${d.id}`:String(d)):String(input).replace(/[.]$/,'').split(/[,\s]+/).filter(Boolean);
    if(!parsed.every(validTaskId))throw Error('Malformed dependencies; use full project#number references');refs.push(...parsed);
  }
  return [...new Set(refs)];
}
export function taskFingerprint(task) {
  return hash({id:taskId(task),title:task.title,description:task.description||'',human:!!task.human,tags:(task.tags||[]).filter(t=>t.toLowerCase()!=='ready').map(t=>t.toLowerCase()).sort(),dependencies:dependencies(task)});
}
export function needsHuman(task) { return !!task.human || tags(task).includes('review:human'); }
export function safe(text) {
  return String(text).replace(/\bBearer\s+\S+/gi,'Bearer [redacted]').replace(/\b(sk-[\w-]{12,}|(?:api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+)/gi,'[redacted]');
}
