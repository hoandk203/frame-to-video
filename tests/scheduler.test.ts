import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaScheduler } from '../apps/server/src/rendering/scheduler.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test('one native worker, bounded pending queue and running cancellation settles only after work releases resources', async () => {
  const queue = new MediaScheduler(2),
    gate = latch(),
    entered = latch();
  let running = 0,
    max = 0,
    settled = false;
  const first = queue.schedule(async () => {
    running++;
    max = Math.max(max, running);
    entered.release();
    await gate.promise;
    running--;
    return 'first';
  });
  const second = queue.schedule(async () => {
    running++;
    max = Math.max(max, running);
    running--;
    return 'second';
  });
  const third = queue.schedule(async () => 'third');
  const full = queue.schedule(async () => 'should not run');
  await assert.rejects(full.promise, /đầy/);
  void first.promise
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await entered.promise;
  first.cancel();
  await Promise.resolve();
  assert.equal(settled, false);
  gate.release();
  await assert.rejects(first.promise);
  assert.equal(await second.promise, 'second');
  assert.equal(await third.promise, 'third');
  await queue.idle();
  assert.equal(max, 1);
  assert.deepEqual(queue.stats, { queued: 0, running: 0, previewPaused: false });
});
test('export work preempts queued preview capacity and preview resumes only after the job lease releases', async () => {
  const queue = new MediaScheduler(1),
    release = queue.beginExport(),
    seen: string[] = [];
  const pending = queue.schedule(
    async () => {
      seen.push('old-preview');
    },
    { priority: 'prefetch' },
  );
  const urgent = queue.schedule(
    async () => {
      seen.push('export');
    },
    { priority: 'export' },
  );
  await assert.rejects(pending.promise, /Ưu tiên/);
  await urgent.promise;
  const resumed = queue.schedule(
    async () => {
      seen.push('new-preview');
    },
    { priority: 'seek' },
  );
  await Promise.resolve();
  assert.deepEqual(seen, ['export']);
  release();
  await resumed.promise;
  assert.deepEqual(seen, ['export', 'new-preview']);
});
test('seek replacement is scoped to the same client and shutdown rejects queued tasks', async () => {
  const queue = new MediaScheduler(),
    release = queue.beginExport();
  const old = queue.schedule(async () => 'old', { replaceScope: 'view-A' });
  const other = queue.schedule(async () => 'other', { replaceScope: 'view-B' });
  const next = queue.schedule(async () => 'next', { replaceScope: 'view-A' });
  await assert.rejects(old.promise, /vị trí mới/);
  release();
  assert.equal(await other.promise, 'other');
  assert.equal(await next.promise, 'next');
  const pause = queue.beginExport();
  const pending = queue.schedule(async () => 'never');
  await queue.shutdown();
  await assert.rejects(pending.promise, /đang dừng/);
  pause();
  await assert.rejects(queue.schedule(async () => 'never').promise, /đã dừng/);
});

test('queue capacity rejects invalid configuration', () => {
  for (const capacity of [0, -1, Infinity, 1.5])
    assert.throws(() => new MediaScheduler(capacity), RangeError);
});
