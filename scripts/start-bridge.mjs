import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(await readFile(resolve(root, '.state/runtime.json'), 'utf8'));
const healthUrl = new URL('/health', runtime.bridgeUrl);
const headers = { authorization: `Bearer ${runtime.bridgeToken}` };
try {
  const response = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(1000) });
  const health=response.ok?await response.json():{};
  if (health.service === 'nexus-opencode-bridge'&&health.version==='2.0.0') { console.log('Existing bridge is healthy.'); process.exit(0); }
  throw Error('Port 4097 is occupied; refusing to replace it.');
} catch (error) { if (error.message.includes('occupied')) throw error; }
const output = await open(resolve(root, '.state/bridge.log'), 'a');
const child = spawn(process.execPath, [resolve(root, 'src/server.mjs')], { cwd: root, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', output.fd, output.fd] });
child.unref(); await output.close();
child.on('error',()=>{});
await writeFile(resolve(root, '.state/bridge.pid'), String(child.pid));
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(1000) });
    if (response.ok) { console.log(JSON.stringify({ bridgePid: child.pid, url: runtime.bridgeUrl })); process.exit(0); }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
throw Error('Bridge startup failed; inspect .state/bridge.log locally.');
