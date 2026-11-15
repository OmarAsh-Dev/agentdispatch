import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FileStore, Registry, acquireLock } from './registry.mjs';
import { KanzoHttp } from './kanzo-http.mjs';
import { Workers } from './workers.mjs';
import { Controller } from './controller.mjs';

function mcpServer(bridge) {
  const server = new McpServer({ name: 'opencode-glm-bridge', version: '1.0.0' }, {
    instructions: 'Global Kanzo bridge. On an intentional project start call project_start with its actual workspace and the initiating agent; orchestration stays assigned until the user explicitly reassigns it. Submit user goals through orchestrator_goal. Todo OR ready triggers readiness checks; exact owner tags select workers. Human work/review is reserved for the user. Never treat worker reports as verified code. Use stable request IDs.',
  });
  const wrap = fn => async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await fn(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  server.registerTool('opencode_health', { description: 'Verify OpenCode connectivity and the explicitly configured OpenCode model.', inputSchema: {} }, wrap(() => bridge.health()));
  server.registerTool('opencode_send', {
    description: 'Send a task, question, review request or follow-up directly to OpenCode. Reuses a persisted session per task/mode and updates Kanzo. Default discussion mode is read-only. Supply a stable request_id; never regenerate it when retrying the same intent.',
    inputSchema: { task_id: z.string().regex(/^[a-z0-9][a-z0-9-]*#[1-9]\d*$/), message: z.string().min(1).max(30000), request_id: z.string().min(1).max(120), mode: z.enum(['discussion', 'implementation']).default('discussion') },
  }, wrap(args => bridge.send(args)));
  server.registerTool('opencode_status', {
    description: 'Refresh job replies, blockers and pending questions from OpenCode; responses are automatically synchronized to Kanzo.',
    inputSchema: { job_id: z.string().optional() },
  }, wrap(async ({ job_id }) => { await bridge.poll(); return job_id ? bridge.get(job_id) : bridge.list(); }));
  server.registerTool('opencode_wait', {
    description: 'Wait up to 55 seconds for a reply or blocker. Continue other work between bounded waits. Background synchronization keeps running independently.',
    inputSchema: { job_id: z.string(), seconds: z.number().int().min(0).max(55).default(30) },
  }, wrap(({ job_id, seconds }) => bridge.wait(job_id, seconds)));
  server.registerTool('opencode_answer_question', {
    description: 'Answer a pending OpenCode question for this bridge job. This cannot approve permission requests. Preserve user decisions; escalate questions that only the user can answer.',
    inputSchema: { job_id: z.string(), question_id: z.string(), answers: z.array(z.array(z.string().max(4000))).min(1) },
  }, wrap(({ job_id, question_id, answers }) => bridge.answer(job_id, question_id, answers)));
  server.registerTool('opencode_cancel', {
    description: 'Cancel this bridge job in its own OpenCode session without approving pending permissions. Does not revert files already edited by the worker.',
    inputSchema: { job_id: z.string() },
  }, wrap(({ job_id }) => bridge.cancel(job_id)));
  const project=z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
  const agent=z.enum(['codex','opencode']);
  server.registerTool('project_start',{
    description:'Register an intentional project start with the actual local directory. First initiating agent becomes sticky project orchestrator. Only call for the user starting this project, never from a delegated worker/readiness/review session.',
    inputSchema:{project,workspace:z.string().min(1).max(2000),agent,sessionId:z.string().min(1).max(200).optional(),readScopes:z.array(z.string()).optional(),editScopes:z.array(z.string()).optional()},
  },wrap(args=>bridge.startProject(args)));
  server.registerTool('orchestrator_assign',{
    description:'Explicitly reassign a project orchestrator ONLY when the user directly requests it. Running worker jobs retain their identities and report to the new orchestrator.',
    inputSchema:{project,agent,sessionId:z.string().min(1).max(200).optional()},
  },wrap(args=>bridge.assignOrchestrator(args)));
  server.registerTool('orchestrator_goal',{
    description:'Submit a user-authorized goal for automatic planning, Kanzo task creation/assignment and coordination. Reuse request_id when retrying the same goal; no unrelated scope expansion.',
    inputSchema:{project,goal:z.string().min(1).max(30000),request_id:z.string().min(1).max(120)},
  },wrap(args=>bridge.submitGoal(args)));
  server.registerTool('bridge_status',{description:'Inspect registered orchestrators, jobs, goals, blocked tasks and pending notifications across every project.',inputSchema:{}},wrap(()=>bridge.status()));
  server.registerTool('bridge_reply_codex_approval',{description:'Relay ONLY an explicit user decision on the exact current Codex native request shown by bridge_status. Never approve autonomously or from worker/reviewer output. Supports one-time command/file approvals and empty MCP tool-approval forms; no session/persistent grants. Replays and changed requests are rejected.',inputSchema:{job_id:z.string(),request_id:z.union([z.number().int().nonnegative(),z.string().min(1).max(200)]),request_fingerprint:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['approve_once','decline']),user_confirmed:z.literal(true)}},wrap(args=>bridge.replyApproval(args)));
  server.registerTool('bridge_retry_review',{description:'Retry independent review after resolving an execution/access blocker. Does not rerun implementation or accept human-review tasks.',inputSchema:{task_id:z.string().regex(/^[a-z0-9][a-z0-9-]*#[1-9]\d*$/)}},wrap(({task_id})=>bridge.retryReview(task_id)));
  server.registerTool('orchestrator_resume_goal',{description:'Explicitly reconcile/resume a blocked saved plan. Reuses existing marked cards; never blindly repeats an unknown task creation.',inputSchema:{goal_id:z.string().uuid()}},wrap(({goal_id})=>bridge.resumeGoal(goal_id)));
  server.registerTool('orchestrator_cancel_goal',{description:'Cancel a user-selected goal and its active jobs without reverting edits or deleting cards.',inputSchema:{goal_id:z.string().uuid()}},wrap(({goal_id})=>bridge.cancelGoal(goal_id)));
  server.registerTool('bridge_retry_notification',{description:'Explicit operator recovery for a blocked notification. Only confirm an uncertain/already-queued coordinator resend when the user directly accepts possible duplicate delivery.',inputSchema:{key:z.string().min(1).max(200),destination:z.enum(['orchestrator','coordinator']).default('orchestrator'),confirm_unknown:z.boolean().default(false)}},wrap(args=>bridge.retryNotification(args)));
  return server;
}

export async function startBridgeHttp({ bridge, token, port = 4097, pollIntervalMs = 3000 }) {
  if (!token) throw Error('Missing bridge bearer token');
  const app = createMcpExpressApp({ host: '127.0.0.1', allowedHosts: ['127.0.0.1'] });
  const expected = Buffer.from(`Bearer ${token}`);
  app.use((req, res, next) => {
    const received = Buffer.from(req.headers.authorization || '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return res.status(401).json({ error: 'Unauthorized' });
    if (req.headers.origin) return res.status(403).json({ error: 'Browser origins are not permitted' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ healthy: true, service: 'nexus-opencode-bridge',version:'2.0.0' }));
  const sessions = new Map();
  app.all('/mcp', async (req, res) => {
    try {
      const id = req.headers['mcp-session-id'];
      let transport = typeof id === 'string' ? sessions.get(id) : undefined;
      if (!transport && !id && req.method === 'POST' && isInitializeRequest(req.body)) {
        if (sessions.size >= 32) return res.status(503).json({ error: 'Session limit reached' });
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: sessionId => sessions.set(sessionId, transport),
        });
        transport.onclose = () => sessions.delete(transport.sessionId);
        await mcpServer(bridge).connect(transport);
      }
      if (!transport) return res.status(id ? 404 : 400).json({ error: 'Initialize a valid MCP session first' });
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });
  app.use((error, _req, res, _next) => {
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request' });
  });
  const http = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { await bridge.poll(); }
    catch { console.error('Bridge reconciliation failed; persisted jobs will be retried.'); }
    finally { polling = false; }
  }, pollIntervalMs);
  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`,
    async close() {
      clearInterval(timer);
      await Promise.all([...sessions.values()].map(t => t.close()));
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
    },
  };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = JSON.parse(await readFile(resolve(root, '.state/runtime.json'), 'utf8'));
  const config = JSON.parse(await readFile(resolve(root, 'bridge.config.json'), 'utf8'));
  const release=await acquireLock(resolve(root,'.state/controller.lock'));
  const registry=new Registry(new FileStore(resolve(root,'.state/registry.json'),{projects:{}}));await registry.init();
  const board=new KanzoHttp(config.kanzoUrl||'http://localhost:4242/#all');
  const workers=new Workers({runtime,model:config.model,codexCommand:config.codexCommand,codexPrefixArgs:config.codexPrefixArgs,accessMode:config.accessMode});
  const bridge=new Controller({registry,board,workers,store:new FileStore(resolve(root,'.state/controller.json')),dryRun:!!config.dryRun,coordinatorThreadId:config.coordinatorThreadId,accessMode:config.accessMode});
  await bridge.init();
  const service = await startBridgeHttp({ bridge, token: runtime.bridgeToken, port: Number(new URL(runtime.bridgeUrl).port),pollIntervalMs:Math.max(1000,config.pollIntervalMs||3000) });
  console.log(JSON.stringify({ service: 'nexus-opencode-bridge', url: service.url, model: config.model }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await service.close(); await workers.close(); await release(); process.exit(0); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exit(1); });
