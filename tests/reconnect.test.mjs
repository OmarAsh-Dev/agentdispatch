import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectableClient } from '../src/reconnect.mjs';

test('reinitializes after daemon session loss and retries the same operation once', async () => {
  let creations = 0;
  const client = new ReconnectableClient(async () => {
    const ordinal = ++creations;
    return { async close() {}, async callTool(args) { if (ordinal === 1) throw Object.assign(Error('Session not found'),{code:404}); return args; } };
  });
  const args = { name:'opencode_send',arguments:{request_id:'stable-intent'} };
  assert.deepEqual(await client.run(c=>c.callTool(args)),args);
  assert.equal(creations,2);
  await client.close();
});

test('does not retry ambiguous network failures or approval rejections', async () => {
  let calls = 0;
  const client = new ReconnectableClient(async () => ({async close(){},async callTool(){calls++;throw Error('Network outcome unknown');}}));
  await assert.rejects(client.run(c=>c.callTool({})),/unknown/);
  assert.equal(calls,1);
});
