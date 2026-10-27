import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter, basename } from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import sharp from 'sharp';
import { Workspace } from '../../apps/server/src/storage/workspace.ts';
import { Quota } from '../../apps/server/src/storage/quota.ts';
import { Imports } from '../../apps/server/src/services/imports.ts';
import { Exports } from '../../apps/server/src/jobs/exports.ts';
import { Engine, preparedEncoderArgs } from '../../apps/server/src/media/engine.ts';
import { capture } from '../../apps/server/src/media/process.ts';
import { limitsSchema } from '../../packages/contracts/src/index.ts';

async function extractVerified(path, target) {
  const zip = await new Promise((resolve, reject) => yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const names = []; let total = 0;
  await new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', (entry) => {
      void (async () => {
        assert(!entry.fileName.startsWith('/') && !entry.fileName.includes('\\') && !entry.fileName.split('/').includes('..'));
        assert(!names.includes(entry.fileName)); names.push(entry.fileName);
        total += entry.uncompressedSize; assert(total < 64 * 1024 * 1024, 'small fixture archive must be bounded');
        const destination = join(target, entry.fileName); await mkdir(dirname(destination), { recursive: true });
        const input = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
        await pipeline(input, createWriteStream(destination, { flags: 'wx' }));
        const data = await readFile(destination); assert.equal(data.length, entry.uncompressedSize);
        assert.equal(crc32(data) >>> 0, entry.crc32 >>> 0, 'CRC must match for every extracted file');
        zip.readEntry();
      })().catch((error) => { zip.close(); reject(error); });
    });
    zip.readEntry();
  });
  return names;
}

test('real CLI ZIP extracts with matching hashes and encodes independently; Windows also executes encode.cmd', { timeout: 120000 }, async () => {
  assert(process.env.FFMPEG_PATH && process.env.FFPROBE_PATH, 'Integration requires explicit real media binaries, not skipped cases');
  const root = await mkdtemp(join(tmpdir(), 'ftvs-real-zip-'));
  const target = await mkdtemp(join(tmpdir(), 'ftvs relocated % ! &-'));
  const ws = new Workspace(root); await ws.init();
  const limits = limitsSchema.parse({ minFreeDiskBytes: 0 });
  const engine = new Engine(process.env.FFMPEG_PATH, process.env.FFPROBE_PATH), quota = new Quota(ws, limits);
  const imports = new Imports(ws, limits, quota, engine); await imports.init();
  const jobs = new Exports(ws, imports, engine, quota, limits); await jobs.init();
  try {
    let project = await ws.createProject('independent ZIP');
    const inputs = [await sharp({ create: { width: 48, height: 96, channels: 3, background: 'red' } }).jpeg().toBuffer(),
      await sharp({ create: { width: 96, height: 48, channels: 4, background: 'blue' } }).png().toBuffer()];
    const session = await imports.create(project.id, { expectedRevision: 1, purpose: 'frames', mode: 'replace', files: inputs.map((data, index) => ({ clientFileId: randomUUID(), name: `source_${index}.mixed`, relativePath: `source_${index}.mixed`, size: data.length })) });
    for (let index = 0; index < inputs.length; index++) await imports.upload(session.id, session.files[index].fileId, Readable.from(inputs[index]));
    project = await imports.finalize(session.id, 1);
    project = await ws.updateProject(project.id, project.revision, (p) => ({ ...p, video: { ...p.video, resolution: '720p' } }));
    const job = await jobs.submit(project.id, project.revision, 'frames.zip', randomUUID(), 'cli');
    for (let n = 0; n < 2000 && jobs.activeJob; n++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(jobs.get(job.id).status, 'completed', JSON.stringify(jobs.get(job.id).error));
    const zipPath = await jobs.resultPath(job.id), release = jobs.acquireReader(job.id);
    await assert.rejects(jobs.deleteResult(job.id), /đang được đọc/); release();
    const names = await extractVerified(zipPath, target);
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
    assert.equal(manifest.frameCount, inputs.length); assert.equal(names.length, inputs.length + 3);
    for (const frame of manifest.frames) assert.equal(createHash('sha256').update(await readFile(join(target, frame.name))).digest('hex'), frame.renderedSha256);
    for (const frame of project.frames) await rm((await imports.asset(frame.assetId)).path);
    if (process.platform === 'win32') {
      assert.equal(basename(process.env.FFMPEG_PATH).toLowerCase(), 'ffmpeg.exe', 'Windows integration uses the release ffmpeg.exe and its adjacent runtime dependencies');
      const bin = dirname(process.env.FFMPEG_PATH);
      const previous = process.env.PATH;
      try { process.env.PATH = `${bin}${delimiter}${previous ?? ''}`;
        await capture('cmd.exe', ['/d', '/c', 'encode.cmd'], 60000, undefined, target);
        await engine.verify(join(target, 'output.mp4'), project);
        // Existing output is refused rather than silently overwritten.
        const before = await readFile(join(target, 'output.mp4'));
        await assert.rejects(capture('cmd.exe', ['/d', '/c', 'encode.cmd'], 60000, undefined, target));
        assert.deepEqual(await readFile(join(target, 'output.mp4')), before);
      } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
    } else {
      await capture(engine.ffmpeg, preparedEncoderArgs(project), 60000, undefined, target);
      await engine.verify(join(target, 'output.mp4'), project);
    }
    assert((await stat(join(target, 'output.mp4'))).size > 0);
    await assert.rejects(stat(ws.path('packages', job.id)), 'staging must be cleaned after a completed ZIP');
  } finally { await jobs.shutdown(); await imports.shutdown(); await ws.close(); await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});
