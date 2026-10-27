import {
  publishRecord,
  preflightStages,
  readCreation,
  restoreOperation,
} from '../storage/creation.js';
import { exportOperationsSchema, stored, readManifest } from '../storage/manifests.js';
import { MediaScheduler } from '../rendering/scheduler.js';
import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, lstat } from 'node:fs/promises';
import {
  id,
  exportJobSchema,
  projectSchema,
  type Project,
  type ExportJob,
  type Config,
} from '../../../../packages/contracts/src/index.js';
import { Workspace, atomicJSON, cleanupAtomicTemps } from '../storage/workspace.js';
import { asAppError, assert, AppError } from '../errors.js';
import type { Imports } from '../services/imports.js';
import type { Engine } from '../media/engine.js';
import { encoderArgs } from '../media/engine.js';
import { startProcess } from '../media/process.js';
import { renderFrame } from '../rendering/renderer.js';
import type { Quota } from '../storage/quota.js';
import { CliPackageBuilder, type PreparedPackage } from '../services/cli-package.js';
import { archiveFactory, archivePackage } from '../media/archive.js';

const terminal = new Set(['completed', 'failed', 'canceled', 'interrupted']);
export class Exports extends EventEmitter {
  private jobs = new Map<string, ExportJob>();
  private controllers = new Map<string, AbortController>();
  private active: string | null = null;
  private closing = false;
  private running = new Map<string, Promise<void>>();
  private operations: Record<string, { hash: string; jobId: string }> = {};
  private readers = new Map<string, number>();
  private deletingProjects = new Set<string>();
  private deletingResults = new Set<string>();
  constructor(
    private ws: Workspace,
    private imports: Imports,
    private engine: Engine,
    private quota: Quota,
    private limits: Config['limits'],
    private scheduler = new MediaScheduler(),
  ) {
    super();
  }
  async init() {
    this.operations = await readManifest(
      this.ws.path('registry/operations.json'),
      (v) => stored(exportOperationsSchema, v, 'CORRUPT_JOB_INDEX'),
      'CORRUPT_JOB_INDEX',
    ).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    });
    const cleanupStages = await preflightStages(
      this.ws,
      'jobs',
      new Set(Object.values(this.operations).map((operation) => operation.jobId)),
    );
    const operations = { ...this.operations };
    let recoveredOperations = false;
    const restored: ExportJob[] = [];
    for (const dir of await readdir(this.ws.path('jobs'), { withFileTypes: true })) {
      if (!dir.isDirectory() || !id.safeParse(dir.name).success) continue;
      const job = await readManifest(
        this.ws.objectPath('jobs', dir.name, 'status.json'),
        (v) => {
          const parsed = stored(exportJobSchema, v, 'CORRUPT_JOB');
          assert(parsed.id === dir.name, 'CORRUPT_JOB', 'Job ID không khớp thư mục.', 500);
          return parsed;
        },
        'CORRUPT_JOB',
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError('CORRUPT_JOB', 'Thiếu status tác vụ và backup.', 500);
        throw error;
      });
      await readManifest(
        this.ws.objectPath('jobs', dir.name, 'snapshot.json'),
        (raw) => {
          const snapshot = stored(projectSchema, raw, 'CORRUPT_JOB_SNAPSHOT');
          assert(
            snapshot.id === job.projectId &&
              snapshot.revision === job.projectRevision &&
              snapshot.frames.length === job.totalFrames,
            'CORRUPT_JOB_SNAPSHOT',
            'Snapshot không khớp project/revision/frame count của tác vụ.',
            500,
          );
          return snapshot;
        },
        'CORRUPT_JOB_SNAPSHOT',
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError('CORRUPT_JOB_SNAPSHOT', 'Thiếu snapshot tác vụ và backup.', 500);
        throw error;
      });
      const intent = await readCreation(this.ws, 'jobs', job.id);
      const deleting = await lstat(this.ws.objectPath('trash', job.projectId, '')).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        },
      );
      if (!deleting?.isDirectory())
        recoveredOperations =
          restoreOperation(
            operations,
            intent,
            (value) => ({ hash: value.hash, jobId: value.objectId }),
            (value, creation) => value.hash === creation.hash && value.jobId === creation.objectId,
          ) || recoveredOperations;
      restored.push(job);
    }
    const restoredIds = new Set(restored.map((job) => job.id));
    assert(
      Object.values(operations).every((operation) => restoredIds.has(operation.jobId)),
      'CORRUPT_JOB_INDEX',
      'Registry xuất tham chiếu tác vụ không tồn tại.',
      500,
    );
    if (recoveredOperations) await atomicJSON(this.ws.path('registry/operations.json'), operations);
    this.operations = operations;
    await cleanupStages();
    await cleanupAtomicTemps(this.ws.path('registry/operations.json'));
    for (const job of restored) {
      for (const file of ['creation.json', 'status.json', 'snapshot.json'])
        await cleanupAtomicTemps(this.ws.objectPath('jobs', job.id, file));
      if (!terminal.has(job.status)) {
        job.status = 'interrupted';
        job.sequence++;
        job.updatedAt = new Date().toISOString();
        await atomicJSON(this.ws.objectPath('jobs', job.id, 'status.json'), job);
        await rm(this.ws.objectPath('outputs', job.id, 'video.part.mp4'), { force: true });
        await rm(this.ws.objectPath('outputs', job.id, 'package.part.zip'), { force: true });
      }
      if (job.kind === 'cli')
        await rm(this.ws.path('packages', job.id), { recursive: true, force: true });
      this.jobs.set(job.id, job);
    }
    this.imports.isProjectBusy = (projectId) => this.isProjectBusy(projectId);
  }
  isProjectBusy(projectId: string) {
    return !!this.active && this.jobs.get(this.active)?.projectId === projectId;
  }
  get activeJob() {
    return this.active ? this.get(this.active) : null;
  }
  get(jobId: string) {
    const job = this.jobs.get(id.parse(jobId));
    assert(job, 'JOB_NOT_FOUND', 'Không tìm thấy tác vụ.', 404);
    return structuredClone(job);
  }
  list(projectId: string) {
    return [...this.jobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => structuredClone(j))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async persistLocked(job: ExportJob) {
    job.updatedAt = new Date().toISOString();
    job.sequence++;
    const snapshot = structuredClone(job);
    await atomicJSON(
      this.ws.objectPath('jobs', job.id, 'status.json'),
      exportJobSchema.parse(snapshot),
    );
    return snapshot;
  }
  private async save(job: ExportJob) {
    // Snapshot only when this write owns the queue. A queued old progress write
    // must not overwrite a newer cancellation or regress sequence numbers.
    const snapshot = await this.ws.writer.run(() => this.persistLocked(job));
    this.emit('status', snapshot);
  }
  async submit(
    projectId: string,
    revision: number,
    fileName: string,
    key: string,
    kind: ExportJob['kind'] = 'video',
  ) {
    id.parse(key);
    assert(
      fileName.length > 0 &&
        fileName.length <= 120 &&
        !/[\\/\x00-\x1f<>:"|?*]/.test(fileName) &&
        (kind === 'video' ? /\.mp4$/i.test(fileName) : /\.zip$/i.test(fileName)),
      'INVALID_FILENAME',
      kind === 'video' ? 'Tên file MP4 không hợp lệ.' : 'Tên file ZIP không hợp lệ.',
    );
    const hash = createHash('sha256')
      .update(JSON.stringify({ projectId, revision, fileName, kind }))
      .digest('hex');
    return this.ws.writer.run(async () => {
      const previous = this.operations[key];
      if (previous) {
        assert(
          previous.hash === hash,
          'IDEMPOTENCY_CONFLICT',
          'Key đã được dùng với dữ liệu khác.',
          409,
        );
        return this.get(previous.jobId);
      }
      assert(!this.closing, 'APP_STOPPING', 'Ứng dụng đang dừng.', 409);
      assert(!this.active, 'JOB_BUSY', 'Một tác vụ xuất khác đang chạy.', 409);
      const project = await this.ws.project(projectId);
      assert(!this.deletingProjects.has(projectId), 'PROJECT_BUSY', 'Dự án đang được xóa.', 409);
      assert(project.revision === revision, 'REVISION_CONFLICT', 'Dự án đã thay đổi.', 409);
      assert(
        project.frames.length > 0 && project.frames.every((f) => f.status === 'valid'),
        'NO_VALID_FRAMES',
        'Cần ít nhất một ảnh hợp lệ.',
        422,
      );
      assert(
        project.audio?.status !== 'missing',
        'SOURCE_MISSING',
        'Cần liên kết lại nguồn nhạc còn thiếu.',
        422,
      );
      const now = new Date().toISOString();
      const job: ExportJob = {
        id: randomUUID(),
        projectId,
        projectRevision: revision,
        kind,
        status: 'validating',
        processedFrames: 0,
        encodedFrames: 0,
        totalFrames: project.frames.length,
        percent: 0,
        sequence: 0,
        createdAt: now,
        updatedAt: now,
        elapsedMs: 0,
        speedFps: null,
        etaMs: null,
        fileName,
        result: null,
        error: null,
      };
      const operations = { ...this.operations, [key]: { hash, jobId: job.id } };
      let published = false;
      try {
        await publishRecord(
          this.ws,
          { schemaVersion: 1, collection: 'jobs', objectId: job.id, operationKey: key, hash },
          { 'snapshot.json': project, 'status.json': job },
        );
        published = true;
        await atomicJSON(this.ws.path('registry/operations.json'), operations);
      } catch (error) {
        if (published) await rm(this.ws.path('jobs', job.id), { recursive: true, force: true });
        throw error;
      }
      this.operations = operations;
      this.jobs.set(job.id, job);
      this.active = job.id;
      // Publish the cancel controller before any caller can observe an active job.
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      const task = this.run(job, project, controller.signal);
      this.running.set(job.id, task);
      void task
        .finally(() => {
          this.running.delete(job.id);
          this.controllers.delete(job.id);
        })
        .catch(() => {});
      return structuredClone(job);
    });
  }
  private async run(job: ExportJob, project: Project, signal: AbortSignal) {
    const releaseMedia = this.scheduler.beginExport();
    const started = performance.now();
    let lastSave = 0;
    const temp = this.ws.objectPath(
      'outputs',
      job.id,
      job.kind === 'cli' ? 'package.part.zip' : 'video.part.mp4',
    );
    let proc: ReturnType<typeof startProcess> | undefined;
    const refresh = async (force = false) => {
      job.elapsedMs = Math.round(performance.now() - started);
      if (job.encodedFrames > 0 && job.elapsedMs > 1000) {
        job.speedFps = (job.encodedFrames * 1000) / job.elapsedMs;
        job.etaMs = Math.round(((job.totalFrames - job.encodedFrames) / job.speedFps) * 1000);
      }
      job.percent = Math.max(
        job.percent,
        Math.min(99, Math.floor((job.encodedFrames / job.totalFrames) * 95)),
      );
      if (force || performance.now() - lastSave >= 200) {
        lastSave = performance.now();
        await this.save(job);
      }
    };
    try {
      if (job.kind === 'cli') {
        await this.runCli(job, project, signal, started, temp);
        return;
      }
      await this.quota.check();
      signal.throwIfAborted();
      const status = await this.engine.status();
      assert(
        status.ready,
        status.error?.code ?? 'ENGINE_UNAVAILABLE',
        status.error?.message ?? 'Engine chưa sẵn sàng.',
        503,
      );
      const sources = [];
      for (const frame of project.frames) {
        signal.throwIfAborted();
        const asset = await this.imports.asset(frame.assetId, true);
        assert(asset.sha256 === frame.sha256, 'SOURCE_CHANGED', 'Nguồn đã thay đổi.', 422);
        sources.push(asset);
      }
      const audio = project.audio
        ? await this.imports.asset(project.audio.assetId, true)
        : undefined;
      signal.throwIfAborted();
      job.status = 'preparing';
      await this.save(job);
      await mkdir(this.ws.path('outputs', job.id), { recursive: true });
      signal.throwIfAborted();
      let progressText = '';
      proc = startProcess(this.engine.ffmpeg, encoderArgs(project, temp, audio?.path), {
        signal,
        onOutput: (chunk) => {
          progressText += chunk;
          const lines = progressText.split('\n');
          progressText = lines.pop() ?? '';
          for (const line of lines)
            if (line.startsWith('frame='))
              job.encodedFrames = Math.max(
                job.encodedFrames,
                Math.min(job.totalFrames, Number(line.slice(6).trim()) || 0),
              );
        },
      });
      job.status = 'encoding';
      await this.save(job);
      for (const source of sources) {
        signal.throwIfAborted();
        const frame = await this.scheduler.run(
          (renderSignal) =>
            renderFrame(
              source.path,
              project.video,
              this.limits.maxImagePixels,
              'output-check',
              renderSignal,
            ),
          { priority: 'export', signal },
        );
        if (!proc.child.stdin.write(frame.data))
          await Promise.race([
            once(proc.child.stdin, 'drain', { signal }),
            proc.done.then(() => {
              throw new Error('Encoder đóng trước khi nhận đủ frame');
            }),
          ]);
        job.processedFrames++;
        await refresh();
        if (job.processedFrames % 24 === 0) await this.quota.check();
      }
      proc.child.stdin.end();
      await proc.done;
      signal.throwIfAborted();
      job.encodedFrames = job.totalFrames;
      job.status = 'finalizing';
      await refresh(true);
      await this.engine.verify(temp, project, signal);
      signal.throwIfAborted();
      await this.commit(job, project, temp, signal, started);
    } catch (error) {
      if (job.status === 'completed') {
        this.emit('maintenance-error', error);
        return;
      }
      if (proc && proc.child.exitCode === null) {
        proc.child.kill('SIGKILL');
        await proc.done.catch(() => {});
      }
      await rm(temp, { force: true });
      await rm(
        this.ws.objectPath('outputs', job.id, job.kind === 'cli' ? 'output.zip' : 'output.mp4'),
        { force: true },
      );
      job.status = signal.aborted ? 'canceled' : 'failed';
      job.error = signal.aborted ? null : asAppError(error).toJSON();
      job.etaMs = null;
      await this.save(job);
    } finally {
      releaseMedia();
      if (this.active === job.id) this.active = null;
    }
  }
  private async commit(
    job: ExportJob,
    project: Project,
    temp: string,
    signal: AbortSignal,
    started: number,
  ) {
    const completed = await this.ws.writer.run(async () => {
      signal.throwIfAborted();
      const output = this.ws.objectPath(
        'outputs',
        job.id,
        job.kind === 'cli' ? 'output.zip' : 'output.mp4',
      );
      await rename(temp, output);
      const snapshot: ExportJob = {
        ...job,
        status: 'completed',
        percent: 100,
        etaMs: 0,
        sequence: job.sequence + 1,
        updatedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started),
        result: {
          bytes: (await stat(output)).size,
          durationUs: Math.round((project.frames.length / project.video.fps) * 1e6),
          mime: job.kind === 'cli' ? 'application/zip' : 'video/mp4',
        },
      };
      await atomicJSON(
        this.ws.objectPath('jobs', job.id, 'status.json'),
        exportJobSchema.parse(snapshot),
      );
      Object.assign(job, snapshot);
      return structuredClone(snapshot);
    });
    this.emit('status', completed);
  }
  private async runCli(
    job: ExportJob,
    project: Project,
    signal: AbortSignal,
    started: number,
    temp: string,
  ) {
    const factory = archiveFactory(); // fail before expensive rendering if the installation is incomplete
    const builder = new CliPackageBuilder(
      this.ws,
      this.imports,
      this.quota,
      this.limits,
      this.scheduler,
    );
    let prepared: PreparedPackage | null = null,
      lastSave = 0;
    const report = async (force = false) => {
      job.elapsedMs = Math.round(performance.now() - started);
      if (force || performance.now() - lastSave >= 200) {
        lastSave = performance.now();
        await this.save(job);
      }
    };
    try {
      await this.quota.check();
      signal.throwIfAborted();
      job.status = 'preparing';
      await report(true);
      prepared = await builder.prepare(project, job.id, signal, async (frames) => {
        job.processedFrames = frames;
        job.percent = Math.max(job.percent, Math.floor((frames / job.totalFrames) * 70));
        await report();
      });
      signal.throwIfAborted();
      await mkdir(this.ws.path('outputs', job.id), { recursive: true });
      signal.throwIfAborted();
      job.status = 'encoding';
      await report(true);
      const expectedBytes = prepared.stageBytes + prepared.entries.length * 512 + 65536;
      await archivePackage(
        prepared,
        temp,
        this.quota,
        signal,
        async (bytes) => {
          job.percent = Math.max(
            job.percent,
            Math.min(95, 70 + Math.floor((bytes / expectedBytes) * 25)),
          );
          await report();
        },
        factory,
      );
      signal.throwIfAborted();
      job.status = 'finalizing';
      job.encodedFrames = job.totalFrames;
      await report(true);
      await this.commit(job, project, temp, signal, started);
    } finally {
      if (prepared) await builder.cleanup(prepared);
    }
  }
  async cancel(jobId: string) {
    const snapshot = await this.ws.writer.run(async () => {
      const job = this.jobs.get(id.parse(jobId));
      assert(job, 'JOB_NOT_FOUND', 'Không tìm thấy tác vụ.', 404);
      if (terminal.has(job.status)) return structuredClone(job);
      job.status = 'canceling';
      this.controllers.get(jobId)?.abort(new DOMException('Đã hủy', 'AbortError'));
      return this.persistLocked(job);
    });
    this.emit('status', snapshot);
    await this.running.get(jobId);
    return this.get(jobId);
  }
  async shutdown() {
    await this.ws.writer.run(async () => {
      this.closing = true;
    });
    if (this.active) await this.cancel(this.active);
    await Promise.all(this.running.values());
  }
  async resultPath(jobId: string) {
    const job = this.get(jobId);
    assert(
      job.status === 'completed' && job.result,
      'RESULT_NOT_READY',
      'Kết quả chưa hoàn tất.',
      409,
    );
    return this.ws.verifiedPath(
      'outputs',
      job.id,
      job.kind === 'cli' ? 'output.zip' : 'output.mp4',
    );
  }
  acquireReader(jobId: string) {
    const job = this.get(jobId);
    assert(
      job.result && !this.deletingProjects.has(job.projectId) && !this.deletingResults.has(job.id),
      'RESULT_NOT_READY',
      'Kết quả đang được xóa hoặc không tồn tại.',
      409,
    );
    this.readers.set(jobId, (this.readers.get(jobId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers.set(jobId, Math.max(0, (this.readers.get(jobId) ?? 1) - 1));
    };
  }
  async deleteResult(jobId: string) {
    const snapshot = await this.ws.writer.run(async () => {
      assert(!this.readers.get(jobId), 'RESULT_BUSY', 'Kết quả đang được đọc.', 409);
      const job = this.jobs.get(id.parse(jobId));
      assert(
        job?.status === 'completed' && !this.deletingProjects.has(job.projectId),
        'RESULT_NOT_READY',
        'Không có kết quả hoàn tất.',
        409,
      );
      this.deletingResults.add(jobId);
      try {
        await rm(this.ws.path('outputs', job.id), { recursive: true, force: true });
        job.result = null;
        return await this.persistLocked(job);
      } finally {
        this.deletingResults.delete(jobId);
      }
    });
    this.emit('status', snapshot);
  }

  assertProjectRemovable(projectId: string) {
    assert(
      !this.isProjectBusy(projectId),
      'JOB_BUSY',
      'Dự án đang xuất. Hãy hủy hoặc đợi hoàn tất.',
      409,
    );
    assert(
      ![...this.jobs.values()].some(
        (job) => job.projectId === projectId && this.readers.get(job.id),
      ),
      'RESULT_BUSY',
      'Có kết quả dự án đang được đọc.',
      409,
    );
  }

  beginProjectDeletion(projectId: string) {
    this.assertProjectRemovable(projectId);
    assert(!this.deletingProjects.has(projectId), 'PROJECT_BUSY', 'Dự án đang được xóa.', 409);
    this.deletingProjects.add(projectId);
    return () => this.deletingProjects.delete(projectId);
  }

  /** Caller holds Workspace.writer, so new export submissions cannot interleave. */
  async removeProjectJobs(projectId: string) {
    this.assertProjectRemovable(projectId);
    const alreadyDeleting = this.deletingProjects.has(projectId);
    this.deletingProjects.add(projectId);
    try {
      const removed = [...this.jobs.values()].filter((job) => job.projectId === projectId);
      const ids = new Set(removed.map((job) => job.id));
      const operations = Object.fromEntries(
        Object.entries(this.operations).filter(([, value]) => !ids.has(value.jobId)),
      );
      await atomicJSON(this.ws.path('registry/operations.json'), operations);
      this.operations = operations;
      for (const job of removed) {
        await rm(this.ws.path('outputs', job.id), { recursive: true, force: true });
        await rm(this.ws.path('packages', job.id), { recursive: true, force: true });
        await rm(this.ws.path('jobs', job.id), { recursive: true, force: true });
        this.jobs.delete(job.id);
        this.readers.delete(job.id);
      }
    } finally {
      if (!alreadyDeleting) this.deletingProjects.delete(projectId);
    }
  }
}
