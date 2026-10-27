import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Workspace, atomicJSON, readJSON } from '../apps/server/src/storage/workspace.js';
import { Quota } from '../apps/server/src/storage/quota.js';
import { Imports } from '../apps/server/src/services/imports.js';
import { Exports } from '../apps/server/src/jobs/exports.js';
import { Engine } from '../apps/server/src/media/engine.js';
import { limitsSchema, exportJobSchema, type ExportJob } from '../packages/contracts/src/index.js';
import { assetRegistrySchema, importSessionSchema } from '../apps/server/src/storage/manifests.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-manifest-'));
  const ws = new Workspace(root);
  await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0 });
  const engine = new Engine('/missing/ffmpeg', '/missing/ffprobe');
  const imports = new Imports(ws, limits, new Quota(ws, limits), engine);
  await imports.init();
  const project = await ws.createProject('Recovery');
  const image = await sharp({ create: { width: 16, height: 24, channels: 3, background: 'blue' } })
    .png()
    .toBuffer();
  const session = await imports.create(project.id, {
    expectedRevision: project.revision,
    purpose: 'frames',
    mode: 'replace',
    files: [
      {
        clientFileId: randomUUID(),
        name: 'source.png',
        relativePath: 'source.png',
        size: image.length,
      },
    ],
  });
  await imports.upload(session.id, session.files[0]!.fileId, Readable.from(image));
  const accepted = imports.get(session.id);
  const source = (await imports.asset(accepted.files[0]!.assetId!)).path;
  const manifest = ws.objectPath('uploads', session.id, 'manifest.json');
  return {
    ws,
    imports,
    limits,
    engine,
    project,
    accepted,
    source,
    image,
    manifest,
    restarted: () => new Imports(ws, limits, new Quota(ws, limits), engine),
    close: async () => {
      await ws.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function job(projectId: string, revision: number): ExportJob {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId,
    projectRevision: revision,
    kind: 'video',
    status: 'encoding',
    totalFrames: 1,
    processedFrames: 0,
    encodedFrames: 0,
    percent: 0,
    sequence: 2,
    createdAt: now,
    updatedAt: now,
    elapsedMs: 10,
    speedFps: null,
    etaMs: null,
    fileName: 'output.mp4',
    result: null,
    error: null,
  };
}
const code = (expected: string) => (error: unknown) =>
  (error as { code: string }).code === expected;

test('semantic import corruption recovers the last valid backup and preserves accepted sources', async () => {
  const h = await fixture();
  try {
    await atomicJSON(h.manifest, h.accepted);
    await writeFile(
      h.manifest,
      JSON.stringify({ ...h.accepted, files: [{ ...h.accepted.files[0], assetId: undefined }] }),
    );
    const restarted = h.restarted();
    await restarted.init();
    assert.equal(restarted.get(h.accepted.id).files[0]!.assetId, h.accepted.files[0]!.assetId);
    assert.deepEqual(await readFile(h.source), h.image);
    assert.equal(JSON.parse(await readFile(h.manifest, 'utf8')).id, h.accepted.id);
  } finally {
    await h.close();
  }
});
test('unrecoverable manifest corruption fails closed without deleting its directory, partial bytes or accepted media', async () => {
  const h = await fixture();
  try {
    const partial = h.ws.objectPath(
      'uploads',
      h.accepted.id,
      `${h.accepted.files[0]!.fileId}.part`,
    );
    await writeFile(partial, 'keep until metadata is repaired');
    await writeFile(h.manifest, '{broken');
    await writeFile(`${h.manifest}.bak`, JSON.stringify({ files: null }));
    await assert.rejects(h.restarted().init(), code('CORRUPT_IMPORT'));
    assert.equal(await readFile(partial, 'utf8'), 'keep until metadata is repaired');
    assert.deepEqual(await readFile(h.source), h.image);
    assert((await stat(h.ws.path('uploads', h.accepted.id))).isDirectory());
  } finally {
    await h.close();
  }
});
test('missing primary with an invalid backup is corruption, not an empty registry or a nonexistent project', async () => {
  const h = await fixture();
  try {
    const registry = h.ws.path('registry/assets.json');
    await writeFile(`${registry}.bak`, JSON.stringify([{ id: randomUUID(), fileSize: -1 }]));
    await rm(registry);
    await assert.rejects(h.restarted().init(), code('CORRUPT_REGISTRY'));
    assert.deepEqual(await readFile(h.source), h.image);
    await assert.rejects(
      stat(registry),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    const projectPath = h.ws.objectPath('projects', h.project.id, 'project.json');
    await rm(projectPath);
    await writeFile(`${projectPath}.bak`, JSON.stringify({ ...h.project, id: 'invalid' }));
    await assert.rejects(h.ws.project(h.project.id), code('CORRUPT_PROJECT'));
    const path = h.ws.path('registry/raw.json');
    await writeFile(`${path}.bak`, '{invalid');
    await assert.rejects(
      readJSON(path, (raw) => raw),
      SyntaxError,
    );
  } finally {
    await h.close();
  }
});
test('folder identity validation runs inside recovery for both projects and import sessions', async () => {
  const h = await fixture();
  try {
    await atomicJSON(h.manifest, h.accepted);
    await writeFile(h.manifest, JSON.stringify({ ...h.accepted, id: randomUUID() }));
    await h.restarted().init();
    assert.equal(JSON.parse(await readFile(h.manifest, 'utf8')).id, h.accepted.id);
    const path = h.ws.objectPath('projects', h.project.id, 'project.json');
    await atomicJSON(path, h.project);
    await writeFile(path, JSON.stringify({ ...h.project, id: randomUUID() }));
    assert.equal((await h.ws.project(h.project.id)).id, h.project.id);
  } finally {
    await h.close();
  }
});
test('schemas reject duplicate IDs, traversal, malformed accepted bytes and inconsistent completed job metadata', async () => {
  const h = await fixture();
  try {
    const assets = JSON.parse(
      await readFile(h.ws.path('registry/assets.json'), 'utf8'),
    ) as unknown[];
    assert.equal(assetRegistrySchema.safeParse([...assets, ...assets]).success, false);
    assert.equal(
      importSessionSchema.safeParse({
        ...h.accepted,
        files: [...h.accepted.files, ...h.accepted.files],
      }).success,
      false,
    );
    assert.equal(
      importSessionSchema.safeParse({
        ...h.accepted,
        files: [{ ...h.accepted.files[0], fileId: '../escape' }],
      }).success,
      false,
    );
    assert.equal(
      importSessionSchema.safeParse({
        ...h.accepted,
        files: [{ ...h.accepted.files[0], receivedBytes: 0 }],
      }).success,
      false,
    );
    const base = job(h.project.id, h.project.revision);
    assert.equal(exportJobSchema.safeParse({ ...base, processedFrames: 2 }).success, false);
    const completed = {
      ...base,
      status: 'completed',
      processedFrames: 1,
      encodedFrames: 1,
      percent: 100,
      result: { bytes: 5, durationUs: 1000, mime: 'video/mp4' },
    };
    assert.equal(exportJobSchema.safeParse(completed).success, true);
    assert.equal(exportJobSchema.safeParse({ ...completed, kind: 'cli' }).success, false);
    assert.equal(
      exportJobSchema.safeParse({ ...completed, result: null }).success,
      true,
      'deleted output remains valid completed history',
    );
  } finally {
    await h.close();
  }
});
test('job recovery validates snapshot before interrupting or deleting partial output and cannot redirect cleanup by job ID', async () => {
  const h = await fixture();
  try {
    const project = await h.imports.finalize(h.accepted.id, h.project.revision),
      draft = job(project.id, project.revision);
    const status = h.ws.objectPath('jobs', draft.id, 'status.json');
    const snapshot = h.ws.objectPath('jobs', draft.id, 'snapshot.json');
    await atomicJSON(status, draft);
    const withoutSnapshot = new Exports(
      h.ws,
      h.imports,
      h.engine,
      new Quota(h.ws, h.limits),
      h.limits,
    );
    await assert.rejects(withoutSnapshot.init(), code('CORRUPT_JOB_SNAPSHOT'));
    await atomicJSON(snapshot, { ...project, revision: project.revision + 1 });
    const partial = h.ws.objectPath('outputs', draft.id, 'video.part.mp4');
    await mkdir(h.ws.path('outputs', draft.id), { recursive: true });
    await writeFile(partial, 'unverified');
    const restarted = () =>
      new Exports(h.ws, h.imports, h.engine, new Quota(h.ws, h.limits), h.limits);
    await assert.rejects(restarted().init(), code('CORRUPT_JOB_SNAPSHOT'));
    assert.equal(await readFile(partial, 'utf8'), 'unverified');
    assert.equal(JSON.parse(await readFile(status, 'utf8')).status, 'encoding');
    await atomicJSON(snapshot, project);
    await atomicJSON(status, draft);
    await writeFile(status, JSON.stringify({ ...draft, id: randomUUID() }));
    const restored = restarted();
    await restored.init();
    assert.equal(restored.get(draft.id).status, 'interrupted');
    await assert.rejects(
      stat(partial),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    await assert.rejects(restored.resultPath(draft.id), /chưa hoàn tất/);
    assert.deepEqual(await readFile(h.source), h.image);
  } finally {
    await h.close();
  }
});
test('dangling operation indexes stop startup before import partial cleanup or job mutation', async () => {
  const h = await fixture();
  try {
    const partial = h.ws.objectPath(
      'uploads',
      h.accepted.id,
      `${h.accepted.files[0]!.fileId}.part`,
    );
    await writeFile(partial, 'partial');
    await atomicJSON(h.ws.path('registry/import-operations.json'), {
      [randomUUID()]: { hash: 'a'.repeat(64), importId: randomUUID() },
    });
    await assert.rejects(h.restarted().init(), code('CORRUPT_IMPORT_INDEX'));
    assert.equal(await readFile(partial, 'utf8'), 'partial');
    await atomicJSON(h.ws.path('registry/operations.json'), {
      [randomUUID()]: { hash: 'b'.repeat(64), jobId: randomUUID() },
    });
    const jobs = new Exports(h.ws, h.imports, h.engine, new Quota(h.ws, h.limits), h.limits);
    await assert.rejects(jobs.init(), code('CORRUPT_JOB_INDEX'));
    assert.deepEqual(await readFile(h.source), h.image);
  } finally {
    await h.close();
  }
});

test('project commit marker repairs an older incomplete upload checkpoint without invalidating the next restart', async () => {
  const h = await fixture();
  try {
    const older = JSON.parse(await readFile(`${h.manifest}.bak`, 'utf8'));
    assert.equal(older.files[0].status, 'pending');
    const committed = await h.imports.finalize(h.accepted.id, h.project.revision);
    await writeFile(h.manifest, JSON.stringify(older));
    const restarted = h.restarted();
    await restarted.init();
    assert.equal(restarted.get(h.accepted.id).status, 'finalized');
    assert.equal((await restarted.finalize(h.accepted.id, 1)).revision, committed.revision);
    const again = h.restarted();
    await again.init();
    assert.equal(again.get(h.accepted.id).resultRevision, committed.revision);
    assert.deepEqual(await readFile(h.source), h.image);
  } finally {
    await h.close();
  }
});
