import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeJobUpdate } from '../apps/web/src/features/export/job-state.js';

test('late poll or old-project responses cannot roll back newer SSE state or current export', () => {
  const base = {
    id: 'job-a',
    projectId: 'project-a',
    createdAt: '2026-10-27T00:00:00.000Z',
    sequence: 1,
    status: 'encoding',
  };
  const completed = { ...base, sequence: 5, status: 'completed' };
  let state = mergeJobUpdate(null, base);
  state = mergeJobUpdate(state, completed);
  state = mergeJobUpdate(state, { ...base, sequence: 2 });
  assert.equal(state.status, 'completed');
  assert.equal(state.sequence, 5);
  const next = { ...base, id: 'job-b', createdAt: '2026-10-27T00:01:00.000Z' };
  state = mergeJobUpdate(state, next);
  assert.equal(mergeJobUpdate(state, completed).id, 'job-b');
  assert.equal(
    mergeJobUpdate(state, { ...completed, projectId: 'other-project' }).projectId,
    'project-a',
  );
});
