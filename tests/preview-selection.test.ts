import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PreviewSelections } from '../apps/server/src/rendering/preview-selection.js';
import { MediaScheduler } from '../apps/server/src/rendering/scheduler.js';
import {
  previewRequestSchema,
  previewCancelSchema,
  audioPreviewRequestSchema,
} from '../packages/contracts/src/index.js';

test('latest sequence cancels same-tab seek/prefetch, isolates tabs/projects and rejects reordered requests', () => {
  const selections = new PreviewSelections(),
    a = randomUUID(),
    b = randomUUID();
  const old = selections.begin('project', { clientId: a, sequence: 1, intent: 'seek' });
  const speculative = selections.begin('project', { clientId: a, sequence: 1, intent: 'prefetch' });
  const other = selections.begin('project', { clientId: b, sequence: 1, intent: 'seek' });
  const otherProject = selections.begin('elsewhere', { clientId: a, sequence: 1, intent: 'seek' });
  const current = selections.begin('project', { clientId: a, sequence: 3, intent: 'seek' });
  assert.equal(old.signal.aborted, true);
  assert.equal(speculative.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  assert.equal(otherProject.signal.aborted, false);
  assert.throws(
    () => selections.begin('project', { clientId: a, sequence: 2, intent: 'seek' }),
    /thay đổi/,
  );
  selections.cancel('project', a, 1);
  assert.equal(current.signal.aborted, false, 'late cancellation cannot cancel newer work');
  const playback = selections.begin('project', { clientId: a, sequence: 3, intent: 'seek' });
  assert.equal(playback.signal, current.signal);
  playback.release();
  selections.cancel('project', a, 3);
  assert.equal(current.signal.aborted, true);
  assert.throws(
    () => selections.begin('project', { clientId: a, sequence: 3, intent: 'prefetch' }),
    /thay đổi/,
  );
  for (const lease of [old, speculative, other, otherProject, current]) {
    lease.release();
    lease.release();
  }
});
test('selection tombstones are bounded, retain active leases across TTL and drain on shutdown', () => {
  let now = 0;
  const selections = new PreviewSelections(1, 100, () => now);
  const active = selections.begin('project', { clientId: 'A', sequence: 1, intent: 'seek' });
  now = 101;
  assert.throws(
    () => selections.begin('project', { clientId: 'B', sequence: 1, intent: 'seek' }),
    /Quá nhiều/,
  );
  active.release();
  now = 202;
  const next = selections.begin('project', { clientId: 'B', sequence: 1, intent: 'seek' });
  selections.shutdown();
  assert.equal(next.signal.aborted, true);
  next.release();
  assert.throws(
    () => selections.begin('project', { clientId: 'B', sequence: 2, intent: 'seek' }),
    /đang dừng/,
  );
});
test('canceling a selection removes queued speculative work before resuming exports and prioritizes seek', async () => {
  const selections = new PreviewSelections(),
    scheduler = new MediaScheduler();
  const resume = scheduler.beginExport();
  const seen: string[] = [];
  const old = selections.begin('project', { clientId: 'A', sequence: 1, intent: 'prefetch' });
  const pending = scheduler.schedule(
    async () => {
      seen.push('old');
    },
    { signal: old.signal, priority: 'prefetch' },
  );
  const current = selections.begin('project', { clientId: 'A', sequence: 2, intent: 'seek' });
  const speculative = scheduler.schedule(
    async () => {
      seen.push('prefetch');
    },
    { signal: current.signal, priority: 'prefetch' },
  );
  const seek = scheduler.schedule(
    async () => {
      seen.push('seek');
    },
    { signal: current.signal, priority: 'seek' },
  );
  await assert.rejects(pending.promise, /thay đổi/);
  resume();
  await Promise.all([seek.promise, speculative.promise]);
  assert.deepEqual(seen, ['seek', 'prefetch']);
  old.release();
  current.release();
  await scheduler.shutdown();
});
test('shared preview contracts validate paired client/sequence, bounds and prohibit full-resolution prefetch', () => {
  const body = { revision: 1, frameIndex: 0, mode: 'interactive' };
  assert.equal(previewRequestSchema.parse(body).intent, 'seek');
  for (const extra of [
    { clientId: randomUUID() },
    { sequence: 1 },
    { intent: 'prefetch' },
    { clientId: randomUUID(), sequence: 0 },
    { clientId: randomUUID(), sequence: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(previewRequestSchema.safeParse({ ...body, ...extra }).success, false);
  assert.equal(
    previewRequestSchema.safeParse({
      ...body,
      clientId: randomUUID(),
      sequence: 1,
      intent: 'prefetch',
    }).success,
    true,
  );
  assert.equal(
    previewRequestSchema.safeParse({
      ...body,
      mode: 'output-check',
      clientId: randomUUID(),
      sequence: 1,
      intent: 'prefetch',
    }).success,
    false,
  );
  assert.equal(
    audioPreviewRequestSchema.safeParse({ revision: 1, clientId: randomUUID() }).success,
    false,
  );
  assert.equal(
    audioPreviewRequestSchema.safeParse({ revision: 1, clientId: randomUUID(), sequence: 3 })
      .success,
    true,
  );
  assert.equal(
    previewCancelSchema.safeParse({ clientId: randomUUID(), sequence: 4, command: 'stop' }).success,
    false,
  );
});
