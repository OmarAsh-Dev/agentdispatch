import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, StateStore, validateBaseUrl } from '../src/core.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kanzo-bridge-'));
  const calls = [];
  const messages = [];
  let pending = [];
  let failBoard = false;
  const api = {
    async health() { return { healthy: true }; },
    async createSession() { calls.push('create'); return { id: 'ses_test' }; },
    async send(session, text) { calls.push({ session, text }); },
    async inspect() { return { messages, pending, busy: false }; },
  };
  const board = {
    async get(id) { return `${id} [todo] Test {proposed-owner:opencode}\nDependencies: None.`; },
    async comment(id, body) { if (failBoard) throw Error('board offline'); calls.push({ comment: id, body }); },
    async status(id, status) { calls.push({ task: id, status }); },
  };
  const store = new StateStore(join(dir, 'state.json'));
  const bridge = new Bridge({ api, board, store, model: { providerID: 'example-provider', modelID: 'example-model' } });
  await bridge.init();
  return { bridge, api, board, store, calls, messages, setPending(v) { pending = v; }, setFailBoard(v) { failBoard = v; } };
}

test('only numeric-loopback HTTP endpoints are accepted', () => {
  assert.equal(validateBaseUrl('http://127.0.0.1:4096'), 'http://127.0.0.1:4096');
  for (const url of ['https://example.com', 'http://localhost.evil:4096', 'http://127.0.0.1:4096/path', 'http://user:pass@127.0.0.1:4096']) {
    assert.throws(() => validateBaseUrl(url));
  }
});

test('rejects other projects before any external side effect', async () => {
  const f = await fixture();
  await assert.rejects(f.bridge.send({ task_id: 'kec#1', message: 'hello', request_id: 'one' }), /example-app/);
  assert.equal(f.calls.length, 0);
});

test('discussion sends a prompt and records its actual model without starting a task', async () => {
  const f = await fixture();
  const job = await f.bridge.send({ task_id: 'example-app#48', message: 'acknowledge only', request_id: 'one' });
  assert.equal(job.sessionId, 'ses_test');
  assert.equal(job.status, 'running');
  assert.equal(job.model.modelID, 'example-model');
  assert.ok(f.calls.some(c => c.text?.includes('acknowledge only')));
  assert.ok(f.calls.some(c => c.comment === 'example-app#48'));
  assert.ok(!f.calls.some(c => c.status === 'doing'));
});

test('request id retries are idempotent and simultaneous requests cannot share an active task', async () => {
  const f = await fixture();
  const first = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  const replay = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  assert.equal(first.id, replay.id);
  await assert.rejects(f.bridge.send({ task_id: 'example-app#48', message: 'different', request_id: 'one' }), /different payload/);
  await assert.rejects(f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'two' }), /active/);
  assert.equal(f.calls.filter(c => c.text).length, 1);
});

test('implementation respects ownership and dependencies', async () => {
  const f = await fixture();
  f.board.get = async () => 'example-app#32 [todo] {proposed-owner:codex}\nDependencies: None.';
  await assert.rejects(f.bridge.send({ task_id: 'example-app#32', message: 'implement', request_id: 'one', mode: 'implementation' }), /owner/);
  f.board.get = async id => id.endsWith('#34') ? 'example-app#34 [todo] {proposed-owner:opencode}\nDependencies: example-app#32.' : 'example-app#32 [todo]';
  await assert.rejects(f.bridge.send({ task_id: 'example-app#34', message: 'implement', request_id: 'two', mode: 'implementation' }), /dependency/);
});

test('receives only new assistant replies and updates Kanzo once', async () => {
  const f = await fixture();
  f.messages.push({ id: 'old', role: 'assistant', completed: true, text: 'old result' });
  const job = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  await f.bridge.poll();
  assert.equal(f.bridge.get(job.id).status, 'running');
  f.messages.push({ id: 'reply', role: 'assistant', completed: true, text: 'Bridge acknowledged', modelID: 'example-model', providerID: 'example-provider' });
  await f.bridge.poll();
  await f.bridge.poll();
  assert.equal(f.bridge.get(job.id).status, 'completed');
  assert.equal(f.calls.filter(c => c.body?.includes('Bridge acknowledged')).length, 1);
  assert.ok(!f.calls.some(c => c.status === 'done'));
});

test('unavailable Kanzo blocks dispatch and completion synchronization retries safely', async () => {
  const f = await fixture();
  f.setFailBoard(true);
  await assert.rejects(f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' }), /board offline/);
  assert.equal(f.calls.filter(c => c.text).length, 0);
  f.setFailBoard(false);
  const job = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'two' });
  f.messages.push({ id: 'reply', role: 'assistant', completed: true, text: 'reply' });
  f.setFailBoard(true);
  await f.bridge.poll();
  assert.equal(f.bridge.get(job.id).status, 'running');
  f.setFailBoard(false);
  await f.bridge.poll();
  assert.equal(f.bridge.get(job.id).status, 'completed');
});

test('permission requests surface as attention and are never auto-approved', async () => {
  const f = await fixture();
  const job = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  f.setPending([{ type: 'permission', id: 'perm1', message: 'Allow edit?' }]);
  await f.bridge.poll();
  assert.equal(f.bridge.get(job.id).status, 'needs_attention');
  assert.equal(f.bridge.get(job.id).pending[0].type, 'permission');
  assert.ok(f.calls.some(c => c.body?.includes('attention')));
});

test('ambiguous prompt timeout remains inspectable and does not resend', async () => {
  const f = await fixture();
  f.api.send = async () => { f.calls.push('send-timeout'); throw Error('timeout'); };
  const job = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  assert.equal(job.status, 'unknown');
  await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  assert.equal(f.calls.filter(c => c === 'send-timeout').length, 1);
});

test('pending jobs survive restart and a follow-up reuses the task session', async () => {
  const f = await fixture();
  const first = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  const restored = new Bridge({ api: f.api, board: f.board, store: f.store, model: first.model });
  await restored.init();
  assert.equal(restored.get(first.id).sessionId, first.sessionId);
  f.messages.push({ id: 'reply', role: 'assistant', completed: true, text: 'reply' });
  await restored.poll();
  await restored.send({ task_id: 'example-app#48', message: 'follow-up', request_id: 'two' });
  assert.equal(f.calls.filter(c => c === 'create').length, 1);
  assert.ok(JSON.parse(await readFile(f.store.path, 'utf8')).jobs.length === 2);
});

test('answers are sent only to a question belonging to the selected job', async () => {
  const f = await fixture();
  f.api.answerQuestion = async (id, answers) => f.calls.push({ answer: id, answers });
  const job = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  f.setPending([{ type: 'question', id: 'que1', questions: [{ question: 'Use mint?' }] }]);
  await f.bridge.poll();
  await assert.rejects(f.bridge.answer(job.id, 'someone-elses-question', [['yes']]), /belong/);
  await f.bridge.answer(job.id, 'que1', [['yes']]);
  assert.equal(f.bridge.get(job.id).status, 'running');
  assert.ok(f.calls.some(c => c.answer === 'que1'));
});

test('a pending job can be cancelled without approving permissions or resending work', async () => {
  const f = await fixture();
  f.api.abort = async id => f.calls.push({ aborted: id });
  const job = await f.bridge.send({ task_id: 'example-app#48', message: 'hello', request_id: 'one' });
  const cancelled = await f.bridge.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(f.calls.some(c => c.aborted === 'ses_test'));
  assert.ok(f.calls.some(c => c.body?.includes('cancelled')));
  await f.bridge.poll();
  assert.equal(f.calls.filter(c => c.text).length, 1);
});
