import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, stat, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Diagnostics } from '../apps/server/src/storage/diagnostics.js';

test('diagnostics bounds entry size, total bytes and file count under concurrent error writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftvs-diagnostics-'));
  try {
    const logs = new Diagnostics(dir, { maxEntryBytes: 128, maxBytes: 256, maxFiles: 2 });
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => logs.record(new Error('error '.repeat(100)))),
    );
    const files = await readdir(dir);
    assert(files.length <= 2);
    let bytes = 0;
    for (const file of files) {
      const info = await stat(join(dir, file));
      assert(info.size <= 128);
      bytes += info.size;
    }
    assert(bytes <= 256);
    assert.equal(
      (await readFile(join(dir, `${ids.at(-1)}.log`))).length,
      128,
      'returned current diagnostic remains available',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotation expires owned logs but leaves unrelated files untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftvs-diagnostics-age-'));
  try {
    const old = join(dir, `${randomUUID()}.log`);
    await writeFile(old, 'old');
    await utimes(old, 0, 0);
    await writeFile(join(dir, 'user-notes.txt'), 'keep');
    const logs = new Diagnostics(dir);
    const id = await logs.record(new Error('fresh'));
    await assert.rejects(stat(old));
    assert.equal(await readFile(join(dir, 'user-notes.txt'), 'utf8'), 'keep');
    assert.match(await readFile(join(dir, `${id}.log`), 'utf8'), /fresh/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
