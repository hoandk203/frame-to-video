import { capture } from '../apps/server/src/media/process.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { limitsSchema } from '../packages/contracts/src/index.js';
import { Workspace } from '../apps/server/src/storage/workspace.js';
import { Quota } from '../apps/server/src/storage/quota.js';
import { Imports } from '../apps/server/src/services/imports.js';
import { Engine } from '../apps/server/src/media/engine.js';
import { Previews } from '../apps/server/src/services/previews.js';
import { MediaScheduler } from '../apps/server/src/rendering/scheduler.js';

test('preview shares the native scheduler, coalesces pending work and bounds outstanding requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-preview-'));
  const ws = new Workspace(root);
  const scheduler = new MediaScheduler();
  await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0 });
  const engine = new Engine('/missing/ffmpeg', '/missing/ffprobe');
  const imports = new Imports(ws, limits, new Quota(ws, limits), engine);
  await imports.init();
  const previews = new Previews(ws, imports, engine, limits, scheduler);
  try {
    let project = await ws.createProject('Preview queue');
    const data = await sharp({ create: { width: 48, height: 96, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const session = await imports.create(project.id, {
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
    await imports.upload(session.id, session.files[0]!.fileId, Readable.from(data));
    project = await imports.finalize(session.id, project.revision);
    const thumb = await previews.thumbnail(project.frames[0]!.assetId);
    const thumbMetadata = await sharp(thumb.data ?? thumb.path!).metadata();
    assert.equal(thumbMetadata.width, 96);
    assert.equal(thumbMetadata.height, 96);
    thumb.release();
    const first = await previews.request(project.id, project.revision, 0, 'interactive');
    await previews.idle();
    assert.equal(previews.get(first.id).status, 'ready');
    const image = await previews.acquire(first.id, 'image');
    const metadata = await sharp(image.data ?? image.path!).metadata();
    image.release();
    assert.equal(metadata.width, 960);
    assert.equal(metadata.height, 540);
    const resume = scheduler.beginExport();
    const cachedThumb = await previews.thumbnail(project.frames[0]!.assetId);
    assert.equal(scheduler.stats.queued, 0, 'cached thumbnails bypass paused native queue');
    cachedThumb.release();
    const warm = await previews.request(project.id, project.revision, 0, 'interactive');
    assert.equal(
      warm.status,
      'ready',
      'cached images remain available while export pauses native preview work',
    );
    const reader = await previews.acquire(warm.id, 'image');
    await assert.rejects(
      previews.clearCache(),
      (error: unknown) => (error as { code: string }).code === 'PREVIEW_CACHE_BUSY',
    );
    reader.release();
    await previews.clearCache();
    await assert.rejects(
      previews.acquire(warm.id, 'image'),
      (error: unknown) => (error as { code: string }).code === 'PREVIEW_EXPIRED',
    );
    const pending = await previews.request(project.id, project.revision, 0, 'output-check');
    const duplicate = await previews.request(project.id, project.revision, 0, 'output-check');
    assert.equal(duplicate.id, pending.id);
    assert.equal(previews.get(pending.id).status, 'pending');
    await assert.rejects(
      previews.clearCache(),
      (error: unknown) => (error as { code: string }).code === 'PREVIEW_CACHE_BUSY',
    );
    for (let index = 1; index < 64; index++) {
      project = await ws.updateProject(project.id, project.revision, (p) => ({
        ...p,
        name: `Revision ${index}`,
      }));
      await previews.request(project.id, project.revision, 0, 'output-check');
    }
    await assert.rejects(
      previews.request(project.id, project.revision, 0, 'interactive'),
      (error: unknown) => (error as { code: string }).code === 'MEDIA_QUEUE_FULL',
    );
    assert.equal(scheduler.stats.queued, 64);
    await scheduler.shutdown();
    await previews.idle();
    resume();
    assert.equal(previews.get(pending.id).status, 'failed');
    assert.equal(previews.get(pending.id).error?.code, 'APP_STOPPING');
    assert.equal(scheduler.stats.queued, 0);
    await previews.shutdown();
    await assert.rejects(
      previews.request(project.id, project.revision, 0, 'interactive'),
      (error: unknown) => (error as { code: string }).code === 'APP_STOPPING',
    );
  } finally {
    await scheduler.shutdown();
    await previews.idle();
    await imports.shutdown();
    await ws.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'real audio previews preserve duration, pad/loop and apply volume once before bounded cache publication',
  {
    skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ftvs-audio-preview-'));
    const ws = new Workspace(root);
    await ws.init();
    const limits = limitsSchema.parse({ minFreeDiskBytes: 0 });
    const engine = new Engine(process.env.FFMPEG_PATH!, process.env.FFPROBE_PATH!);
    const quota = new Quota(ws, limits),
      imports = new Imports(ws, limits, quota, engine);
    await imports.init();
    const scheduler = new MediaScheduler(),
      previews = new Previews(ws, imports, engine, limits, scheduler, quota);
    try {
      let project = await ws.createProject('Audio preview');
      const image = await sharp({
        create: { width: 24, height: 48, channels: 3, background: 'blue' },
      })
        .png()
        .toBuffer();
      const frameSession = await imports.create(project.id, {
        expectedRevision: project.revision,
        purpose: 'frames',
        mode: 'replace',
        files: [
          {
            clientFileId: randomUUID(),
            name: 'image.png',
            relativePath: 'image.png',
            size: image.length,
          },
        ],
      });
      await imports.upload(frameSession.id, frameSession.files[0]!.fileId, Readable.from(image));
      project = await imports.finalize(frameSession.id, project.revision);
      project = await ws.updateProject(project.id, project.revision, (p) => ({
        ...p,
        video: { ...p.video, fps: 12 },
        frames: Array.from({ length: 12 }, () => ({ ...p.frames[0]!, id: randomUUID() })),
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
      for (let i = 0; i < 4800; i++)
        wave.writeInt16LE(
          Math.round(10000 * Math.sin((i * Math.PI * 2 * 440) / 48000)),
          44 + i * 2,
        );
      const session = await imports.create(project.id, {
        expectedRevision: project.revision,
        purpose: 'audio',
        mode: 'replace',
        files: [
          {
            clientFileId: randomUUID(),
            name: 'tone.wav',
            relativePath: 'tone.wav',
            size: wave.length,
          },
        ],
      });
      await imports.upload(session.id, session.files[0]!.fileId, Readable.from(wave));
      project = await imports.finalize(session.id, project.revision);
      for (const policy of ['pad-silence', 'loop'] as const) {
        project = await ws.updateProject(project.id, project.revision, (p) => ({
          ...p,
          audio: { ...p.audio!, volume: 0.5, shortTrackPolicy: policy },
        }));
        const request = await previews.audio(project.id, project.revision);
        await previews.idle();
        assert.equal(
          previews.get(request.id).status,
          'ready',
          JSON.stringify(previews.get(request.id).error),
        );
        const lease = await previews.acquire(request.id, 'audio');
        try {
          const probe = await engine.probe(lease.path!);
          assert(Math.abs(Number(probe.format.duration) - 1) < 0.032);
          const decoded = join(root, `${policy}.pcm`);
          await capture(engine.ffmpeg, [
            '-v',
            'error',
            '-i',
            lease.path!,
            '-f',
            's16le',
            '-ac',
            '1',
            '-ar',
            '48000',
            decoded,
          ]);
          const pcm = await readFile(decoded);
          const rms = (start: number, count: number) =>
            Math.sqrt(
              Array.from(
                { length: count },
                (_, offset) => pcm.readInt16LE((start + offset) * 2) ** 2,
              ).reduce((a, b) => a + b, 0) / count,
            );
          const beginning = rms(1024, 2048),
            ending = rms(36000, 10000);
          assert(beginning > 2000 && beginning < 5000, `volume applies once: RMS ${beginning}`);
          assert(
            policy === 'loop' ? ending > 2000 && ending < 5000 : ending < 10,
            `${policy} ending RMS ${ending}`,
          );
        } finally {
          lease.release();
        }
      }
      await previews.clearCache();
      const clientId = randomUUID(),
        resume = scheduler.beginExport();
      const outdated = await previews.audio(project.id, project.revision, {
        clientId,
        sequence: 1,
      });
      const currentAudio = await previews.audio(project.id, project.revision, {
        clientId,
        sequence: 2,
      });
      assert.equal(previews.get(outdated.id).error?.code, 'PREVIEW_SUPERSEDED');
      // Image seeking has its own channel and must not cancel a valid proxy generation.
      await previews.request(project.id, project.revision, 0, 'interactive', {
        clientId,
        sequence: 5,
        intent: 'seek',
      });
      previews.cancel(project.id, clientId, 5);
      assert.equal(previews.get(currentAudio.id).status, 'pending');
      previews.cancelAudio(project.id, clientId, 1);
      resume();
      await previews.idle();
      assert.equal(
        previews.get(currentAudio.id).status,
        'ready',
        JSON.stringify(previews.get(currentAudio.id).error),
      );
      await assert.rejects(
        previews.audio(project.id, project.revision, { clientId, sequence: 1 }),
        /thay đổi/,
      );
      assert(
        previews.cacheStats.diskBytes <= limits.previewDiskBytes &&
          previews.cacheStats.memoryBytes <= limits.previewMemoryBytes,
      );
      assert.equal((await quota.info()).reserved, 0);
    } finally {
      await scheduler.shutdown();
      await previews.shutdown();
      await imports.shutdown();
      await ws.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('service rejects a metadata-delayed old seek, keeps other tabs independent and cancels queued groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-selection-service-'));
  const ws = new Workspace(root);
  await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0 });
  const engine = new Engine('/missing/ffmpeg', '/missing/ffprobe');
  const quota = new Quota(ws, limits),
    imports = new Imports(ws, limits, quota, engine);
  await imports.init();
  const scheduler = new MediaScheduler(),
    previews = new Previews(ws, imports, engine, limits, scheduler, quota);
  let releaseMetadata = () => {};
  try {
    let project = await ws.createProject('Selection ordering');
    const data = await sharp({
      create: { width: 24, height: 48, channels: 3, background: 'green' },
    })
      .png()
      .toBuffer();
    const session = await imports.create(project.id, {
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
    await imports.upload(session.id, session.files[0]!.fileId, Readable.from(data));
    project = await imports.finalize(session.id, project.revision);
    const readProject = ws.project.bind(ws);
    let entered!: () => void;
    const metadataEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    let first = true;
    ws.project = async (id) => {
      const result = await readProject(id);
      if (first) {
        first = false;
        entered();
        await metadataGate;
      }
      return result;
    };
    const clientA = randomUUID(),
      clientB = randomUUID();
    const resume = scheduler.beginExport();
    const delayed = previews.request(project.id, project.revision, 0, 'interactive', {
      clientId: clientA,
      sequence: 1,
      intent: 'seek',
    });
    const rejectedOld = assert.rejects(
      delayed,
      (error: unknown) => (error as { code: string }).code === 'PREVIEW_SUPERSEDED',
    );
    await metadataEntered;
    const newer = await previews.request(project.id, project.revision, 0, 'interactive', {
      clientId: clientA,
      sequence: 2,
      intent: 'seek',
    });
    const independent = await previews.request(project.id, project.revision, 0, 'interactive', {
      clientId: clientB,
      sequence: 1,
      intent: 'seek',
    });
    assert.notEqual(
      newer.id,
      independent.id,
      'cross-tab work must not share a cancellable request ID',
    );
    releaseMetadata();
    await rejectedOld;
    const last = await previews.request(project.id, project.revision, 0, 'output-check', {
      clientId: clientA,
      sequence: 3,
      intent: 'seek',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(previews.get(newer.id).error?.code, 'PREVIEW_SUPERSEDED');
    assert.equal(previews.get(independent.id).status, 'pending');
    previews.cancel(project.id, clientA, 2);
    assert.equal(previews.get(last.id).status, 'pending');
    previews.cancel(project.id, clientA, 3);
    await assert.rejects(
      previews.request(project.id, project.revision, 0, 'interactive', {
        clientId: clientA,
        sequence: 2,
        intent: 'seek',
      }),
      /thay đổi/,
    );
    resume();
    await previews.idle();
    assert.equal(previews.get(last.id).error?.code, 'PREVIEW_SUPERSEDED');
    assert.equal(previews.get(independent.id).status, 'ready');
    const resumed = await previews.request(project.id, project.revision, 0, 'interactive', {
      clientId: clientA,
      sequence: 4,
      intent: 'seek',
    });
    assert.equal(resumed.status, 'ready');
    ws.project = readProject;
  } finally {
    releaseMetadata();
    await scheduler.shutdown();
    await previews.shutdown();
    await imports.shutdown();
    await ws.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('new seek reclaims a full speculative group before admission instead of failing at the old queue limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-full-preview-'));
  const ws = new Workspace(root);
  await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0 });
  const engine = new Engine('/missing/ffmpeg', '/missing/ffprobe');
  const quota = new Quota(ws, limits),
    imports = new Imports(ws, limits, quota, engine);
  await imports.init();
  const scheduler = new MediaScheduler(),
    previews = new Previews(ws, imports, engine, limits, scheduler, quota);
  try {
    let project = await ws.createProject('Full speculative queue');
    const images = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        sharp({
          create: {
            width: 12,
            height: 12,
            channels: 3,
            background: { r: index * 4, g: 0, b: 128 },
          },
        })
          .png()
          .toBuffer(),
      ),
    );
    const session = await imports.create(project.id, {
      expectedRevision: project.revision,
      purpose: 'frames',
      mode: 'replace',
      files: images.map((data, index) => ({
        clientFileId: randomUUID(),
        name: `${index}.png`,
        relativePath: `${index}.png`,
        size: data.length,
      })),
    });
    for (let index = 0; index < images.length; index++)
      await imports.upload(session.id, session.files[index]!.fileId, Readable.from(images[index]!));
    project = await imports.finalize(session.id, project.revision);
    const resume = scheduler.beginExport(),
      clientId = randomUUID();
    const old: string[] = [];
    for (let index = 0; index < 64; index++)
      old.push(
        (
          await previews.request(project.id, project.revision, index, 'interactive', {
            clientId,
            sequence: 1,
            intent: 'prefetch',
          })
        ).id,
      );
    assert.equal(scheduler.stats.queued, 64);
    const next = await previews.request(project.id, project.revision, 0, 'interactive', {
      clientId,
      sequence: 2,
      intent: 'seek',
    });
    assert.equal(scheduler.stats.queued, 1);
    for (const id of old) assert.equal(previews.get(id).error?.code, 'PREVIEW_SUPERSEDED');
    resume();
    await previews.idle();
    assert.equal(previews.get(next.id).status, 'ready');
    const burst = await Promise.allSettled(
      Array.from({ length: 100 }, () =>
        previews.request(project.id, project.revision, 0, 'interactive', {
          clientId,
          sequence: 3,
          intent: 'seek',
        }),
      ),
    );
    assert.equal(burst.filter((result) => result.status === 'fulfilled').length, 64);
    for (const result of burst)
      if (result.status === 'rejected')
        assert.equal((result.reason as { code: string }).code, 'MEDIA_QUEUE_FULL');
    await previews.idle();
    assert.equal((await quota.info()).reserved, 0);
  } finally {
    await scheduler.shutdown();
    await previews.shutdown();
    await imports.shutdown();
    await ws.close();
    await rm(root, { recursive: true, force: true });
  }
});
