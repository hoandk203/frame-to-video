import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { limitsSchema, type Project } from '../packages/contracts/src/index.js';
import { Workspace } from '../apps/server/src/storage/workspace.js';
import { Quota } from '../apps/server/src/storage/quota.js';
import { Imports } from '../apps/server/src/services/imports.js';
import { Exports } from '../apps/server/src/jobs/exports.js';
import { Projects } from '../apps/server/src/services/projects.js';
import { Engine } from '../apps/server/src/media/engine.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-project-'));
  const ws = new Workspace(root);
  await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0 });
  const engine = new Engine(
    process.env.FFMPEG_PATH ?? '/missing/ffmpeg',
    process.env.FFPROBE_PATH ?? '/missing/ffprobe',
  );
  const quota = new Quota(ws, limits),
    imports = new Imports(ws, limits, quota, engine);
  await imports.init();
  const jobs = new Exports(ws, imports, engine, quota, limits);
  await jobs.init();
  const projects = new Projects(ws, imports, jobs, limits.maxFrames);
  await projects.init();
  return {
    root,
    ws,
    imports,
    jobs,
    projects,
    quota,
    close: async () => {
      await jobs.shutdown();
      await ws.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function png(color = 'red') {
  return sharp({ create: { width: 24, height: 40, channels: 4, background: color } })
    .png()
    .toBuffer();
}
async function upload(
  h: Awaited<ReturnType<typeof setup>>,
  p: Project,
  files: Buffer[],
  mode: 'replace' | 'append' | 'relink' = 'replace',
) {
  const session = await h.imports.create(p.id, {
    expectedRevision: p.revision,
    purpose: 'frames',
    mode,
    files: files.map((data, i) => ({
      clientFileId: randomUUID(),
      name: `frame_${i}.png`,
      relativePath: `frames/frame_${i}.png`,
      size: data.length,
    })),
  });
  for (let i = 0; i < files.length; i++)
    await h.imports.upload(session.id, session.files[i]!.fileId, Readable.from(files[i]!));
  return { session, finalize: () => h.imports.finalize(session.id, p.revision) };
}

test('config import resolves by verified content, creates a new project and ignores source IDs from another workspace', async () => {
  const first = await setup(),
    second = await setup();
  try {
    let p = await first.ws.createProject('Cấu hình');
    p = await (await upload(first, p, [await png(), await png('blue')])).finalize();
    p = await first.ws.updateProject(p.id, p.revision, (p) => ({
      ...p,
      frames: [...p.frames].reverse(),
      video: { ...p.video, fps: 60, aspectRatio: '9:16' },
    }));
    const config = await first.projects.exportConfig(p.id);
    const sameWorkspace = await first.projects.importConfig(config);
    assert.notEqual(sameWorkspace.id, p.id);
    assert.equal(sameWorkspace.revision, 1);
    assert.deepEqual(
      sameWorkspace.frames.map((f) => f.assetId),
      p.frames.map((f) => f.assetId),
    );
    const imported = await second.projects.importConfig(config);
    assert.equal(imported.video.fps, 60);
    assert.equal(imported.video.aspectRatio, '9:16');
    assert.deepEqual(
      imported.frames.map((f) => f.sha256),
      p.frames.map((f) => f.sha256),
    );
    assert(imported.frames.every((f) => f.status === 'missing'));
    assert(imported.frames.every((f) => !p.frames.some((old) => old.assetId === f.assetId)));
    await assert.rejects(
      second.jobs.submit(imported.id, imported.revision, 'output.mp4', randomUUID()),
      /ảnh hợp lệ/,
    );
    await assert.rejects(
      second.projects.importConfig({ ...config, command: 'anything.exe' }),
      /Unrecognized key/,
    );
    const bad = structuredClone(config);
    bad.project.frames[0]!.relativePath = '../outside';
    await assert.rejects(second.projects.importConfig(bad), /Đường dẫn/);
  } finally {
    await first.close();
    await second.close();
  }
});

test('relink accepts matching image content, retains frame order/settings and rejects wrong content', async () => {
  const first = await setup(),
    second = await setup();
  try {
    const inputs = [await png(), await png('blue')];
    let p = await (await upload(first, await first.ws.createProject('Relink'), inputs)).finalize();
    p = await first.ws.updateProject(p.id, p.revision, (p) => ({
      ...p,
      frames: [...p.frames].reverse(),
      video: { ...p.video, fps: 30 },
    }));
    let imported = await second.projects.importConfig(await first.projects.exportConfig(p.id));
    const oldOrder = imported.frames.map((f) => f.id);
    const wrong = await upload(second, imported, [await png('green')], 'relink');
    await assert.rejects(wrong.finalize(), /không khớp/);
    await second.imports.cancel(wrong.session.id);
    const accepted = await upload(second, imported, inputs, 'relink');
    imported = await accepted.finalize();
    assert.deepEqual(
      imported.frames.map((f) => f.id),
      oldOrder,
    );
    assert.deepEqual(
      imported.frames.map((f) => f.sha256),
      p.frames.map((f) => f.sha256),
    );
    assert(imported.frames.every((f) => f.status === 'valid'));
    assert.equal(imported.video.fps, 30);
  } finally {
    await first.close();
    await second.close();
  }
});

test('garbage collection retains shared projects, last-good backup and active leases; deleting final reference removes copies only', async () => {
  const h = await setup();
  const sourceRoot = await mkdtemp(join(tmpdir(), 'ftvs-originals-'));
  try {
    const data = await png();
    const original = join(sourceRoot, 'original.png');
    await writeFile(original, data);
    const p = await (await upload(h, await h.ws.createProject('first'), [data])).finalize();
    const assetId = p.frames[0]!.assetId;
    const second = await h.projects.importConfig(await h.projects.exportConfig(p.id));
    await h.projects.remove(p.id, p.revision);
    assert((await h.imports.asset(assetId)).fileSize > 0);
    const release = h.imports.pin(assetId);
    await h.projects.remove(second.id, second.revision);
    assert((await h.imports.asset(assetId)).fileSize > 0);
    release();
    await h.imports.collectGarbage();
    await assert.rejects(h.imports.asset(assetId), /Không tìm thấy nguồn/);
    assert.equal((await stat(original)).size, data.length, 'never deletes user original');
    const backed = await (await upload(h, await h.ws.createProject('backup'), [data])).finalize();
    const oldAsset = backed.frames[0]!.assetId;
    let empty = await h.ws.updateProject(backed.id, backed.revision, (p) => ({ ...p, frames: [] }));
    await h.imports.collectGarbage();
    assert(await h.imports.asset(oldAsset));
    empty = await h.ws.updateProject(empty.id, empty.revision, (p) => ({ ...p, name: 'next' }));
    await h.imports.collectGarbage();
    await assert.rejects(h.imports.asset(oldAsset), /Không tìm thấy nguồn/);
  } finally {
    await h.close();
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test(
  'audio configuration survives transport and content relink preserves volume and loop policy',
  { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH },
  async () => {
    const first = await setup(),
      second = await setup();
    try {
      let p = await (
        await upload(first, await first.ws.createProject('audio config'), [await png()])
      ).finalize();
      const wave = Buffer.alloc(44 + 9600);
      wave.write('RIFF', 0);
      wave.writeUInt32LE(wave.length - 8, 4);
      wave.write('WAVEfmt ', 8);
      wave.writeUInt32LE(16, 16);
      wave.writeUInt16LE(1, 20);
      wave.writeUInt16LE(1, 22);
      wave.writeUInt32LE(48000, 24);
      wave.writeUInt32LE(96000, 28);
      wave.writeUInt16LE(2, 32);
      wave.writeUInt16LE(16, 34);
      wave.write('data', 36);
      wave.writeUInt32LE(9600, 40);
      const input = (project: Project, mode: 'replace' | 'relink') => ({
        expectedRevision: project.revision,
        purpose: 'audio',
        mode,
        files: [
          {
            clientFileId: randomUUID(),
            name: 'nhạc.wav',
            relativePath: 'nhạc.wav',
            size: wave.length,
          },
        ],
      });
      const incoming = await first.imports.create(p.id, input(p, 'replace'));
      await first.imports.upload(incoming.id, incoming.files[0]!.fileId, Readable.from(wave));
      p = await first.imports.finalize(incoming.id, p.revision);
      p = await first.ws.updateProject(p.id, p.revision, (p) => ({
        ...p,
        audio: { ...p.audio!, volume: 1.4, shortTrackPolicy: 'loop' },
      }));
      let transported = await second.projects.importConfig(await first.projects.exportConfig(p.id));
      assert.equal(transported.audio?.status, 'missing');
      assert.equal(transported.audio?.volume, 1.4);
      assert.equal(transported.audio?.shortTrackPolicy, 'loop');
      const linked = await second.imports.create(transported.id, input(transported, 'relink'));
      await second.imports.upload(linked.id, linked.files[0]!.fileId, Readable.from(wave));
      transported = await second.imports.finalize(linked.id, transported.revision);
      assert.equal(transported.audio?.status, 'valid');
      assert.equal(transported.audio?.volume, 1.4);
      assert.equal(transported.audio?.shortTrackPolicy, 'loop');
      assert.equal(transported.audio?.sha256, p.audio?.sha256);
    } finally {
      await first.close();
      await second.close();
    }
  },
);

test(
  'project deletion protects result readers and removes finished job history and output together',
  { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH },
  async () => {
    const h = await setup();
    try {
      let p = await (
        await upload(h, await h.ws.createProject('delete finished'), [await png()])
      ).finalize();
      p = await h.ws.updateProject(p.id, p.revision, (p) => ({
        ...p,
        video: { ...p.video, resolution: '720p' },
      }));
      const job = await h.jobs.submit(p.id, p.revision, 'output.mp4', randomUUID());
      for (let n = 0; n < 400 && !['completed', 'failed'].includes(h.jobs.get(job.id).status); n++)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(h.jobs.get(job.id).status, 'completed');
      const output = await h.jobs.resultPath(job.id);
      const release = h.jobs.acquireReader(job.id);
      await assert.rejects(h.projects.remove(p.id, p.revision), /đang được đọc/);
      assert(await h.ws.project(p.id));
      release();
      const finishDelete = h.jobs.beginProjectDeletion(p.id);
      assert.throws(() => h.jobs.acquireReader(job.id), /đang được xóa/);
      finishDelete();
      await h.projects.remove(p.id, p.revision);
      await assert.rejects(stat(output));
      assert.throws(() => h.jobs.get(job.id), /Không tìm thấy tác vụ/);
      assert.equal((await h.ws.listProjects()).length, 0);
    } finally {
      await h.close();
    }
  },
);

test('quota information remains readable when writes are blocked', async () => {
  const h = await setup();
  try {
    const quota = new Quota(
      h.ws,
      limitsSchema.parse({ minFreeDiskBytes: 0, workspaceQuotaBytes: 1 }),
    );
    assert((await quota.info()).usage > 1);
    await assert.rejects(quota.check(), /Quota/);
  } finally {
    await h.close();
  }
});

test('project deletion refuses revision conflict/open import and corrupted metadata cannot authorize GC', async () => {
  const h = await setup();
  try {
    const p = await h.ws.createProject('protected');
    await assert.rejects(h.projects.remove(p.id, 99), /thay đổi/);
    const incoming = await upload(h, p, [await png()]);
    await assert.rejects(h.projects.remove(p.id, p.revision), /hủy nhập/);
    await h.imports.cancel(incoming.session.id);
    const retained = await h.imports.asset(h.imports.get(incoming.session.id).files[0]!.assetId!);
    await writeFile(h.ws.objectPath('projects', p.id, 'project.json'), '{broken');
    await assert.rejects(h.imports.collectGarbage());
    assert.equal((await stat(retained.path)).size, retained.fileSize);
  } finally {
    await h.close();
  }
});

test('source integrity verification rejects same-size external edits', async () => {
  const h = await setup();
  try {
    const p = await (
      await upload(h, await h.ws.createProject('integrity'), [await png()])
    ).finalize();
    const asset = await h.imports.asset(p.frames[0]!.assetId, true);
    await writeFile(asset.path, Buffer.alloc(asset.fileSize));
    await assert.rejects(h.imports.asset(asset.id, true), /Nội dung nguồn/);
    assert.equal(await h.imports.findByHash(asset.sha256, 'frames'), null);
  } finally {
    await h.close();
  }
});

test('opening a project detects missing or edited managed sources and keeps settings for relink', async () => {
  const h = await setup();
  try {
    const data = await png();
    const p = await (
      await upload(h, await h.ws.createProject('open validation'), [data])
    ).finalize();
    const asset = await h.imports.asset(p.frames[0]!.assetId);
    await rm(asset.path);
    let opened = await h.projects.open(p.id);
    assert.equal(opened.frames[0]!.status, 'missing');
    assert.equal(opened.revision, p.revision + 1);
    assert.deepEqual(opened.video, p.video);
    await writeFile(asset.path, data);
    opened = await h.projects.open(p.id);
    assert.equal(opened.frames[0]!.status, 'valid');
    assert.equal(opened.revision, p.revision + 2);
    assert.equal(
      (await h.projects.open(p.id)).revision,
      opened.revision,
      'unchanged open does not create revisions',
    );
    await writeFile(asset.path, Buffer.alloc(data.length));
    opened = await h.projects.open(p.id);
    assert.equal(opened.frames[0]!.status, 'missing');
  } finally {
    await h.close();
  }
});
