import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledBridge = fileURLToPath(new URL('../', import.meta.url));

export function endpoint(runtime) {
  const url = new URL(runtime.bridgeUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.pathname !== '/mcp' || !runtime.bridgeToken) {
    throw new Error('The bridge connection settings are invalid.');
  }
  return url;
}

export async function callDesktopTool(runtime, name, input, root = bundledBridge) {
  const load = createRequire(resolve(root, 'package.json'));
  const { Client } = load('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = load('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'agentdispatch-desktop', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint(runtime), {
    requestInit: { headers: { authorization: `Bearer ${runtime.bridgeToken}` } },
    fetch: (url, options = {}) => fetch(url, {
      ...options, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(options.signal ? [options.signal] : [])]),
    }),
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 15000 });
    const response = result.content.find(item => item.type === 'text')?.text;
    if (result.isError) throw new Error(response || 'The bridge rejected the request.');
    return JSON.parse(response);
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
}
