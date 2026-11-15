import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenCodeApi } from '../src/adapters.mjs';

test('OpenCode adapter scopes requests, pins the model, and normalizes replies/questions', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = []; for await (const chunk of req) parts.push(chunk);
    requests.push({ path: url.pathname, directory: url.searchParams.get('directory'), auth: req.headers.authorization, body: parts.length ? JSON.parse(Buffer.concat(parts)) : undefined });
    res.setHeader('content-type', 'application/json');
    const values = {
      '/global/health': { healthy: true, version: 'test' },
      '/provider': { connected: ['example-provider'], all: [{ id: 'example-provider', models: { 'example-model': { id: 'example-model' } } }] },
      '/session': { id: 'ses_test' },
      '/session/status': {},
      '/session/ses_test/message': [{ info: { id: 'reply', role: 'assistant', time: { completed: 123 }, modelID: 'example-model', providerID: 'example-provider', finish: 'stop' }, parts: [{ type: 'text', text: 'reply' }] }],
      '/permission': [],
      '/question': [{ id: 'q1', sessionID: 'ses_test', questions: [{ question: 'Which variant?' }] }],
      '/session/ses_test/abort': true,
      '/question/q1/reject': true,
    };
    if (url.pathname.endsWith('/prompt_async')) { res.writeHead(204).end(); return; }
    if (!(url.pathname in values)) { res.writeHead(404).end('{}'); return; }
    res.end(JSON.stringify(values[url.pathname]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const api = new OpenCodeApi({ url: `http://127.0.0.1:${server.address().port}`, password: 'test-password', workspace: 'D:/Projects/Example', model: { providerID: 'example-provider', modelID: 'example-model' } });
  assert.equal((await api.health()).healthy, true);
  await api.createSession('test', 'discussion');
  await api.send('ses_test', 'hello', { providerID: 'example-provider', modelID: 'example-model' }, 'discussion');
  const result = await api.inspect('ses_test');
  assert.equal(result.messages[0].text, 'reply');
  assert.equal(result.messages[0].completed, true);
  assert.equal(result.pending[0].type, 'question');
  assert.ok(requests.every(r => r.directory === 'D:/Projects/Example'));
  assert.ok(requests.every(r => r.auth === 'Basic '+Buffer.from('opencode:test-password').toString('base64')));
  const prompt = requests.find(r => r.path.endsWith('/prompt_async'));
  assert.equal(prompt.body.model.modelID, 'example-model');
  assert.equal(prompt.body.agent, 'plan');
  assert.ok(requests.find(r => r.path === '/session').body.permission.some(r => r.permission === 'bash' && r.action === 'deny'));
  const permissions = requests.find(r => r.path === '/session').body.permission;
  assert.ok(permissions.some(r => r.permission === 'read' && r.action === 'allow' && r.pattern === 'Projects\\Example\\dashboard\\**'), 'Windows permissions must include the approved dashboard drive-relative scope');
  assert.ok(permissions.some(r => r.permission === 'read' && r.action === 'allow' && r.pattern === 'Projects\\Example'), 'Allow listing the project root so OpenCode can resolve explicitly approved files');
  assert.ok(permissions.some(r => r.permission === 'read' && r.action === 'allow' && r.pattern === 'dashboard\\**'), 'Approved reads must also match project-relative Windows requests');
  assert.ok(permissions.some(r => r.permission === 'read' && r.action === 'allow' && r.pattern === 'backend/openapi.yaml'), 'Only the approved backend contract is allowed in project-relative form');
  assert.ok(!permissions.some(r => r.permission === 'read' && r.action === 'allow' && r.pattern === 'Projects\\Example\\**'), 'Do not automatically share all project files');
  assert.ok(permissions.some(r => r.permission === 'read' && r.action === 'deny' && r.pattern === '**\\.state\\**'));
  for (const permission of ['glob', 'grep', 'list']) {
    assert.equal(permissions.filter(rule => rule.permission === permission).at(-1)?.action, 'deny', 'Use direct approved file reads without broad search permission prompts');
  }
  await api.abort('ses_test');
  assert.ok(requests.some(r => r.path === '/question/q1/reject'), 'Cancellation must clear pending questions so they cannot block a later message');
});

test('model unavailable fails explicitly and does not substitute another model', async () => {
  const api = new OpenCodeApi({ url: 'http://127.0.0.1:4096', password: 'x', workspace: 'D:/Projects/Example', model: { providerID: 'example-provider', modelID: 'example-model' }, fetchFn: async url => new Response(JSON.stringify(url.includes('/provider') ? { connected: [], all: [] } : { healthy: true })) });
  await assert.rejects(api.health(), /configured OpenCode model/);
});

test('truncated model output is a failure, not a completed implementation', async () => {
  const api = new OpenCodeApi({ url:'http://127.0.0.1:4096',password:'x',workspace:'D:/Projects/Example',model:{providerID:'example-provider',modelID:'example-model'},fetchFn:async raw=>{
    const path=new URL(raw).pathname;
    if(path.endsWith('/message')) return Response.json([{info:{id:'msg1',role:'assistant',finish:'length',time:{completed:1}},parts:[]}]);
    return Response.json(path==='/session/status'?{}:[]);
  }});
  const result=await api.inspect('ses_test');
  assert.equal(result.messages[0].error?.code,'MODEL_OUTPUT_LIMIT');
});
