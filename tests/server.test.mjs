import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startBridgeHttp } from '../src/server.mjs';

test('authenticated MCP tools work while unauthenticated/browser requests are rejected', async t => {
  let polls = 0;
  const bridge = {
    async health() { return { healthy: true, model: 'test-glm' }; },
    async poll() { polls++; },
    async send(args) { return { id: 'job1', ...args }; },
    get(id) { return { id, status: 'completed' }; },
    list() { return []; },
    async wait(id) { return this.get(id); },
    async answer(id) { return this.get(id); },
    async cancel(id) { return this.get(id); },
    async startProject(args) { return {project:args.project,orchestrator:{agent:args.agent}}; },
    async assignOrchestrator(args) { return args; },
    async submitGoal(args) { return args; },
    status() { return {projects:[]}; },
    async replyApproval(args) { return args; },
  };
  const service = await startBridgeHttp({ bridge, token: 'test-token', port: 0, pollIntervalMs: 20 });
  t.after(() => service.close());
  assert.equal((await fetch(service.url)).status, 401);
  assert.equal((await fetch(service.url, { headers: { authorization: 'Bearer test-token', origin: 'https://evil.example' } })).status, 403);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { authorization: 'Bearer test-token' } } }));
  const names = (await client.listTools()).tools.map(t => t.name);
  assert.ok(['project_start','orchestrator_assign','orchestrator_goal','bridge_status','opencode_send'].every(name=>names.includes(name)));
  const reply = await client.callTool({ name: 'opencode_send', arguments: { task_id: 'example-app#48', message: 'hello', request_id: 'test-one' } });
  assert.equal(JSON.parse(reply.content[0].text).id, 'job1');
  const global = await client.callTool({ name: 'opencode_send', arguments: { task_id: 'kec#1', message: 'hello', request_id: 'test-two' } });
  assert.equal(JSON.parse(global.content[0].text).task_id,'kec#1');
  const started = await client.callTool({name:'project_start',arguments:{project:'app',workspace:'D:/Projects/app',agent:'codex'}});
  assert.equal(JSON.parse(started.content[0].text).orchestrator.agent,'codex');
  const approval=await client.callTool({name:'bridge_reply_codex_approval',arguments:{job_id:'job1',request_id:0,request_fingerprint:'a'.repeat(64),decision:'approve_once',user_confirmed:true}});
  assert.equal(JSON.parse(approval.content[0].text).request_id,0);
  const bad = await client.callTool({ name: 'opencode_send', arguments: { task_id: '../bad#1', message: 'hello', request_id: 'test-bad' } });
  assert.equal(bad.isError, true);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.ok(polls >= 1, 'background polling runs without another tool call');
});
