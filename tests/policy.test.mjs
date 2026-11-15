import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibility, owner, dependencies, taskFingerprint } from '../src/policy.mjs';
const task = (v={}) => ({id:1,project:'app',title:'Build widget',description:'Acceptance: renders widget',tags:[],status:'todo',human:false,...v});
test('Todo OR ready admits work, excludes humans, active and done work', () => {
  assert.equal(eligibility(task()), true);
  assert.equal(eligibility(task({status:'review',tags:['ready']})), true);
  for(const v of [{status:'review'}, {status:'doing',tags:['ready']},{status:'done',tags:['ready']},{human:true}]) assert.equal(eligibility(task(v)),false);
});
test('ownership is exact, rejects conflicts and ignores prose/proposed owners', () => {
  assert.equal(owner(task({tags:['owner:opencode']})),'opencode');
  assert.equal(owner(task({tags:['OWNER:CODEX']})),'codex');
  assert.equal(owner(task({tags:['proposed-owner:codex'],description:'owner:codex'})),null);
  assert.throws(()=>owner(task({tags:['owner:codex','owner:opencode']})),/Conflicting/);
});
test('cross-project dependencies are validated rather than silently ignored', () => {
  assert.deepEqual(dependencies(task({description:'Dependencies: api#2, web#3\nAcceptance: ok'})),['api#2','web#3']);
  assert.deepEqual(dependencies(task({description:'Dependencies: None.'})),[]);
  assert.throws(()=>dependencies(task({description:'Dependencies: next week'})),/Malformed/);
  assert.equal(taskFingerprint(task()),taskFingerprint(task({comments:88,updated_at:'later'})));
  assert.notEqual(taskFingerprint(task()),taskFingerprint(task({description:'changed'})));
});
test('native and explicit dependency references both constrain readiness',()=>{
  assert.deepEqual(dependencies(task({dependencies:['api#2'],description:'Dependencies: web#3'})),['api#2','web#3']);
});
test('explicit ownership by another agent is never treated as unowned work',()=>{
  assert.throws(()=>owner(task({tags:['owner:claude']})),/Unsupported owner/);
  assert.throws(()=>owner(task({tags:['owner:human']})),/Unsupported owner/);
});
