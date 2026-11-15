import test from 'node:test';
import assert from 'node:assert/strict';
import { startBridgeHttp } from '../src/server.mjs';
import { callDesktopTool } from '../scripts/desktop-client.mjs';

test('desktop goal submissions release their MCP sessions and keep the request ID', async t => {
  const bridge = {
    async poll() {},
    async submitGoal(args) { return { ...args, status: 'queued' }; },
  };
  const service = await startBridgeHttp({ bridge, token: 'test-token', port: 0 });
  t.after(() => service.close());
  const runtime = { bridgeUrl: service.url, bridgeToken: 'test-token' };
  const input = { project: 'example', request_id: 'desktop-test', goal: 'Merge two PDFs.' };
  for (let i = 0; i < 34; i++) {
    const result = await callDesktopTool(runtime, 'orchestrator_goal', input);
    assert.equal(result.status, 'queued');
    assert.equal(result.request_id, input.request_id);
  }
});
