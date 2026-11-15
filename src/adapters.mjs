import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateBaseUrl } from './core.mjs';

export class OpenCodeApi {
  constructor({ url, password, workspace, model, fetchFn = fetch }) {
    this.url = validateBaseUrl(url); this.workspace = workspace; this.model = model; this.fetch = fetchFn;
    this.headers = { ...(password?{authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`} : {}), 'content-type': 'application/json' };
  }
  async request(path, method = 'GET', body) {
    const url = new URL(path, this.url);
    url.searchParams.set('directory', this.workspace);
    const response = await this.fetch(url.toString(), { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      const error = Error(`OpenCode ${method} ${path} returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  async health() {
    const [health, providers] = await Promise.all([this.request('/global/health'), this.request('/provider')]);
    const provider = providers.all.find(p => p.id === this.model.providerID);
    if (!providers.connected.includes(this.model.providerID) || !provider?.models[this.model.modelID]) throw Error('The configured OpenCode model is not connected; no fallback is allowed');
    return { ...health, model: this.model };
  }
  permissionRules(mode) {
    // OpenCode's Windows permission requests can be relative to the drive root
    // (Projects\\Example\\...) rather than the requested project directory.
    const paths = suffix => {
      const absolute = suffix ? `${this.workspace}/${suffix}` : this.workspace;
      const relative = absolute.replace(/^[A-Za-z]:\//, '');
      const projectRelative = suffix || '.';
      return [...new Set([absolute, relative, projectRelative, absolute.replaceAll('/', '\\'), relative.replaceAll('/', '\\'), projectRelative.replaceAll('/', '\\')])];
    };
    return [
      { permission: '*', pattern: '*', action: 'ask' },
      // Use these legacy compatibility scopes. Root
      // directory listing supports discovery without granting recursive reads.
      ...['', 'AGENTS.md', 'tasks/plan.md', 'backend/openapi.yaml', 'backend/contracts/**', 'dashboard', 'dashboard/**']
        .flatMap(scope => paths(scope).map(pattern => ({ permission: 'read', pattern, action: 'allow' }))),
      // Use direct reads of the approved files. Search tools can request broad
      // expression-based permissions and have stalled this OpenCode version's
      // pending-permission endpoint; do not broaden their access automatically.
      ...['glob', 'grep', 'list'].map(permission => ({ permission, pattern: '*', action: 'deny' })),
      { permission: 'read', pattern: '**/.state/**', action: 'deny' },
      { permission: 'read', pattern: '**\\.state\\**', action: 'deny' },
      { permission: 'read', pattern: '**/.env*', action: 'deny' },
      { permission: 'read', pattern: '**\\.env*', action: 'deny' },
      // The optional external source review was not approved. Keep bridge
      // implementation and its local state outside the delegated reader scope.
      ...paths('tools/opencode-bridge/**').map(pattern => ({ permission: 'read', pattern, action: 'deny' })),
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: mode === 'discussion' ? 'deny' : 'ask' },
      { permission: 'edit', pattern: '*', action: 'deny' },
      ...(mode === 'implementation' ? paths('dashboard/**').map(pattern => ({ permission: 'edit', pattern, action: 'allow' })) : []),
    ];
  }
  async createSession(title, mode) {
    return this.request('/session', 'POST', { title, agent: this.accessMode==='full'||mode!=='discussion'?'build':'plan', model: { id: this.model.modelID, providerID: this.model.providerID }, permission: this.permissionRules(mode) });
  }
  refreshPermissions(id, mode) { return this.request(`/session/${encodeURIComponent(id)}`, 'PATCH', { permission: this.permissionRules(mode) }); }
  async send(id, text, model, mode) {
    if (model.providerID !== this.model.providerID || model.modelID !== this.model.modelID) throw Error('Model mismatch');
    return this.request(`/session/${encodeURIComponent(id)}/prompt_async`, 'POST', { model, agent: this.accessMode==='full'||mode!=='discussion'?'build':'plan', parts: [{ type: 'text', text }] });
  }
  async inspect(id) {
    const [messages, statuses, permissions, questions] = await Promise.all([
      this.request(`/session/${encodeURIComponent(id)}/message`), this.request('/session/status'), this.request('/permission'), this.request('/question'),
    ]);
    return {
      messages: messages.map(({ info, parts }) => ({
        id: info.id, role: info.role, text: parts.filter(p => p.type === 'text').map(p => p.text).join('\n'),
        completed: Boolean(info.error || (info.time?.completed && info.finish !== 'tool-calls')),
        error: info.error || (info.finish === 'length' ? { code: 'MODEL_OUTPUT_LIMIT', message: 'OpenCode stopped at its provider output limit; do not treat this turn as a completed task.' } : undefined), modelID: info.modelID, providerID: info.providerID,
      })),
      busy: Boolean(statuses[id] && statuses[id].type !== 'idle'),
      pending: [
        ...permissions.filter(p => p.sessionID === id).map(p => ({ ...p, type: 'permission' })),
        ...questions.filter(q => q.sessionID === id).map(q => ({ ...q, type: 'question' })),
      ],
    };
  }
  answerQuestion(id, answers) { return this.request(`/question/${encodeURIComponent(id)}/reply`, 'POST', { answers }); }
  async abort(id) {
    await this.request(`/session/${encodeURIComponent(id)}/abort`, 'POST');
    // Aborting generation alone leaves native permission/question records pending.
    // Reject only this session's requests; never approve them or touch another session.
    const [permissions, questions] = await Promise.all([this.request('/permission'), this.request('/question')]);
    for (const pending of permissions.filter(p => p.sessionID === id)) {
      try { await this.request(`/permission/${encodeURIComponent(pending.id)}/reply`, 'POST', { reply: 'reject', message: 'Bridge job cancelled.' }); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    for (const pending of questions.filter(q => q.sessionID === id)) {
      try { await this.request(`/question/${encodeURIComponent(pending.id)}/reject`, 'POST'); }
      catch (error) { if (error.status !== 404) throw error; }
    }
  }
}

export class KanzoBoard {
  constructor(command, workspace) { this.command = command; this.workspace = workspace; }
  async connect() {
    this.client = new Client({ name: 'codex-opencode-bridge', version: '1.0.0' });
    this.transport = new StdioClientTransport({ command: this.command, args: ['mcp'], cwd: this.workspace, stderr: 'pipe' });
    // Drain stderr without copying another process's potentially sensitive diagnostics to the board.
    await this.client.connect(this.transport);
    this.transport.stderr?.on('data', () => {});
  }
  async call(name, args) {
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) throw Error(`Kanzo ${name} failed`);
    return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  }
  get(id) { return this.call('get_task', { id }); }
  comment(id, body) { return this.call('add_comment', { id, author: 'Codex bridge', body }); }
  status(id, status) {
    if (!['doing', 'review'].includes(status)) throw Error('Bridge may only set doing or review');
    return this.call('update_task', { id, status });
  }
  async close() { await this.client?.close(); }
}
