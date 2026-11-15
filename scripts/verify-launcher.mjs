import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'bridge-launcher-verification', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'scripts/mcp-launcher.mjs')], cwd: root, stderr: 'pipe' }));
  const tools = (await client.listTools()).tools.map(t => t.name);
  const health = await client.callTool({ name: 'opencode_health', arguments: {} });
  if (health.isError || !tools.includes('project_start')||!tools.includes('orchestrator_goal')) throw Error('Launcher verification failed');
  console.log(JSON.stringify({ tools, health: JSON.parse(health.content[0].text) }));
} finally { await client.close(); }
