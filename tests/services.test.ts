import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import sharp from 'sharp';
import { Workspace } from '../apps/server/src/storage/workspace.js';
import { Quota } from '../apps/server/src/storage/quota.js';
import { Imports } from '../apps/server/src/services/imports.js';
import { Engine } from '../apps/server/src/media/engine.js';
import { Exports } from '../apps/server/src/jobs/exports.js';
import { Sessions } from '../apps/server/src/security/session.js';
import { limitsSchema } from '../packages/contracts/src/index.js';

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-service-'));
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
  return {
    ws,
    imports,
    limits,
    engine,
    quota,
    close: async () => {
      await ws.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('session is same-origin, CSRF protected, stable across tabs and invalid after restart', () => {
  const service = new Sessions(3000);
  const headers: Record<string, string> = {
    host: '127.0.0.1:3000',
    'x-app-client': 'frame-to-video-studio',
  };
  const first = service.bootstrap(headers);
  headers.cookie = first.cookie!.split(';')[0]!;
  assert.equal(service.bootstrap(headers).token, first.token);
  assert.equal(service.bootstrap(headers).cookie, null);
  assert.throws(() => service.check(headers, true), /Origin/);
  headers.origin = 'http://127.0.0.1:3000';
  headers['x-csrf-token'] = first.token;
  assert.doesNotThrow(() => service.check(headers, true));
  assert.throws(() => service.check({ ...headers, origin: 'https://evil.test' }, true), /Origin/);
  assert.throws(() => service.check({ ...headers, 'x-csrf-token': 'bad' }, true), /CSRF/);
  assert.throws(() => new Sessions(3000).check(headers, false), /hết hạn/);
  assert.throws(() => service.bootstrap({ ...headers, host: 'evil.test:3000' }), /Host/);
});
test('mixed image import commits in natural order and conflicting retry preserves accepted source', async () => {
  const h = await harness();
  try {
    const project = await h.ws.createProject('mixed');
    const files = [
      {
        name: 'frame_10.jpg',
        data: await sharp({ create: { width: 32, height: 64, channels: 3, background: 'blue' } })
          .jpeg()
          .toBuffer(),
      },
      {
        name: 'frame_2.png',
        data: await sharp({ create: { width: 48, height: 24, channels: 4, background: 'red' } })
          .png()
          .toBuffer(),
      },
    ];
    const session = await h.imports.create(project.id, {
      expectedRevision: 1,
      purpose: 'frames',
      mode: 'replace',
      files: files.map((f) => ({
        clientFileId: randomUUID(),
        name: f.name,
        relativePath: f.name,
        size: f.data.length,
      })),
    });
    for (let i = 0; i < files.length; i++)
      await h.imports.upload(session.id, session.files[i]!.fileId, Readable.from(files[i]!.data));
    assert.equal(
      (await h.ws.project(project.id)).frames.length,
      0,
      'selection remains unchanged until finalize',
    );
    await assert.rejects(
      h.imports.upload(
        session.id,
        session.files[0]!.fileId,
        Readable.from(Buffer.alloc(files[0]!.data.length)),
      ),
      /nội dung khác/,
    );
    const finalized = await h.imports.finalize(session.id, 1);
    assert.deepEqual(
      finalized.frames.map((f) => f.originalName),
      ['frame_2.png', 'frame_10.jpg'],
    );
    assert.equal(finalized.revision, 2);
    const asset = await h.imports.asset(finalized.frames[0]!.assetId);
    assert.deepEqual(await readFile(asset.path), files[1]!.data);
    const h2 = new Imports(h.ws, h.limits, h.quota, h.engine);
    await h2.init();
    assert.equal((await h2.asset(asset.id)).sha256, asset.sha256);
  } finally {
    await h.close();
  }
});
test('invalid/short uploads cannot publish project; cancel preserves previous project', async () => {
  const h = await harness();
  try {
    const project = await h.ws.createProject('rollback');
    const session = await h.imports.create(project.id, {
      expectedRevision: 1,
      purpose: 'frames',
      mode: 'replace',
      files: [{ clientFileId: randomUUID(), name: 'bad.png', relativePath: 'bad.png', size: 100 }],
    });
    await assert.rejects(
      h.imports.upload(session.id, session.files[0]!.fileId, Readable.from(Buffer.from('bad'))),
      /chưa đủ byte/,
    );
    await assert.rejects(h.imports.finalize(session.id, 1), /Còn file lỗi/);
    await h.imports.cancel(session.id);
    assert.equal((await h.ws.project(project.id)).revision, 1);
    assert.equal((await h.ws.project(project.id)).frames.length, 0);
  } finally {
    await h.close();
  }
});
test('reservation rejects over-quota manifests without creating an import session', async () => {
  const h = await harness();
  try {
    const p = await h.ws.createProject('quota');
    const imports = new Imports(
      h.ws,
      h.limits,
      new Quota(h.ws, { ...h.limits, workspaceQuotaBytes: 10 }),
      h.engine,
    );
    await imports.init();
    await assert.rejects(
      imports.create(p.id, {
        expectedRevision: 1,
        purpose: 'frames',
        mode: 'replace',
        files: [{ clientFileId: randomUUID(), name: 'x.png', relativePath: 'x.png', size: 20 }],
      }),
      /quota/,
    );
  } finally {
    await h.close();
  }
});
test(
  'job snapshot locks project, idempotent retry returns one real verified output across restart',
  { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH },
  async () => {
    const h = await harness();
    let jobs: Exports | undefined;
    try {
      const project = await h.ws.createProject('job');
      const png = await sharp({
        create: { width: 64, height: 100, channels: 3, background: 'orange' },
      })
        .png()
        .toBuffer();
      const session = await h.imports.create(project.id, {
        expectedRevision: 1,
        purpose: 'frames',
        mode: 'replace',
        files: [
          {
            clientFileId: randomUUID(),
            name: 'one.png',
            relativePath: 'one.png',
            size: png.length,
          },
        ],
      });
      await h.imports.upload(session.id, session.files[0]!.fileId, Readable.from(png));
      let p = await h.imports.finalize(session.id, 1);
      p = await h.ws.updateProject(p.id, p.revision, (p) => ({
        ...p,
        video: { ...p.video, resolution: '720p' },
      }));
      jobs = new Exports(h.ws, h.imports, h.engine, h.quota, h.limits);
      await jobs.init();
      const key = randomUUID();
      const job = await jobs.submit(p.id, p.revision, 'kết quả.mp4', key);
      assert.equal((await jobs.submit(p.id, p.revision, 'kết quả.mp4', key)).id, job.id);
      await assert.rejects(jobs.submit(p.id, p.revision, 'different.mp4', key), /Key/);
      await assert.rejects(
        h.imports.create(p.id, {
          expectedRevision: p.revision,
          purpose: 'frames',
          mode: 'replace',
          files: [{ clientFileId: randomUUID(), name: 'x', relativePath: 'x', size: 1 }],
        }),
        /đang xuất/,
      );
      for (let i = 0; i < 300 && !['completed', 'failed'].includes(jobs.get(job.id).status); i++)
        await new Promise((r) => setTimeout(r, 25));
      const done = jobs.get(job.id);
      assert.equal(done.status, 'completed', JSON.stringify(done.error));
      assert.equal(done.percent, 100);
      const file = await jobs.resultPath(job.id);
      assert((await readFile(file)).length > 100);
      const release = jobs.acquireReader(job.id);
      await assert.rejects(jobs.deleteResult(job.id), /đang được đọc/);
      release();
      const restarted = new Exports(h.ws, h.imports, h.engine, h.quota, h.limits);
      await restarted.init();
      assert.equal((await restarted.submit(p.id, p.revision, 'kết quả.mp4', key)).id, job.id);
      assert.equal(restarted.get(job.id).status, 'completed');
    } finally {
      await jobs?.shutdown();
      await h.close();
    }
  },
);

test('cancel waits for an active upload to close and release quota before returning', async () => {
  const h = await harness();
  try {
    const p = await h.ws.createProject('cancel stream');
    const session = await h.imports.create(p.id, {
      expectedRevision: 1,
      purpose: 'frames',
      mode: 'replace',
      files: [
        { clientFileId: randomUUID(), name: 'pending.png', relativePath: 'pending.png', size: 100 },
      ],
    });
    const stream = new PassThrough();
    const result = h.imports.upload(session.id, session.files[0]!.fileId, stream).then(
      () => ({ failed: false }),
      () => ({ failed: true }),
    );
    stream.write(Buffer.from('partial'));
    for (let n = 0; n < 100 && h.imports.get(session.id).files[0]!.status !== 'uploading'; n++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await h.imports.cancel(session.id);
    assert.equal((await result).failed, true);
    assert.equal(h.imports.get(session.id).status, 'canceled');
    assert.equal((await h.quota.info()).reserved, 0);
    await assert.rejects(
      stat(h.ws.objectPath('uploads', session.id, `${session.files[0]!.fileId}.part`)),
    );
  } finally {
    await h.close();
  }
});

test('failed file open releases the upload slot so a corrected retry can finish', async () => {
  const h = await harness();
  try {
    h.limits.uploadConcurrency = 1;
    const p = await h.ws.createProject('open fail');
    const data = await sharp({
      create: { width: 16, height: 16, channels: 3, background: 'green' },
    })
      .png()
      .toBuffer();
    const session = await h.imports.create(p.id, {
      expectedRevision: 1,
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
    const file = session.files[0]!,
      path = h.ws.objectPath('uploads', session.id, `${file.fileId}.part`);
    await mkdir(path);
    await assert.rejects(h.imports.upload(session.id, file.fileId, Readable.from(data)));
    await rm(path, { recursive: true });
    assert.equal(
      (await h.imports.upload(session.id, file.fileId, Readable.from(data))).status,
      'valid',
    );
    await h.imports.finalize(session.id, p.revision);
  } finally {
    await h.close();
  }
});

test('TTL expires abandoned imports, frees their reservation and collects unpublished sources', async () => {
  const h = await harness();
  try {
    const p = await h.ws.createProject('expiry');
    const data = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const session = await h.imports.create(p.id, {
      expectedRevision: 1,
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
    const file = await h.imports.upload(session.id, session.files[0]!.fileId, Readable.from(data));
    assert(await h.imports.asset(file.assetId!));
    const expired = await h.imports.expire(Date.parse(session.expiresAt) + 1);
    assert.equal(expired.expired, 1);
    assert.equal(h.imports.get(session.id).status, 'canceled');
    assert.equal((await h.quota.info()).reserved, 0);
    await assert.rejects(h.imports.asset(file.assetId!), /Không tìm thấy nguồn/);
    assert.equal((await h.ws.project(p.id)).frames.length, 0);
  } finally {
    await h.close();
  }
});

test('import creation is persisted and idempotent across retries and service restart', async () => {
  const h = await harness();
  try {
    const p = await h.ws.createProject('idempotent import');
    const data = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const input = {
      expectedRevision: 1,
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
    };
    const key = randomUUID();
    const [first, retried] = await Promise.all([
      h.imports.create(p.id, input, key),
      h.imports.create(p.id, input, key),
    ]);
    assert.equal(first.id, retried.id);
    assert.equal((await h.quota.info()).reserved, data.length);
    await assert.rejects(h.imports.create(p.id, { ...input, mode: 'append' }, key), /Key nhập/);
    await h.imports.upload(first.id, first.files[0]!.fileId, Readable.from(data));
    // A new Quota instance models the new backend process, restoring reservations from metadata.
    const quota = new Quota(h.ws, h.limits),
      restarted = new Imports(h.ws, h.limits, quota, h.engine);
    await restarted.init();
    assert.equal((await restarted.create(p.id, input, key)).id, first.id);
    assert.equal(
      (await quota.info()).reserved,
      0,
      'fully received source must not be reserved again',
    );
    const result = await restarted.finalize(first.id, p.revision);
    assert.equal(result.lastImportId, first.id);
    assert.equal(result.frames.length, 1);
    assert.equal((await restarted.create(p.id, input, key)).status, 'finalized');
  } finally {
    await h.close();
  }
});

test('restart repairs finalize metadata when the project commit succeeded before the response', async () => {
  const h = await harness();
  try {
    const p = await h.ws.createProject('commit recovery');
    const data = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const session = await h.imports.create(p.id, {
      expectedRevision: 1,
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
    const beforeFinalize = h.imports.get(session.id);
    const committed = await h.imports.finalize(session.id, 1);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      h.ws.objectPath('uploads', session.id, 'manifest.json'),
      JSON.stringify(beforeFinalize),
    );
    const restarted = new Imports(h.ws, h.limits, new Quota(h.ws, h.limits), h.engine);
    await restarted.init();
    assert.equal(restarted.get(session.id).status, 'finalized');
    const retried = await restarted.finalize(session.id, 1);
    assert.equal(retried.revision, committed.revision);
    assert.deepEqual(
      retried.frames.map((frame) => frame.id),
      committed.frames.map((frame) => frame.id),
    );
  } finally {
    await h.close();
  }
});

test(
  'cancel serializes with progress and commit, cleans temporary output and allows a subsequent real export',
  { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH },
  async () => {
    const h = await harness();
    const jobs = new Exports(h.ws, h.imports, h.engine, h.quota, h.limits);
    await jobs.init();
    try {
      const p = await h.ws.createProject('cancel encoding');
      const data = await sharp({
        create: { width: 100, height: 200, channels: 3, background: 'purple' },
      })
        .png()
        .toBuffer();
      const session = await h.imports.create(p.id, {
        expectedRevision: p.revision,
        purpose: 'frames',
        mode: 'replace',
        files: [
          {
            clientFileId: randomUUID(),
            name: 'frame.png',
            relativePath: 'frame.png',
            size: data.length,
          },
        ],
      });
      await h.imports.upload(session.id, session.files[0]!.fileId, Readable.from(data));
      let project = await h.imports.finalize(session.id, p.revision);
      project = await h.ws.updateProject(project.id, project.revision, (p) => ({
        ...p,
        video: { ...p.video, resolution: '720p' },
        frames: Array.from({ length: 12 }, () => ({ ...p.frames[0]!, id: randomUUID() })),
      }));
      const observed: { id: string; status: string; sequence: number }[] = [];
      const cancellation: { request?: ReturnType<Exports['cancel']> } = {};
      jobs.on('status', (snapshot) => {
        observed.push({ id: snapshot.id, status: snapshot.status, sequence: snapshot.sequence });
        if (snapshot.status === 'encoding' && !cancellation.request)
          cancellation.request = jobs.cancel(snapshot.id);
      });
      const first = await jobs.submit(project.id, project.revision, 'canceled.mp4', randomUUID());
      for (
        let n = 0;
        n < 400 && !cancellation.request && jobs.get(first.id).status !== 'failed';
        n++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(cancellation.request, JSON.stringify(jobs.get(first.id).error));
      assert.equal((await cancellation.request).status, 'canceled');
      assert.equal(jobs.activeJob, null);
      await assert.rejects(jobs.resultPath(first.id), /chưa hoàn tất/);
      await assert.rejects(stat(h.ws.objectPath('outputs', first.id, 'video.part.mp4')));
      await assert.rejects(stat(h.ws.objectPath('outputs', first.id, 'output.mp4')));
      const events = observed.filter((event) => event.id === first.id);
      for (let n = 1; n < events.length; n++) assert(events[n]!.sequence > events[n - 1]!.sequence);
      const canceling = events.findIndex((event) => event.status === 'canceling');
      assert(canceling >= 0);
      assert(
        events.slice(canceling).every((event) => ['canceling', 'canceled'].includes(event.status)),
        'progress cannot regress canceled state',
      );
      const disk = JSON.parse(
        await readFile(h.ws.objectPath('jobs', first.id, 'status.json'), 'utf8'),
      );
      assert.equal(disk.status, 'canceled');
      assert.equal(disk.sequence, jobs.get(first.id).sequence);
      const next = await jobs.submit(project.id, project.revision, 'successful.mp4', randomUUID());
      for (let n = 0; n < 500 && jobs.activeJob; n++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(jobs.get(next.id).status, 'completed', JSON.stringify(jobs.get(next.id).error));
      assert((await stat(await jobs.resultPath(next.id))).size > 0);
      await jobs.shutdown();
      await assert.rejects(
        jobs.submit(project.id, project.revision, 'after-stop.mp4', randomUUID()),
        /đang dừng/,
      );
    } finally {
      await jobs.shutdown();
      await h.close();
    }
  },
);
