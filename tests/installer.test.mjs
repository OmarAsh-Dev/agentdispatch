import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a fresh installation uses scoped defaults and protects an existing destination', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, () => {
  const folder = mkdtempSync(join(tmpdir(), 'kanzo-install-'));
  try {
    const destination = join(folder, 'Kanzo Bridge');
    const script = fileURLToPath(new URL('../scripts/install.ps1', import.meta.url));
    const install = (...options) => spawnSync('pwsh.exe', [
      '-NoProfile', '-File', script, '-Destination', destination, ...options,
    ], { encoding: 'utf8', windowsHide: true, timeout: 240_000 });

    const incomplete = install('-ProviderId', 'example');
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /ProviderId and ModelId together/);
    assert.equal(existsSync(destination), false);

    const result = install('-ProviderId', 'example', '-ModelId', 'example-model');
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const path = join(destination, 'bridge.config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(config.model, { providerID: 'example', modelID: 'example-model' });
    assert.equal(config.accessMode, 'scoped');
    assert.equal(config.openCodeAuth, 'password');
    assert.ok(existsSync(join(destination, 'kanzo-bridge.cmd')));
    assert.equal(existsSync(join(destination, '.state')), false);
    assert.equal(existsSync(join(destination, '.git')), false);

    const repeat = install('-ProviderId', 'other', '-ModelId', 'other-model');
    assert.notEqual(repeat.status, 0);
    assert.match(repeat.stderr, /Destination already exists/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
