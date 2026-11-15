import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCodeRuntime } from '../src/opencode-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = resolve(root, '.state');
await mkdir(state, { recursive: true, mode: 0o700 });
let runtime;
try { runtime = JSON.parse(await readFile(resolve(state, 'runtime.json'), 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  runtime = { openCodeUrl: 'http://127.0.0.1:4096', bridgeUrl: 'http://127.0.0.1:4097/mcp', openCodePassword: randomBytes(32).toString('hex'), bridgeToken: randomBytes(32).toString('hex') };
}
const config=JSON.parse(await readFile(resolve(root,'bridge.config.json'),'utf8'));
runtime=openCodeRuntime(runtime,config);
const saveRuntime=()=>writeFile(resolve(state,'runtime.json'),JSON.stringify(runtime,null,2),{mode:0o600});
const headers = runtime.openCodePassword?{ authorization: `Basic ${Buffer.from(`opencode:${runtime.openCodePassword}`).toString('base64')}` }:{};
try {
  const check = await fetch(`${runtime.openCodeUrl}/global/health`, { headers, signal: AbortSignal.timeout(1000) });
  if (check.ok) { await saveRuntime();console.log('Existing project-local OpenCode server is healthy.'); process.exit(0); }
  throw Error(`Port 4096 is occupied (HTTP ${check.status}); refusing to replace it.`);
} catch (error) {
  if (error.message.includes('occupied')) throw error;
}
await saveRuntime();
const output = await open(resolve(state, 'opencode.log'), 'a');
const child = spawn(resolve(root, 'node_modules/opencode-windows-x64/bin/opencode.exe'), ['serve', '--hostname', '127.0.0.1', '--port', '4096'], {
  cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output.fd, output.fd],
  env: { ...process.env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: runtime.openCodePassword||'' },
});
child.unref();
child.on('error',()=>{});
await output.close();
await writeFile(resolve(state, 'opencode.pid'), String(child.pid));
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch(`${runtime.openCodeUrl}/global/health`, { headers, signal: AbortSignal.timeout(1000) });
    if (response.ok) { console.log(JSON.stringify({ pid: child.pid, url: runtime.openCodeUrl, health: await response.json() })); process.exit(0); }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
throw Error('OpenCode did not become healthy; inspect .state/opencode.log locally.');
