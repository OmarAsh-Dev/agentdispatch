import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(await readFile(resolve(root, '.state/runtime.json'), 'utf8'));
const [name = 'opencode_health', argumentFile] = process.argv.slice(2);
const args = argumentFile ? JSON.parse(await readFile(resolve(argumentFile), 'utf8')) : {};
const client = new Client({ name: 'codex-bridge-cli', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(runtime.bridgeUrl), {
  requestInit: { headers: { authorization: `Bearer ${runtime.bridgeToken}` } },
});
try {
  await client.connect(transport);
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 65000 });
  for (const content of result.content) if (content.type === 'text') console.log(content.text);
  process.exitCode = result.isError ? 1 : 0;
} finally {
  await transport.terminateSession().catch(() => {});
  await client.close();
}
