import type { ExportJob } from '../../../../../packages/contracts/src/index.js';

type OrderedJob = Pick<ExportJob, 'id' | 'projectId' | 'sequence' | 'createdAt'>;
/** Merge asynchronous SSE/poll/history responses; explicit project selection resets current to null. */
export function mergeJobUpdate<T extends OrderedJob>(current: T | null, incoming: T): T {
  if (!current) return incoming;
  if (current.projectId !== incoming.projectId) return current;
  if (current.id === incoming.id) return incoming.sequence >= current.sequence ? incoming : current;
  return incoming.createdAt >= current.createdAt ? incoming : current;
}
