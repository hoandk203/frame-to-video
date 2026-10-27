import { mkdir, lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { id } from '../../../../packages/contracts/src/index.js';
import { assert, AppError } from '../errors.js';
import { atomicJSON, type Workspace } from './workspace.js';
import { readManifest, stored } from './manifests.js';

type Collection = 'uploads' | 'jobs' | 'projects';
export const creationIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    collection: z.enum(['uploads', 'jobs', 'projects']),
    objectId: id,
    operationKey: id,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CreationIntent = z.infer<typeof creationIntentSchema>;
const stagePattern = /^\.creating-([0-9a-f-]{36})$/;
const token = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function metadataName(name: string, collection: Collection) {
  const base =
    collection === 'uploads'
      ? '(?:creation|manifest)\\.json'
      : collection === 'jobs'
        ? '(?:creation|snapshot|status)\\.json'
        : '(?:creation|project)\\.json';
  return new RegExp(`^${base}(?:\\.${token}\\.(?:bak\\.)?tmp)?$`).test(name);
}
async function absent(path: string) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
async function stageFiles(ws: Workspace, collection: Collection, objectId: string) {
  const path = ws.path(collection, `.creating-${id.parse(objectId)}`);
  const root = await lstat(path);
  assert(
    root.isDirectory() && !root.isSymbolicLink(),
    'CORRUPT_CREATION',
    'Staging metadata không phải thư mục nội bộ.',
    500,
  );
  const files = await readdir(path, { withFileTypes: true });
  assert(
    files.every((file) => file.isFile() && metadataName(file.name, collection)),
    'CORRUPT_CREATION',
    'Staging có file không nhận diện được; giữ nguyên để phục hồi.',
    500,
  );
  return { path, names: files.map((file) => file.name) };
}
async function removeStage(ws: Workspace, collection: Collection, objectId: string) {
  const stage = await stageFiles(ws, collection, objectId);
  for (const name of stage.names) await unlink(ws.path(collection, `.creating-${objectId}`, name));
  await rmdir(stage.path); // never recursively delete an unknown tree
}
/** Only complete metadata becomes a discoverable UUID directory. No upload/encoder can use the staging name. */
export async function publishRecord(
  ws: Workspace,
  intentRaw: CreationIntent,
  records: Record<string, unknown>,
) {
  const intent = creationIntentSchema.parse(intentRaw);
  const { collection, objectId } = intent;
  const expected =
    collection === 'uploads'
      ? ['manifest.json']
      : collection === 'jobs'
        ? ['snapshot.json', 'status.json']
        : ['project.json'];
  assert(
    Object.keys(records).length === expected.length &&
      expected.every((name) => Object.hasOwn(records, name)),
    'INVALID_CREATION',
    'Record creation thiếu metadata.',
  );
  const target = ws.objectPath(collection, objectId, '');
  assert(await absent(target), 'RECORD_EXISTS', 'Thư mục record đã tồn tại.', 409);
  const stage = ws.path(collection, `.creating-${objectId}`);
  await mkdir(stage); // exclusive ownership; existing staging is never merged or deleted
  let staged = true;
  try {
    await atomicJSON(ws.path(collection, `.creating-${objectId}`, 'creation.json'), intent, false);
    for (const name of expected)
      await atomicJSON(ws.path(collection, `.creating-${objectId}`, name), records[name], false);
    await rename(stage, target);
    staged = false;
  } catch (error) {
    if (staged) await removeStage(ws, collection, objectId);
    throw error;
  }
}
/** Discover only private metadata stages; validate all before allowing any cleanup. */
export async function preflightStages(ws: Workspace, collection: Collection, indexed: Set<string>) {
  const stages: string[] = [];
  for (const entry of await readdir(ws.path(collection), { withFileTypes: true })) {
    const match = stagePattern.exec(entry.name);
    if (!match || !id.safeParse(match[1]).success) continue;
    const objectId = match[1]!;
    assert(
      !indexed.has(objectId),
      'CORRUPT_CREATION',
      'Index tham chiếu record còn trong staging; giữ nguyên dữ liệu.',
      500,
    );
    await stageFiles(ws, collection, objectId);
    stages.push(objectId);
  }
  return async () => {
    for (const objectId of stages) await removeStage(ws, collection, objectId);
  };
}
export async function readCreation(ws: Workspace, collection: Collection, objectId: string) {
  return readManifest(
    ws.objectPath(collection, objectId, 'creation.json'),
    (raw) => {
      const intent = stored(creationIntentSchema, raw, 'CORRUPT_CREATION');
      assert(
        intent.collection === collection && intent.objectId === objectId,
        'CORRUPT_CREATION',
        'Creation intent không khớp record.',
        500,
      );
      return intent;
    },
    'CORRUPT_CREATION',
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // legacy records
    throw error;
  });
}
export function restoreOperation<T>(
  operations: Record<string, T>,
  intent: CreationIntent | null,
  create: (intent: CreationIntent) => T,
  matches: (value: T, intent: CreationIntent) => boolean,
) {
  if (!intent) return false;
  const existing = operations[intent.operationKey];
  if (existing) {
    if (!matches(existing, intent))
      throw new AppError(
        'CORRUPT_CREATION',
        'Creation intent xung đột với idempotency index.',
        500,
      );
    return false;
  }
  operations[intent.operationKey] = create(intent);
  return true;
}
