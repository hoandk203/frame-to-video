import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Workspace, atomicJSON } from '../apps/server/src/storage/workspace.js';
import {
  publishRecord,
  preflightStages,
  readCreation,
  type CreationIntent,
} from '../apps/server/src/storage/creation.js';
import { Imports } from '../apps/server/src/services/imports.js';
import { Exports } from '../apps/server/src/jobs/exports.js';
import { Projects } from '../apps/server/src/services/projects.js';
import { Engine } from '../apps/server/src/media/engine.js';
import { Quota } from '../apps/server/src/storage/quota.js';
import { limitsSchema, type ExportJob } from '../packages/contracts/src/index.js';

const hash = (raw: unknown) => createHash('sha256').update(JSON.stringify(raw)).digest('hex');
const code = (expected: string) => (error: unknown) =>
  (error as { code: string }).code === expected;
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-create-'));
  const ws = new Workspace(root);
  await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0 });
  const engine = new Engine('/missing/ffmpeg', '/missing/ffprobe'),
    quota = new Quota(ws, limits);
  const imports = new Imports(ws, limits, quota, engine);
  await imports.init();
  return {
    root,
    ws,
    limits,
    engine,
    quota,
    imports,
    restartImports: () => new Imports(ws, limits, new Quota(ws, limits), engine),
    jobs: () => new Exports(ws, imports, engine, new Quota(ws, limits), limits),
    close: async () => {
      await ws.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function intent(collection: CreationIntent['collection'], objectId = randomUUID()): CreationIntent {
  return {
    schemaVersion: 1,
    collection,
    objectId,
    operationKey: randomUUID(),
    hash: 'a'.repeat(64),
  };
}
async function frameProject(h: Awaited<ReturnType<typeof setup>>) {
  const project = await h.ws.createProject('Creation fault');
  const data = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const session = await h.imports.create(project.id, {
    expectedRevision: project.revision,
    purpose: 'frames',
    mode: 'replace',
    files: [
      {
        clientFileId: randomUUID(),
        name: 'image.png',
        relativePath: 'image.png',
        size: data.length,
      },
    ],
  });
  await h.imports.upload(session.id, session.files[0]!.fileId, Readable.from(data));
  return h.imports.finalize(session.id, project.revision);
}
function draft(projectId: string, projectRevision: number): ExportJob {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId,
    projectRevision,
    kind: 'video',
    status: 'validating',
    processedFrames: 0,
    encodedFrames: 0,
    totalFrames: 1,
    percent: 0,
    sequence: 0,
    createdAt: now,
    updatedAt: now,
    elapsedMs: 0,
    speedFps: null,
    etaMs: null,
    fileName: 'output.mp4',
    result: null,
    error: null,
  };
}

test('record publication exposes a complete UUID directory and fails without merging or deleting existing state', async () => {
  const h = await setup();
  try {
    const creation = intent('uploads');
    await publishRecord(h.ws, creation, { 'manifest.json': { complete: true } });
    assert.deepEqual(
      JSON.parse(
        await readFile(h.ws.objectPath('uploads', creation.objectId, 'manifest.json'), 'utf8'),
      ),
      { complete: true },
    );
    assert.deepEqual(await readCreation(h.ws, 'uploads', creation.objectId), creation);
    await assert.rejects(
      stat(h.ws.path('uploads', `.creating-${creation.objectId}`)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    await assert.rejects(
      publishRecord(h.ws, creation, { 'manifest.json': { replaced: true } }),
      code('RECORD_EXISTS'),
    );
    assert.equal(
      JSON.parse(
        await readFile(h.ws.objectPath('uploads', creation.objectId, 'manifest.json'), 'utf8'),
      ).complete,
      true,
    );
    const invalid = intent('uploads'),
      circular: { self?: unknown } = {};
    circular.self = circular;
    await assert.rejects(publishRecord(h.ws, invalid, { 'manifest.json': circular }), TypeError);
    await assert.rejects(stat(h.ws.objectPath('uploads', invalid.objectId, '')));
    await assert.rejects(stat(h.ws.path('uploads', `.creating-${invalid.objectId}`)));
    const collision = intent('jobs'),
      stage = h.ws.path('jobs', `.creating-${collision.objectId}`);
    await mkdir(stage);
    await writeFile(join(stage, 'user.txt'), 'keep');
    await assert.rejects(
      publishRecord(h.ws, collision, { 'snapshot.json': {}, 'status.json': {} }),
    );
    assert.equal(await readFile(join(stage, 'user.txt'), 'utf8'), 'keep');
  } finally {
    await h.close();
  }
});

test('preflight cleans only unpublished metadata stages and refuses indexed or unknown contents before deleting anything', async () => {
  const h = await setup();
  try {
    const first = randomUUID(),
      other = randomUUID();
    const stage = h.ws.path('uploads', `.creating-${first}`),
      unknown = h.ws.path('uploads', `.creating-${other}`);
    await mkdir(stage);
    await mkdir(unknown);
    await writeFile(join(stage, `manifest.json.${randomUUID()}.tmp`), '{partial');
    await writeFile(join(stage, 'creation.json'), '{partial');
    await writeFile(join(unknown, 'photo.png'), 'unrelated');
    await assert.rejects(preflightStages(h.ws, 'uploads', new Set()), code('CORRUPT_CREATION'));
    assert.equal((await readdir(stage)).length, 2);
    await rm(unknown, { recursive: true });
    await assert.rejects(
      preflightStages(h.ws, 'uploads', new Set([first])),
      code('CORRUPT_CREATION'),
    );
    const clean = await preflightStages(h.ws, 'uploads', new Set());
    await clean();
    await assert.rejects(stat(stage));
    const unrelated = h.ws.path('uploads', '.creating-user-notes');
    await mkdir(unrelated);
    await writeFile(join(unrelated, 'keep.txt'), 'keep');
    await (
      await preflightStages(h.ws, 'uploads', new Set())
    )();
    assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await h.close();
  }
});

test('project startup discards initial metadata staging without creating an empty visible project', async () => {
  const h = await setup();
  try {
    const saved = await h.ws.createProject('Keep existing project');
    const stageId = randomUUID(),
      stage = h.ws.path('projects', `.creating-${stageId}`);
    await mkdir(stage);
    await writeFile(join(stage, `project.json.${randomUUID()}.tmp`), '{unfinished');
    await h.ws.close();
    await h.ws.init();
    assert.deepEqual(
      (await h.ws.listProjects()).map((project) => project.id),
      [saved.id],
    );
    await assert.rejects(stat(stage));
    assert.equal((await h.ws.project(saved.id)).name, 'Keep existing project');
    const unknown = h.ws.path('projects', `.creating-${randomUUID()}`);
    await mkdir(unknown);
    await writeFile(join(unknown, 'user.png'), 'keep');
    await h.ws.close();
    await assert.rejects(h.ws.init(), code('CORRUPT_CREATION'));
    await assert.rejects(stat(h.ws.path('.workspace.lock')));
    assert.equal(await readFile(join(unknown, 'user.png'), 'utf8'), 'keep');
  } finally {
    await h.close();
  }
});

test('published import recovers a missing idempotency index and retains the same session for retries', async () => {
  const h = await setup();
  try {
    const project = await h.ws.createProject('Import publication'),
      key = randomUUID();
    const input = {
      expectedRevision: project.revision,
      purpose: 'frames',
      mode: 'replace',
      files: [
        { clientFileId: randomUUID(), name: 'image.png', relativePath: 'image.png', size: 123 },
      ],
    };
    const session = await h.imports.create(project.id, input, key);
    const registry = h.ws.path('registry/import-operations.json');
    await rm(registry);
    await rm(`${registry}.bak`, { force: true });
    const incomplete = randomUUID(),
      stage = h.ws.path('uploads', `.creating-${incomplete}`);
    await mkdir(stage);
    await writeFile(join(stage, 'creation.json'), '{partial');
    const restarted = h.restartImports();
    await restarted.init();
    assert.equal((await restarted.create(project.id, input, key)).id, session.id);
    assert.equal(restarted.list(project.id).length, 1);
    await assert.rejects(stat(stage));
    assert.equal(JSON.parse(await readFile(registry, 'utf8'))[key].importId, session.id);
    await assert.rejects(
      restarted.create(project.id, { ...input, mode: 'append' }, key),
      code('IDEMPOTENCY_CONFLICT'),
    );
  } finally {
    await h.close();
  }
});

test('published but unindexed export restores identity as interrupted and never starts the engine on retry', async () => {
  const h = await setup();
  try {
    const project = await frameProject(h),
      record = draft(project.id, project.revision),
      key = randomUUID();
    await publishRecord(
      h.ws,
      {
        schemaVersion: 1,
        collection: 'jobs',
        objectId: record.id,
        operationKey: key,
        hash: hash({
          projectId: project.id,
          revision: project.revision,
          fileName: record.fileName,
          kind: record.kind,
        }),
      },
      { 'snapshot.json': project, 'status.json': record },
    );
    const stage = h.ws.path('jobs', `.creating-${randomUUID()}`);
    await mkdir(stage);
    await writeFile(join(stage, 'snapshot.json'), '{partial');
    const jobs = h.jobs();
    await jobs.init();
    assert.equal(jobs.get(record.id).status, 'interrupted');
    const retried = await jobs.submit(project.id, project.revision, record.fileName, key);
    assert.equal(retried.id, record.id);
    assert.equal(retried.status, 'interrupted');
    assert.equal(jobs.activeJob, null);
    await assert.rejects(jobs.resultPath(record.id), /chưa hoàn tất/);
    await assert.rejects(stat(stage));
  } finally {
    await h.close();
  }
});

test('creation/index conflict preserves pending metadata and sources instead of guessing a new idempotency binding', async () => {
  const h = await setup();
  try {
    const project = await frameProject(h),
      record = draft(project.id, project.revision),
      key = randomUUID();
    await publishRecord(
      h.ws,
      {
        schemaVersion: 1,
        collection: 'jobs',
        objectId: record.id,
        operationKey: key,
        hash: 'a'.repeat(64),
      },
      { 'snapshot.json': project, 'status.json': record },
    );
    await atomicJSON(h.ws.path('registry/operations.json'), {
      [key]: { hash: 'b'.repeat(64), jobId: record.id },
    });
    const stage = h.ws.path('jobs', `.creating-${randomUUID()}`);
    await mkdir(stage);
    await writeFile(join(stage, 'creation.json'), 'keep for preflight');
    const source = await h.imports.asset(project.frames[0]!.assetId);
    await assert.rejects(h.jobs().init(), code('CORRUPT_CREATION'));
    assert.equal(await readFile(join(stage, 'creation.json'), 'utf8'), 'keep for preflight');
    assert.equal(
      JSON.parse(await readFile(h.ws.objectPath('jobs', record.id, 'status.json'), 'utf8')).status,
      'validating',
    );
    assert.equal((await stat(source.path)).size, source.fileSize);
  } finally {
    await h.close();
  }
});

test('project deletion tombstone prevents creation intents from restoring removed export index entries', async () => {
  const h = await setup();
  try {
    const project = await frameProject(h),
      record = draft(project.id, project.revision),
      key = randomUUID();
    await publishRecord(
      h.ws,
      {
        schemaVersion: 1,
        collection: 'jobs',
        objectId: record.id,
        operationKey: key,
        hash: 'a'.repeat(64),
      },
      { 'snapshot.json': project, 'status.json': record },
    );
    await mkdir(h.ws.path('trash'), { recursive: true });
    await rename(
      h.ws.objectPath('projects', project.id, ''),
      h.ws.objectPath('trash', project.id, ''),
    );
    const jobs = h.jobs();
    await jobs.init();
    const projects = new Projects(h.ws, h.imports, jobs, h.limits.maxFrames);
    await projects.init();
    assert.deepEqual(JSON.parse(await readFile(h.ws.path('registry/operations.json'), 'utf8')), {});
    await assert.rejects(stat(h.ws.objectPath('jobs', record.id, '')));
    await assert.rejects(stat(h.ws.objectPath('trash', project.id, '')));
  } finally {
    await h.close();
  }
});

test('startup removes abandoned atomic updates only after the corresponding durable records validate', async () => {
  const h = await setup();
  try {
    const project = await frameProject(h);
    const projectTemp = `${h.ws.objectPath('projects', project.id, 'project.json')}.${randomUUID()}.tmp`;
    const projectUnknown = h.ws.objectPath('projects', project.id, 'project.json.notes.tmp');
    await writeFile(projectTemp, '{interrupted update');
    await writeFile(projectUnknown, 'keep');
    const session = h.imports.list(project.id)[0];
    assert.equal(session, undefined, 'finalized imports are not open');
    const ids = await readdir(h.ws.path('uploads'));
    const importId = ids.find((value) => !value.startsWith('.'))!;
    const importTemp = `${h.ws.objectPath('uploads', importId, 'manifest.json')}.${randomUUID()}.bak.tmp`;
    await writeFile(importTemp, '{interrupted backup');
    const registryTemp = `${h.ws.path('registry/assets.json')}.${randomUUID()}.tmp`;
    await writeFile(registryTemp, '{partial');
    await h.ws.close();
    await h.ws.init();
    await assert.rejects(stat(projectTemp));
    assert.equal(await readFile(projectUnknown, 'utf8'), 'keep');
    await h.restartImports().init();
    await assert.rejects(stat(importTemp));
    await assert.rejects(stat(registryTemp));
    assert.equal((await h.ws.project(project.id)).frames.length, 1);
    const source = await h.imports.asset(project.frames[0]!.assetId);
    assert((await stat(source.path)).isFile());
  } finally {
    await h.close();
  }
});

test('unreadable durable record keeps its atomic temporary files and source data for recovery', async () => {
  const h = await setup();
  try {
    const project = await frameProject(h);
    const importId = (await readdir(h.ws.path('uploads'))).find((value) => !value.startsWith('.'))!;
    const manifest = h.ws.objectPath('uploads', importId, 'manifest.json');
    const temp = `${manifest}.${randomUUID()}.tmp`;
    await writeFile(temp, '{candidate metadata');
    await writeFile(manifest, '{broken');
    await writeFile(`${manifest}.bak`, '{broken');
    await assert.rejects(h.restartImports().init(), code('CORRUPT_IMPORT'));
    assert.equal(await readFile(temp, 'utf8'), '{candidate metadata');
    const source = await h.imports.asset(project.frames[0]!.assetId);
    assert((await stat(source.path)).isFile());
  } finally {
    await h.close();
  }
});

test('optional registry without a durable primary retains atomic candidates instead of discarding the only recovery bytes', async () => {
  const h = await setup();
  try {
    const candidate = `${h.ws.path('registry/assets.json')}.${randomUUID()}.tmp`;
    await writeFile(candidate, 'retain until a durable registry exists');
    await h.restartImports().init();
    assert.equal(await readFile(candidate, 'utf8'), 'retain until a durable registry exists');
    await frameProject(h);
    await h.restartImports().init();
    await assert.rejects(stat(candidate));
  } finally {
    await h.close();
  }
});
