import test from 'node:test';
import assert from 'node:assert/strict';
import { codexFullAccessEdits, openCodeFullAccessConfig } from '../src/access-config.mjs';
test('Codex full-access edits include configured tool overrides without changing credentials or model',()=>{
  const config={model:'preserve',mcp_servers:{kanzo:{tools:{get_task:{approval_mode:'prompt'}}}},apps:{_default:{},drive:{tools:{search:{approval_mode:'prompt'}}}},plugins:{'example@official':{mcp_servers:{example:{tools:{read:{approval_mode:'prompt'}}}}}}};
  const edits=codexFullAccessEdits(config);const paths=edits.map(e=>e.keyPath);
  assert.ok(edits.some(e=>e.keyPath==='sandbox_mode'&&e.value==='danger-full-access'));
  assert.ok(edits.some(e=>e.keyPath==='approval_policy'&&e.value==='never'));
  assert.ok(paths.includes('mcp_servers."kanzo".tools."get_task".approval_mode'));
  assert.ok(paths.includes('apps."drive".tools."search".approval_mode'));
  assert.ok(paths.includes('plugins."example@official".mcp_servers."example".tools."read".approval_mode'));
  assert.ok(!paths.some(p=>/model|auth|token|provider/.test(p)));assert.equal(config.model,'preserve');
});
test('Codex named-permission configuration uses its supported full profile without conflicting sandbox keys',()=>{
  const edits=codexFullAccessEdits({default_permissions:':workspace'});
  assert.ok(edits.some(e=>e.keyPath==='default_permissions'&&e.value===':danger-full-access'));
  assert.ok(!edits.some(e=>e.keyPath==='sandbox_mode'));
});
test('OpenCode full-access config preserves providers and makes configured/builtin agents permissive',()=>{
  const before={provider:{custom:{options:{apiKey:'preserve-without-printing'}}},mcp:{existing:{}},agent:{custom:{description:'keep',permission:'ask'}}};
  const after=openCodeFullAccessConfig(before);assert.equal(after.permission,'allow');assert.equal(after.agent.plan.permission,'allow');assert.equal(after.agent.custom.permission,'allow');assert.equal(after.agent.custom.description,'keep');assert.deepEqual(after.provider,before.provider);assert.deepEqual(after.mcp,before.mcp);assert.equal(before.agent.custom.permission,'ask');
});
