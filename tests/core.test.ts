import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  configSchema,
  dimensions,
  importSchema,
  naturalCompare,
  videoSchema,
} from '../packages/contracts/src/index.js';
import { Workspace } from '../apps/server/src/storage/workspace.js';
import { framePNG, renderFrame, validateImage } from '../apps/server/src/rendering/renderer.js';
import { Engine, encoderArgs } from '../apps/server/src/media/engine.js';
import { startProcess } from '../apps/server/src/media/process.js';
import { once } from 'node:events';

test('natural ordering is deterministic, handles long numbers and leading zeros', () => {
  assert.deepEqual(['frame_10', 'frame_2', 'frame_1'].sort(naturalCompare), [
    'frame_1',
    'frame_2',
    'frame_10',
  ]);
  assert(naturalCompare('a99999999999999999999', 'a100000000000000000000') < 0);
  assert.notEqual(naturalCompare('frame_02', 'frame_2'), 0);
});
test('strict input validates all supported output shapes and rejects traversal/audio append', () => {
  const defaults = videoSchema.parse({});
  assert.deepEqual(dimensions(defaults), { width: 1920, height: 1080 });
  assert.deepEqual(dimensions({ ...defaults, resolution: '4k', aspectRatio: '9:16' }), {
    width: 2160,
    height: 3840,
  });
  assert.equal(videoSchema.safeParse({ fps: 25 }).success, false);
  const input = {
    expectedRevision: 1,
    purpose: 'frames',
    mode: 'replace',
    files: [{ clientFileId: randomUUID(), name: 'x.png', relativePath: '../x.png', size: 10 }],
  };
  assert.equal(importSchema.safeParse(input).success, false);
  assert.equal(
    importSchema.safeParse({
      ...input,
      purpose: 'audio',
      mode: 'append',
      files: [{ ...input.files[0], relativePath: 'x.mp3' }],
    }).success,
    false,
  );
  assert.equal(configSchema.safeParse({ port: 80 }).success, false);
});
test('workspace serializes concurrent revisions and recovers last-good project without erasing backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ftv-store-'));
  const ws = new Workspace(root);
  try {
    await ws.init();
    await assert.rejects(new Workspace(root).init(), /Workspace/);
    const project = await ws.createProject('Bộ ảnh');
    const result = await Promise.allSettled([
      ws.updateProject(project.id, 1, (p) => ({ ...p, name: 'one' })),
      ws.updateProject(project.id, 1, (p) => ({ ...p, name: 'two' })),
    ]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await ws.project(project.id)).revision, 2);
    const path = ws.objectPath('projects', project.id, 'project.json');
    const backup = await readFile(`${path}.bak`, 'utf8');
    await writeFile(path, '{broken');
    assert.equal((await ws.project(project.id)).revision, 1);
    assert.equal(await readFile(`${path}.bak`, 'utf8'), backup);
    assert.throws(() => ws.path('../escape'), /ngoài workspace/);
  } finally {
    await ws.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('renderer preserves foreground geometry, flattens alpha and matches PNG/raw frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ftv-render-'));
  try {
    const source = join(root, 'portrait.png');
    await sharp({ create: { width: 100, height: 200, channels: 4, background: '#ff0000' } })
      .png()
      .toFile(source);
    assert.equal((await validateImage(source, 100000)).height, 200);
    const settings = videoSchema.parse({
      resolution: '720p',
      background: { mode: 'solid', matteColor: '#0000ff' },
    });
    const frame = await renderFrame(source, settings, 100000);
    assert.equal(frame.data.length, 1280 * 720 * 4);
    const pixel = (x: number, y: number) => [
      ...frame.data.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4),
    ];
    assert.deepEqual(pixel(0, 360), [0, 0, 255, 255]);
    assert.deepEqual(pixel(640, 360), [255, 0, 0, 255]);
    assert.deepEqual(
      await sharp(await framePNG(frame))
        .raw()
        .toBuffer(),
      frame.data,
    );
    await writeFile(join(root, 'broken.png'), 'not png');
    await assert.rejects(validateImage(join(root, 'broken.png'), 100000), /giải mã/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('engine missing reports engine error rather than guessed memory exhaustion', async () => {
  const engine = new Engine('/missing/ffmpeg', '/missing/ffprobe');
  const status = await engine.status();
  assert.equal(status.ready, false);
  assert.equal(status.error?.code, 'ENGINE_UNAVAILABLE');
});

test('EXIF rotation precedes contain geometry and transparent input uses matte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ftv-orientation-'));
  try {
    const portrait = join(root, 'orientation.jpg');
    await sharp({ create: { width: 100, height: 200, channels: 3, background: 'red' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(portrait);
    const settings = videoSchema.parse({
      resolution: '720p',
      background: { mode: 'solid', matteColor: '#0000ff' },
    });
    assert.equal((await validateImage(portrait, 100000)).orientation, 6);
    const rotated = await renderFrame(portrait, settings, 100000);
    const at = (data: Buffer, x: number, y: number) => [
      ...data.subarray((y * 1280 + x) * 4, (y * 1280 + x) * 4 + 4),
    ];
    assert.deepEqual(at(rotated.data, 640, 0), [0, 0, 255, 255]);
    assert(
      at(rotated.data, 10, 360)[0]! > 240,
      'after rotation foreground is landscape, covers the horizontal midpoint',
    );
    const transparent = join(root, 'alpha.png');
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toFile(transparent);
    const matte = await renderFrame(transparent, settings, 100000);
    assert.deepEqual(at(matte.data, 640, 360), [0, 0, 255, 255]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  'real RGBA pipe encodes N frames; pad/loop keep complete video and audio',
  { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ftv-media-'));
    const ws = new Workspace(root);
    try {
      await ws.init();
      const project = await ws.createProject('integration');
      project.video = videoSchema.parse({
        resolution: '720p',
        fps: 24,
        encoding: { preset: 'fast' },
      });
      project.frames = Array.from({ length: 24 }, (_, i) => ({
        id: randomUUID(),
        assetId: randomUUID(),
        originalName: `${i}.png`,
        relativePath: `${i}.png`,
        sha256: '0'.repeat(64),
        fileSize: 1,
        width: 1280,
        height: 720,
        format: 'png',
        orientation: 1,
        status: 'valid',
      }));
      const engine = new Engine(process.env.FFMPEG_PATH!, process.env.FFPROBE_PATH!);
      assert.equal((await engine.status()).ready, true);
      const audio = join(root, 'short.wav');
      const wave = Buffer.alloc(44 + 4800 * 2);
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
      await writeFile(audio, wave);
      for (const policy of [null, 'pad-silence', 'loop'] as const) {
        project.audio = policy
          ? { assetId: randomUUID(), durationUs: 100000, volume: 1, shortTrackPolicy: policy }
          : null;
        const out = join(root, `${policy ?? 'silent'}.mp4`);
        const proc = startProcess(engine.ffmpeg, encoderArgs(project, out, audio));
        const frame = Buffer.alloc(1280 * 720 * 4, 80);
        for (let i = 0; i < 24; i++)
          if (!proc.child.stdin.write(frame)) await once(proc.child.stdin, 'drain');
        proc.child.stdin.end();
        await proc.done;
        await engine.verify(out, project);
      }
    } finally {
      await ws.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
