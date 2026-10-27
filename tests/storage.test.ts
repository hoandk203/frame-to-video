import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace, atomicJSON } from '../apps/server/src/storage/workspace.js';

test('invalid JSON cannot damage the current file or leave temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftvs-atomic-'));
  try {
    const path = join(dir, 'metadata.json');
    await atomicJSON(path, { revision: 1 });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await assert.rejects(atomicJSON(path, circular));
    await assert.rejects(atomicJSON(path, undefined));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { revision: 1 });
    assert.deepEqual(await readdir(dir), ['metadata.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace initialization failure releases its owned lock and permits corrected restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftvs-init-'));
  const ws = new Workspace(dir);
  try {
    await writeFile(join(dir, 'cache'), 'not a directory');
    await assert.rejects(ws.init());
    await assert.rejects(stat(join(dir, '.workspace.lock')));
    await rm(join(dir, 'cache'));
    await ws.init();
    assert((await stat(join(dir, '.workspace.lock'))).isFile());
  } finally {
    await ws.close();
    await rm(dir, { recursive: true, force: true });
  }
});
