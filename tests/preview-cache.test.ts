import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { limitsSchema } from '../packages/contracts/src/index.js';
import { Workspace } from '../apps/server/src/storage/workspace.js';
import { Quota } from '../apps/server/src/storage/quota.js';
import { PreviewCache } from '../apps/server/src/storage/preview-cache.js';

const key = (name: string) => createHash('sha256').update(name).digest('hex');
async function setup(memory: number, disk: number, entries = 4096, quotaBytes = 1048576) {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-cache-'));
  const ws = new Workspace(root);
  await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0, workspaceQuotaBytes: quotaBytes });
  const quota = new Quota(ws, limits);
  const cache = new PreviewCache(ws, quota, memory, disk, entries);
  await cache.init();
  return {
    root,
    ws,
    quota,
    cache,
    close: async () => {
      await ws.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('cache enforces disk/memory LRU, preserves active readers and clears only owned media', async () => {
  const h = await setup(5, 10);
  try {
    await writeFile(h.ws.path('cache', 'keep.txt'), 'unrelated');
    await h.cache.put(key('A'), Buffer.from('aaaaa'));
    await h.cache.put(key('B'), Buffer.from('bbbbb'));
    const a = await h.cache.acquire(key('A'), 'png');
    assert(a);
    assert.equal((a.data ?? (await readFile(a.path!))).toString(), 'aaaaa');
    await h.cache.put(key('C'), Buffer.from('ccccc'));
    assert.equal(await h.cache.has(key('B'), 'png'), false);
    assert.equal(await h.cache.has(key('C'), 'png'), true);
    assert.equal(h.cache.stats.diskBytes, 10);
    assert(h.cache.stats.memoryBytes <= 5);
    await assert.rejects(
      h.cache.clear(),
      (error: unknown) => (error as { code: string }).code === 'PREVIEW_CACHE_BUSY',
    );
    assert.equal(h.cache.stats.entries, 2, 'busy clear performs no partial deletion');
    a.release();
    a.release();
    assert.equal(h.cache.stats.readers, 0);
    await h.cache.clear();
    assert.equal(h.cache.stats.entries, 0);
    assert.deepEqual(await readdir(h.ws.path('cache')), ['keep.txt']);
    assert.equal((await h.quota.info()).reserved, 0);
  } finally {
    await h.close();
  }
});

test('memory-only, disk-only and disabled cache budgets behave explicitly without exceeding either tier', async () => {
  for (const [memory, disk] of [
    [10, 0],
    [0, 10],
    [0, 0],
  ] as const) {
    const h = await setup(memory, disk);
    try {
      if (!memory && !disk) {
        await assert.rejects(
          h.cache.put(key('A'), Buffer.from('aaaaa')),
          (error: unknown) => (error as { code: string }).code === 'PREVIEW_CACHE_LIMIT',
        );
        assert.equal(h.cache.stats.entries, 0);
        continue;
      }
      await h.cache.put(key('A'), Buffer.from('aaaaa'));
      const a = await h.cache.acquire(key('A'), 'png');
      assert(a);
      assert.equal(Boolean(a.data), Boolean(memory));
      assert.equal(Boolean(a.path), Boolean(disk));
      assert.equal(a.bytes, 5);
      a.release();
      await h.cache.put(key('B'), Buffer.from('bbbbb'));
      await h.cache.put(key('C'), Buffer.from('ccccc'));
      assert.equal(await h.cache.has(key('A'), 'png'), false);
      assert(h.cache.stats.diskBytes <= disk && h.cache.stats.memoryBytes <= memory);
      assert.equal((await h.quota.info()).reserved, 0);
    } finally {
      await h.close();
    }
  }
});

test('publication cannot evict leased media and competing producers retain bounded storage', async () => {
  const h = await setup(0, 5, 1);
  try {
    await h.cache.put(key('A'), Buffer.from('aaaaa'));
    const lease = await h.cache.acquire(key('A'), 'png');
    assert(lease);
    await assert.rejects(h.cache.put(key('B'), Buffer.from('bbbbb')), /đang được đọc/);
    assert.equal((await readFile(lease.path!)).toString(), 'aaaaa');
    lease.release();
    await Promise.all([
      h.cache.put(key('B'), Buffer.from('bbbbb')),
      h.cache.put(key('C'), Buffer.from('ccccc')),
    ]);
    assert.equal(h.cache.stats.entries, 1);
    assert.equal(h.cache.stats.diskBytes, 5);
    assert.equal((await h.quota.info()).reserved, 0);
    assert.equal((await readdir(h.ws.path('cache'))).length, 1);
  } finally {
    await h.close();
  }
});

test('quota, canceled, oversized and invalidated generations release reservations and owned temporary files', async () => {
  const h = await setup(0, 100);
  try {
    const controller = new AbortController();
    await assert.rejects(
      h.cache.generate(
        key('cancel'),
        'm4a',
        50,
        async (path) => {
          await writeFile(path, 'partial');
          controller.abort(new Error('stop'));
        },
        controller.signal,
      ),
      /stop/,
    );
    await assert.rejects(
      h.cache.generate(key('large'), 'm4a', 5, async (path) => {
        await writeFile(path, 'too-large');
      }),
      /giới hạn/,
    );
    await assert.rejects(
      h.cache.generate(key('clear'), 'm4a', 50, async (path) => {
        await h.cache.clear();
        await writeFile(path, 'valid');
      }),
      /đã được xóa/,
    );
    assert.equal((await h.quota.info()).reserved, 0);
    assert.deepEqual(await readdir(h.ws.path('cache')), []);
    const tiny = new Quota(
      h.ws,
      limitsSchema.parse({ minFreeDiskBytes: 0, workspaceQuotaBytes: 1 }),
    );
    const cache = new PreviewCache(h.ws, tiny, 0, 100);
    await assert.rejects(cache.put(key('quota'), Buffer.from('abc')), /quota/);
    assert.equal((await tiny.info()).reserved, 0);
    assert.deepEqual(await readdir(h.ws.path('cache')), []);
  } finally {
    await h.close();
  }
});

test('restart removes only owned staging, applies limits, warms memory and detects missing cache files', async () => {
  const h = await setup(0, 20);
  try {
    await h.cache.put(key('A'), Buffer.from('aaaaa'));
    await h.cache.put(key('B'), Buffer.from('bbbbb'));
    await writeFile(h.ws.path('cache', `.cache-${randomUUID()}.part`), 'interrupted');
    await writeFile(h.ws.path('cache', 'user.tmp'), 'keep');
    const restarted = new PreviewCache(h.ws, h.quota, 5, 5, 1);
    await restarted.init();
    assert.equal(restarted.stats.entries, 1);
    assert.equal(restarted.stats.diskBytes, 5);
    const entryName = (await readdir(h.ws.path('cache'))).find((name) => name.endsWith('.png'))!;
    const lease = await restarted.acquire(entryName.slice(0, -4), 'png');
    assert(lease?.data);
    lease.release();
    await rm(lease.path!);
    assert.equal(await restarted.acquire(entryName.slice(0, -4), 'png'), null);
    assert.equal(restarted.stats.entries, 0);
    assert.deepEqual(await readdir(h.ws.path('cache')), ['user.tmp']);
    await assert.rejects(restarted.put('../escape', Buffer.from('x')), /key/);
  } finally {
    await h.close();
  }
});
