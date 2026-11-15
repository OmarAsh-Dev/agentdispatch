import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const bundledBridge = fileURLToPath(new URL('../', import.meta.url));

async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

function endpoint(runtime) {
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

async function status(root) {
  const config = await json(resolve(root, 'bridge.config.json'), null);
  if (!config) return { installed: false, online: false, projects: [], goals: [] };
  const registry = await json(resolve(root, '.state/registry.json'), {});
  const state = await json(resolve(root, '.state/controller.json'), {});
  const runtime = await json(resolve(root, '.state/runtime.json'), null);
  let online = false;
  if (runtime) {
    try {
      const response = await fetch(new URL('/health', endpoint(runtime)), {
        headers: { authorization: `Bearer ${runtime.bridgeToken}` },
        redirect: 'error', signal: AbortSignal.timeout(2500),
      });
      online = response.ok;
      await response.body?.cancel();
    } catch {}
  }
  return {
    installed: true, online,
    model: config.model,
    kanzoUrl: config.kanzoUrl,
    projects: Object.values(registry.projects || {}).map(({ project, workspace, orchestrator }) =>
      ({ project, workspace, orchestrator: orchestrator.agent })),
    goals: (state.goals || []).slice(-20).reverse().map(({ id, project, goal, status }) =>
      ({ id, project, summary: goal.split(/\r?\n/, 1)[0].slice(0, 130), status })),
  };
}

async function main({ root, action, input }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Enter an absolute installation folder.');
  if (action === 'status') return status(root);
  if (action === 'install') {
    await run('pwsh.exe', ['-NoProfile', '-File', resolve(bundledBridge, 'scripts/install.ps1'), '-Destination', root],
      { windowsHide: true, timeout: 240000, maxBuffer: 512000 });
    return status(root);
  }
  if (action === 'configure') {
    const providerID = input.providerID?.trim();
    const modelID = input.modelID?.trim();
    if (!providerID || !modelID) throw new Error('Enter both the OpenCode provider and model.');
    const path = resolve(root, 'bridge.config.json');
    const config = await json(path);
    config.model = { providerID, modelID };
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return status(root);
  }
  if (action === 'start') {
    const current = await status(root);
    if (!current.installed) throw new Error('Install the bridge or select an existing installation first.');
    if (current.online) return current;
    await run(process.execPath, [resolve(root, 'scripts/bridge.mjs'), 'start'],
      { cwd: root, windowsHide: true, timeout: 95000 });
    const started = await status(root);
    if (!started.online) throw new Error('The bridge did not start. Check its .state/bridge.log file.');
    return started;
  }
  const tool = { register: 'project_start', submit: 'orchestrator_goal' }[action];
  if (!['register', 'submit'].includes(action)) throw new Error('Unknown desktop action.');
  const runtime = await json(resolve(root, '.state/runtime.json'), null);
  if (!runtime) throw new Error('Start the bridge first.');
  return callDesktopTool(runtime, tool, input, root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Rust sends the goal through stdin, outside the process command line.
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 150000) throw new Error('The request is too large.');
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    console.log(JSON.stringify(await main(request)));
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    console.log(JSON.stringify({ error: detail.includes('Session limit reached')
      ? 'The bridge has reached its connection limit. Restart it after active Kanzo work finishes.'
      : detail.slice(0, 600) }));
    process.exitCode = 1;
  }
}
