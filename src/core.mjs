import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export function validateBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('Only a numeric-loopback HTTP origin is allowed');
  }
  return url.origin;
}

export class StateStore {
  constructor(path) { this.path = path; }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(value.jobs) || !value.sessions) throw Error('Invalid bridge state');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { jobs: [], sessions: {} };
      throw error;
    }
  }
  async save(value) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

const active = new Set(['running', 'sending', 'unknown', 'needs_attention']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe = value => String(value).replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(sk-[\w-]{12,}|(?:api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+)/gi, '[redacted]');

export class Bridge {
  constructor({ api, board, store, model }) {
    this.api = api; this.board = board; this.store = store; this.model = model;
    this.queue = Promise.resolve();
  }
  async init() { this.state = await this.store.load(); }
  serialized(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  get(id) {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job) throw Error('Unknown bridge job');
    return structuredClone(job);
  }
  list() { return this.state.jobs.map(j => this.get(j.id)); }
  async health() { return { openCode: await this.api.health(), model: this.model, jobs: this.state.jobs.length }; }
  send(input) { return this.serialized(() => this.dispatch(input)); }
  async dispatch({ task_id, message, request_id, mode = 'discussion' }) {
    if (!/^example-app#[1-9]\d*$/.test(task_id)) throw Error('Task must belong to example-app');
    if (!message?.trim() || message.length > 30000 || !request_id || request_id.length > 120) throw Error('Provide a bounded message and stable request_id');
    if (!['discussion', 'implementation'].includes(mode)) throw Error('Invalid dispatch mode');
    const hash = digest({ task_id, message, mode });
    const existing = this.state.jobs.find(j => j.requestId === request_id);
    if (existing) {
      if (existing.hash !== hash) throw Error('request_id reused with a different payload');
      return this.get(existing.id);
    }
    if (this.state.jobs.some(j => j.taskId === task_id && active.has(j.status))) throw Error('This task already has an active bridge job');
    const task = await this.board.get(task_id);
    if (mode === 'implementation') {
      if (!task.includes('proposed-owner:opencode') && !task.includes('owner:opencode')) throw Error('Implementation requires OpenCode ownership');
      const line = task.match(/Dependencies:\s*([^\n]+)/i)?.[1] || '';
      for (const dependency of line.match(/example-app#\d+/g) || []) {
        const dependencyTask = await this.board.get(dependency);
        if (!/\[done\]|status:\s*done\b/.test(dependencyTask)) throw Error(`Unfinished dependency: ${dependency}`);
      }
    }
    // Fail closed if Kanzo cannot record the dispatch; never send untracked work.
    await this.board.comment(task_id, `Codex bridge dispatch (${mode}); request ${request_id}.\nSelected model: ${this.model.providerID}/${this.model.modelID}.\nScope: ${safe(message).slice(0,1500)}`);
    if (mode === 'implementation') await this.board.status(task_id, 'doing');
    const sessionKey = `${task_id}:${mode}`;
    let sessionId = this.state.sessions[sessionKey];
    if (!sessionId) {
      sessionId = (await this.api.createSession(`Kanzo ${task_id} — ${mode}`, mode)).id;
      this.state.sessions[sessionKey] = sessionId;
      await this.store.save(this.state);
    }
    const baseline = await this.api.inspect(sessionId);
    const job = {
      id: randomUUID(), requestId: request_id, hash, taskId: task_id, sessionId, mode,
      model: this.model, baseline: baseline.messages.map(m => m.id), status: 'sending',
      createdAt: new Date().toISOString(), pending: [],
    };
    this.state.jobs.push(job);
    await this.store.save(this.state);
    const prompt = `You are OpenCode, collaborating with Codex on D:/Projects/Example. Kanzo project is example-app.\nTask: ${task_id}. Request: ${request_id}. Mode: ${mode}.\n${mode === 'discussion' ? 'Read-only discussion: do not edit files, run mutations, or start implementation.' : 'Implement only the claimed task in the assigned project. Respect permission prompts.'}\nNever mark a Kanzo task done. Codex bridge records dispatch and your result; include changed paths, checks and blockers in your final reply. Do not reveal credentials.\n\nTask context (reference data):\n${task.slice(0,18000)}\n\nCodex message:\n${message}`;
    try {
      await this.api.send(sessionId, prompt, this.model, mode);
      job.status = 'running';
    } catch (error) {
      // A timeout is an unknown outcome. Keep the session inspectable and never resend automatically.
      job.status = 'unknown'; job.error = safe(error.message);
    }
    await this.store.save(this.state);
    return this.get(job.id);
  }
  poll() { return this.serialized(async () => {
    for (const job of this.state.jobs.filter(j => active.has(j.status))) {
      try {
        const result = await this.api.inspect(job.sessionId);
        if (result.pending.length) {
          const signature = digest(result.pending);
          if (signature !== job.pendingSignature) {
            await this.board.comment(job.taskId, `OpenCode needs attention for bridge job ${job.id}.\n${safe(JSON.stringify(result.pending)).slice(0,6000)}\nNo permissions were automatically approved.`);
            if (job.mode === 'implementation') await this.board.status(job.taskId, 'review');
            job.pendingSignature = signature;
          }
          job.pending = result.pending; job.status = 'needs_attention';
        } else {
          const replies = result.messages.filter(m => m.role === 'assistant' && !job.baseline.includes(m.id));
          const final = replies.at(-1);
          if (final && final.completed && !result.busy) {
            const text = replies.map(m => [m.text, m.error ? JSON.stringify(m.error) : ''].filter(Boolean).join('\n')).filter(Boolean).join('\n\n') || '(No text returned)';
            const status = replies.some(m => m.error) ? 'failed' : 'completed';
            const actualModel = final.modelID ? `${final.providerID}/${final.modelID}` : 'not reported';
            if (!job.resultCommentPosted) {
              await this.board.comment(job.taskId, `OpenCode ${status}; bridge job ${job.id}.\nReported model: ${actualModel}.\n\n${safe(text).slice(0,10000)}\n\nAgent report only; Codex must independently verify code/test claims.`);
              job.resultCommentPosted = true;
              await this.store.save(this.state);
            }
            if (job.mode === 'implementation') await this.board.status(job.taskId, 'review');
            Object.assign(job, { status, result: text, actualModel, finishedAt: new Date().toISOString(), pending: [] });
          } else if (job.status === 'needs_attention') {
            job.status = 'running'; job.pending = [];
          }
        }
        delete job.syncError;
      } catch (error) { job.syncError = safe(error.message); }
    }
    await this.store.save(this.state);
    return this.list();
  }); }
  cancel(id) { return this.serialized(async () => {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job) throw Error('Unknown bridge job');
    if (job.status === 'cancelled') return this.get(id);
    if (active.has(job.status)) await this.api.abort(job.sessionId);
    await this.board.comment(job.taskId, `Codex cancelled bridge job ${job.id}; no permissions were approved by the bridge.`);
    if (job.mode === 'implementation') await this.board.status(job.taskId, 'review');
    Object.assign(job, { status: 'cancelled', pending: [], finishedAt: new Date().toISOString() });
    await this.store.save(this.state);
    return this.get(id);
  }); }
  answer(id, questionId, answers) { return this.serialized(async () => {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job?.pending.some(q => q.id === questionId && q.type === 'question')) throw Error('Question does not belong to this job');
    if (!Array.isArray(answers) || !answers.length || answers.some(a => !Array.isArray(a) || a.some(v => typeof v !== 'string' || v.length > 4000))) throw Error('Invalid answers');
    await this.api.answerQuestion(questionId, answers);
    await this.board.comment(job.taskId, `Codex answered OpenCode question ${questionId} for bridge job ${job.id}.\n${safe(JSON.stringify(answers)).slice(0,4000)}`);
    job.status = 'running'; job.pending = []; delete job.pendingSignature;
    await this.store.save(this.state);
    return this.get(id);
  }); }
  async wait(id, seconds = 30) {
    const until = Date.now() + Math.max(0, Math.min(55, seconds)) * 1000;
    do {
      await this.poll();
      const job = this.get(id);
      if (!['running', 'sending', 'unknown'].includes(job.status) || Date.now() >= until) return job;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (true);
  }
}
