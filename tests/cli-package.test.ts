import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, mkdir, writeFile, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { limitsSchema } from '../packages/contracts/src/index.js';
import { Workspace } from '../apps/server/src/storage/workspace.js';
import { Quota } from '../apps/server/src/storage/quota.js';
import { Imports } from '../apps/server/src/services/imports.js';
import { Engine, preparedEncoderArgs } from '../apps/server/src/media/engine.js';
import { capture } from '../apps/server/src/media/process.js';
import {
  CliPackageBuilder,
  packageEstimate,
  type PackageManifest,
} from '../apps/server/src/services/cli-package.js';
import { renderFrame } from '../apps/server/src/rendering/renderer.js';

async function setup(noisy = false) {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-cli-'));
  const ws = new Workspace(root);
  await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0 }),
    quota = new Quota(ws, limits);
  const engine = new Engine(
    process.env.FFMPEG_PATH ?? '/missing/ffmpeg',
    process.env.FFPROBE_PATH ?? '/missing/ffprobe',
  );
  const imports = new Imports(ws, limits, quota, engine);
  await imports.init();
  const sourceData = noisy
    ? [
        await sharp(randomBytes(128 * 128 * 3), { raw: { width: 128, height: 128, channels: 3 } })
          .png()
          .toBuffer(),
      ]
    : [
        await sharp({ create: { width: 48, height: 96, channels: 3, background: 'red' } })
          .jpeg()
          .toBuffer(),
        await sharp({ create: { width: 96, height: 48, channels: 4, background: 'green' } })
          .png()
          .toBuffer(),
        await sharp({ create: { width: 48, height: 48, channels: 3, background: 'blue' } })
          .webp()
          .toBuffer(),
      ];
  let project = await ws.createProject('CLI % & !');
  const session = await imports.create(project.id, {
    expectedRevision: project.revision,
    purpose: 'frames',
    mode: 'replace',
    files: sourceData.map((data, index) => ({
      clientFileId: randomUUID(),
      name: `source_${index}.mixed`,
      relativePath: `source_${index}.mixed`,
      size: data.length,
    })),
  });
  for (let index = 0; index < sourceData.length; index++)
    await imports.upload(
      session.id,
      session.files[index]!.fileId,
      Readable.from(sourceData[index]!),
    );
  project = await imports.finalize(session.id, project.revision);
  project = await ws.updateProject(project.id, project.revision, (p) => ({
    ...p,
    video: { ...p.video, resolution: '720p', encoding: { ...p.video.encoding, preset: 'fast' } },
  }));
  const builder = new CliPackageBuilder(ws, imports, quota, limits);
  return {
    root,
    ws,
    limits,
    quota,
    engine,
    imports,
    project,
    builder,
    close: async () => {
      await imports.shutdown();
      await ws.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('mixed sources become ordered composed PNGs with hashes and a portable batch script', async () => {
  const h = await setup();
  let prepared: Awaited<ReturnType<CliPackageBuilder['prepare']>> | null = null;
  try {
    prepared = await h.builder.prepare(h.project, randomUUID(), new AbortController().signal);
    const manifest = JSON.parse(
      await readFile(join(prepared.directory, 'manifest.json'), 'utf8'),
    ) as PackageManifest;
    assert.equal(manifest.frameCount, 3);
    assert.equal(manifest.frames.length, 3);
    assert.equal(manifest.fps, 24);
    assert.equal(manifest.width, 1280);
    assert.equal(manifest.height, 720);
    for (let index = 0; index < 3; index++) {
      const entry = manifest.frames[index]!;
      const data: Buffer = await readFile(join(prepared.directory, entry.name));
      assert.equal(entry.index, index);
      assert.equal(entry.name, `frames/frame_${String(index).padStart(8, '0')}.png`);
      assert.equal(createHash('sha256').update(data).digest('hex'), entry.renderedSha256);
      const source = await h.imports.asset(h.project.frames[index]!.assetId);
      const expected = await renderFrame(source.path, h.project.video, h.limits.maxImagePixels);
      assert.deepEqual(
        await sharp(data).ensureAlpha().raw().toBuffer(),
        expected.data,
        'prepared frame uses the same renderer',
      );
    }
    const script = await readFile(join(prepared.directory, 'encode.cmd'), 'utf8');
    assert.match(script, /DisableDelayedExpansion/);
    assert.match(script, /pushd "%~dp0"/);
    assert.match(script, /frame_%%08d\.png/);
    assert.match(script, /if exist "output\.mp4"/);
    assert(!script.includes('boxblur'));
    assert(!script.includes(h.root));
    assert((await h.quota.info()).reserved > 0, 'reservation carries space for ZIP');
    assert.equal(packageEstimate(h.project).rawSequenceBytes, 1280 * 720 * 4 * 3);
  } finally {
    if (prepared) await h.builder.cleanup(prepared);
    assert.equal((await h.quota.info()).reserved, 0);
    await h.close();
  }
});

test('cancel and quota failures remove owned staging and release their reservations', async () => {
  const h = await setup();
  try {
    const jobId = randomUUID(),
      controller = new AbortController();
    await assert.rejects(
      h.builder.prepare(h.project, jobId, controller.signal, async () => controller.abort()),
    );
    await assert.rejects(stat(h.ws.path('packages', jobId)));
    assert.equal((await h.quota.info()).reserved, 0);
    assert(await h.imports.asset(h.project.frames[0]!.assetId));
  } finally {
    await h.close();
  }
  const noisy = await setup(true);
  try {
    noisy.limits.workspaceQuotaBytes = 140000;
    const jobId = randomUUID();
    await assert.rejects(
      noisy.builder.prepare(noisy.project, jobId, new AbortController().signal),
      /quota/i,
    );
    assert.equal((await noisy.quota.info()).reserved, 0);
    await assert.rejects(stat(noisy.ws.path('packages', jobId)));
    assert(await noisy.imports.asset(noisy.project.frames[0]!.assetId));
  } finally {
    await noisy.close();
  }
});

test('a reused package directory is never merged or deleted by a new attempt', async () => {
  const h = await setup();
  try {
    const jobId = randomUUID();
    await mkdir(h.ws.path('packages', jobId));
    await writeFile(h.ws.path('packages', jobId, 'keep.txt'), 'existing');
    await assert.rejects(h.builder.prepare(h.project, jobId, new AbortController().signal));
    assert.equal(await readFile(h.ws.path('packages', jobId, 'keep.txt'), 'utf8'), 'existing');
    assert.equal((await h.quota.info()).reserved, 0);
  } finally {
    await h.close();
  }
});

test(
  'relocated prepared files encode independently after all original managed images are removed',
  { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH },
  async () => {
    const h = await setup(),
      target = await mkdtemp(join(tmpdir(), 'ftvs-relocated-cli-'));
    let prepared: Awaited<ReturnType<CliPackageBuilder['prepare']>> | null = null;
    try {
      prepared = await h.builder.prepare(h.project, randomUUID(), new AbortController().signal);
      await cp(prepared.directory, target, { recursive: true });
      for (const frame of h.project.frames) await rm((await h.imports.asset(frame.assetId)).path);
      await capture(h.engine.ffmpeg, preparedEncoderArgs(h.project), 60000, undefined, target);
      await h.engine.verify(join(target, 'output.mp4'), h.project);
    } finally {
      if (prepared) await h.builder.cleanup(prepared);
      await h.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  'copied audio and prepared frame sequence preserve pad/loop duration when encoded elsewhere',
  { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH },
  async () => {
    const h = await setup(),
      target = await mkdtemp(join(tmpdir(), 'ftvs-cli-audio-'));
    try {
      let project = await h.ws.updateProject(h.project.id, h.project.revision, (p) => ({
        ...p,
        frames: Array.from({ length: 12 }, (_, index) => ({
          ...p.frames[index % p.frames.length]!,
          id: randomUUID(),
        })),
      }));
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
      const session = await h.imports.create(project.id, {
        expectedRevision: project.revision,
        purpose: 'audio',
        mode: 'replace',
        files: [
          {
            clientFileId: randomUUID(),
            name: 'music %PATH%!&.wav',
            relativePath: 'music %PATH%!&.wav',
            size: wave.length,
          },
        ],
      });
      await h.imports.upload(session.id, session.files[0]!.fileId, Readable.from(wave));
      project = await h.imports.finalize(session.id, project.revision);
      for (const policy of ['pad-silence', 'loop'] as const) {
        project = await h.ws.updateProject(project.id, project.revision, (p) => ({
          ...p,
          audio: { ...p.audio!, shortTrackPolicy: policy, volume: 0.7 },
        }));
        const prepared = await h.builder.prepare(
          project,
          randomUUID(),
          new AbortController().signal,
        );
        try {
          const location = join(target, policy);
          await cp(prepared.directory, location, { recursive: true });
          assert.deepEqual(await readFile(join(location, 'audio.source')), wave);
          const manifest = JSON.parse(
            await readFile(join(location, 'manifest.json'), 'utf8'),
          ) as PackageManifest;
          assert.equal(manifest.audio!.shortTrackPolicy, policy);
          assert.equal(manifest.audio!.volume, 0.7);
          assert(!String(await readFile(join(location, 'encode.cmd'))).includes('music %PATH%'));
          await capture(
            h.engine.ffmpeg,
            preparedEncoderArgs(project, 'output.mp4', 'audio.source'),
            60000,
            undefined,
            location,
          );
          await h.engine.verify(join(location, 'output.mp4'), project);
        } finally {
          await h.builder.cleanup(prepared);
        }
      }
    } finally {
      await h.close();
      await rm(target, { recursive: true, force: true });
    }
  },
);
