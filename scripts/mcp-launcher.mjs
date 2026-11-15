import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ReconnectableClient } from '../src/reconnect.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
try {
  // Capture bootstrap stdout: only MCP protocol messages may go to this process's stdout.
  // Codex orchestration remains available when OpenCode is temporarily offline.
  try{await run(process.execPath, [resolve(root, 'scripts/start-opencode.mjs')], { cwd: root, windowsHide: true, timeout: 30000 });}catch{console.error('OpenCode startup needs attention; bridge status remains available.');}
  try{await run(process.execPath,[resolve(root,'scripts/start-codex.mjs')],{cwd:root,windowsHide:true,timeout:35000});}catch{console.error('Codex daemon needs attention; bridge status remains available.');}
  await run(process.execPath, [resolve(root, 'scripts/start-bridge.mjs')], { cwd: root, windowsHide: true, timeout: 30000 });
  const runtime = JSON.parse(await readFile(resolve(root, '.state/runtime.json'), 'utf8'));
  const client = new ReconnectableClient(async () => {
    const connection = new Client({ name: 'codex-opencode-mcp-proxy', version: '1.0.0' });
    await connection.connect(new StreamableHTTPClientTransport(new URL(runtime.bridgeUrl), { requestInit: { headers: { authorization: `Bearer ${runtime.bridgeToken}` } } }));
    return connection;
  });
  await client.connect();
  const server = new Server({ name: 'global-kanzo-bridge', version: '2.0.0' }, { capabilities: { tools: {} }, instructions: 'Global Kanzo orchestration for Codex and OpenCode. Intentional project starts call project_start with actual workspace and initiating agent; first start sticks until explicit reassignment. User goals go to orchestrator_goal. Todo OR ready triggers readiness. Human review is reserved for the user. Delegated workers must not call control tools or change assignments.' });
  server.setRequestHandler(ListToolsRequestSchema, () => client.run(connection => connection.listTools()));
  server.setRequestHandler(CallToolRequestSchema, request => client.run(connection => connection.callTool(request.params, undefined, { timeout: 65000 })));
  await server.connect(new StdioServerTransport());
  process.stdin.on('end', async () => { await client.close(); await server.close(); process.exit(0); });
} catch (error) { console.error(`OpenCode bridge startup failed: ${error.message}`); process.exit(1); }
