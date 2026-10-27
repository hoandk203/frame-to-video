import {
  publishRecord,
  preflightStages,
  readCreation,
  restoreOperation,
} from '../storage/creation.js';
import {
  assetRegistrySchema,
  importOperationsSchema,
  importSessionSchema,
  stored,
  readManifest,
  type Asset,
  type ImportSession,
} from '../storage/manifests.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, rename, unlink, readdir, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  importSchema,
  id,
  naturalCompare,
  type Config,
  type FrameSource,
  projectSchema,
} from '../../../../packages/contracts/src/index.js';
import {
  Workspace,
  atomicJSON,
  readJSON,
  SerialWriter,
  cleanupAtomicTemps,
} from '../storage/workspace.js';
import type { Quota } from '../storage/quota.js';
import type { Engine } from '../media/engine.js';
import { validateImage } from '../rendering/renderer.js';
import { asAppError, assert, AppError } from '../errors.js';

export type { Asset, ImportSession } from '../storage/manifests.js';
export class Imports {
  private sessions = new Map<string, ImportSession>();
  private assets = new Map<string, Asset>();
  private hashIndex: Map<string, Asset[]> | null = null;
  private active = new Map<string, AbortController>();
  private settled = new Map<string, Promise<void>>();
  private creation = new SerialWriter();
  private operations: Record<string, { hash: string; importId: string }> = {};
  private closing = false;
  private pins = new Map<string, number>();
  isProjectBusy: (id: string) => boolean = () => false;
  constructor(
    private ws: Workspace,
    private limits: Config['limits'],
    private quota: Quota,
    private engine: Engine,
  ) {}
  async init() {
    try {
      const assets = await readManifest(
        this.ws.path('registry/assets.json'),
        (v) => stored(assetRegistrySchema, v, 'CORRUPT_REGISTRY'),
        'CORRUPT_REGISTRY',
      );
      for (const asset of assets) {
        id.parse(asset.id);
        this.assets.set(asset.id, asset);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    this.operations = await readManifest(
      this.ws.path('registry/import-operations.json'),
      (raw) => stored(importOperationsSchema, raw, 'CORRUPT_IMPORT_INDEX'),
      'CORRUPT_IMPORT_INDEX',
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    });
    const cleanupStages = await preflightStages(
      this.ws,
      'uploads',
      new Set(Object.values(this.operations).map((operation) => operation.importId)),
    );
    const operations = { ...this.operations };
    let recoveredOperations = false;
    // Validate every manifest before changing files or restoring reservations.
    const restored: ImportSession[] = [];
    for (const dir of await readdir(this.ws.path('uploads'), { withFileTypes: true })) {
      if (!dir.isDirectory() || !id.safeParse(dir.name).success) continue;
      const session = await readManifest(
        this.ws.objectPath('uploads', dir.name, 'manifest.json'),
        (v) => {
          const parsed = stored(importSessionSchema, v, 'CORRUPT_IMPORT');
          assert(
            parsed.id === dir.name,
            'CORRUPT_IMPORT',
            'Manifest nhập không khớp thư mục.',
            500,
          );
          return parsed;
        },
        'CORRUPT_IMPORT',
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError(
            'CORRUPT_IMPORT',
            'Thiếu manifest nhập và backup; giữ nguyên thư mục để phục hồi.',
            500,
          );
        throw error;
      });
      const intent = await readCreation(this.ws, 'uploads', session.id);
      recoveredOperations =
        restoreOperation(
          operations,
          intent,
          (value) => ({ hash: value.hash, importId: value.objectId }),
          (value, creation) => value.hash === creation.hash && value.importId === creation.objectId,
        ) || recoveredOperations;
      restored.push(session);
    }
    const restoredIds = new Set(restored.map((session) => session.id));
    assert(
      Object.values(operations).every((operation) => restoredIds.has(operation.importId)),
      'CORRUPT_IMPORT_INDEX',
      'Registry nhập tham chiếu manifest không tồn tại.',
      500,
    );
    const recovery: { session: ImportSession; projectExists: boolean }[] = [];
    for (const session of restored) {
      const project = await this.ws.project(session.projectId).catch((error) => {
        if (error instanceof AppError && error.code === 'PROJECT_NOT_FOUND') return null;
        throw error;
      });
      if (session.status === 'open' && project?.lastImportId === session.id) {
        session.status = 'finalized';
        session.resultRevision = project.revision;
      }
      if (session.status === 'open')
        for (const file of session.files)
          if (file.assetId) {
            const asset = this.assets.get(file.assetId);
            assert(
              asset && asset.kind === session.purpose && asset.fileSize === file.size,
              'CORRUPT_IMPORT',
              'Nguồn đã nhận trong manifest không khớp registry.',
              500,
            );
          }
      recovery.push({ session, projectExists: !!project });
    }
    if (recoveredOperations)
      await atomicJSON(this.ws.path('registry/import-operations.json'), operations);
    this.operations = operations;
    await cleanupStages();
    await cleanupAtomicTemps(this.ws.path('registry/assets.json'));
    await cleanupAtomicTemps(this.ws.path('registry/import-operations.json'));
    // Only validated, coherent manifests may authorize temporary-file cleanup.
    for (const { session, projectExists } of recovery) {
      await cleanupAtomicTemps(this.ws.objectPath('uploads', session.id, 'manifest.json'));
      await cleanupAtomicTemps(this.ws.objectPath('uploads', session.id, 'creation.json'));
      for (const file of session.files) {
        id.parse(file.fileId);
        await unlink(this.ws.objectPath('uploads', session.id, `${file.fileId}.part`)).catch(
          (error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          },
        );
        if (file.status === 'uploading') {
          file.status = 'invalid';
          file.receivedBytes = 0;
          file.error = new AppError(
            'UPLOAD_INTERRUPTED',
            'Upload bị gián đoạn. Hãy thử lại file.',
            409,
            true,
          ).toJSON();
        }
      }
      if (session.status === 'open') {
        if (!projectExists || Date.parse(session.expiresAt) <= Date.now())
          session.status = 'canceled';
        else {
          try {
            await this.quota.reserve(
              session.id,
              session.files.filter((file) => !file.assetId).reduce((n, file) => n + file.size, 0),
            );
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              !['DISK_FULL', 'UPLOAD_LIMIT_EXCEEDED'].includes(error.code)
            )
              throw error;
            session.status = 'canceled';
          }
        }
      }
      this.sessions.set(session.id, session);
      await this.persist(session);
    }
  }
  async asset(assetId: string, verifyIntegrity = false) {
    id.parse(assetId);
    const asset = this.assets.get(assetId);
    assert(asset, 'SOURCE_MISSING', 'Không tìm thấy nguồn trong workspace.', 404);
    const path = await this.ws.verifiedPath('assets', asset.id, 'source').catch(() => {
      throw new AppError('SOURCE_MISSING', 'File nguồn đã mất.', 422, false, assetId);
    });
    const physical = await stat(path);
    assert(
      physical.size === asset.fileSize,
      'SOURCE_CHANGED',
      'Nguồn trong workspace đã bị thay đổi.',
      422,
    );
    if (
      verifyIntegrity ||
      (asset.modifiedAtMs !== undefined && physical.mtimeMs !== asset.modifiedAtMs)
    ) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      assert(
        hash.digest('hex') === asset.sha256,
        'SOURCE_CHANGED',
        'Nội dung nguồn đã bị thay đổi.',
        422,
      );
    }
    return { ...asset, path };
  }
  metadata(assetId: string) {
    return this.assets.get(id.parse(assetId));
  }
  async findByHash(hash: string, kind: Asset['kind']) {
    if (!this.hashIndex) {
      this.hashIndex = new Map();
      for (const asset of this.assets.values()) {
        const key = `${asset.kind}:${asset.sha256}`;
        const group = this.hashIndex.get(key);
        if (group) group.push(asset);
        else this.hashIndex.set(key, [asset]);
      }
    }
    for (const asset of this.hashIndex.get(`${kind}:${hash}`) ?? []) {
      try {
        return await this.asset(asset.id, true);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['SOURCE_MISSING', 'SOURCE_CHANGED'].includes(error.code)
        )
          throw error;
      }
    }
    return null;
  }
  pin(assetId: string) {
    id.parse(assetId);
    this.pins.set(assetId, (this.pins.get(assetId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pins.get(assetId) ?? 1) - 1;
      if (remaining) this.pins.set(assetId, remaining);
      else this.pins.delete(assetId);
    };
  }
  hasOpenImport(projectId: string) {
    return [...this.sessions.values()].some(
      (s) => s.projectId === projectId && s.status === 'open',
    );
  }
  get(importId: string) {
    id.parse(importId);
    const session = this.sessions.get(importId);
    assert(session, 'IMPORT_NOT_FOUND', 'Không tìm thấy phiên nhập.', 404);
    return structuredClone(session);
  }
  list(projectId: string) {
    id.parse(projectId);
    return [...this.sessions.values()]
      .filter((session) => session.projectId === projectId && session.status === 'open')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => structuredClone(session));
  }
  private async persist(session: ImportSession, alreadyLocked = false) {
    const snapshot = structuredClone(session);
    const write = () =>
      atomicJSON(this.ws.objectPath('uploads', session.id, 'manifest.json'), snapshot);
    if (alreadyLocked) await write();
    else await this.ws.writer.run(write);
  }
  async create(projectId: string, raw: unknown, operationKey: string = randomUUID()) {
    id.parse(operationKey);
    const input = importSchema.parse(raw);
    const hash = createHash('sha256').update(JSON.stringify({ projectId, input })).digest('hex');
    return this.creation.run(async () => {
      const previous = this.operations[operationKey];
      if (previous) {
        assert(
          previous.hash === hash,
          'IDEMPOTENCY_CONFLICT',
          'Key nhập đã được dùng với dữ liệu khác.',
          409,
        );
        return this.get(previous.importId);
      }
      assert(!this.closing, 'APP_STOPPING', 'Ứng dụng đang dừng.', 409);
      assert(!this.isProjectBusy(projectId), 'JOB_BUSY', 'Dự án đang xuất video.', 409);
      const project = await this.ws.project(projectId);
      assert(
        project.revision === input.expectedRevision,
        'REVISION_CONFLICT',
        'Dự án đã thay đổi.',
        409,
      );
      const count = input.files.length + (input.mode === 'append' ? project.frames.length : 0);
      assert(
        input.purpose === 'audio' || count <= this.limits.maxFrames,
        'UPLOAD_LIMIT_EXCEEDED',
        'Quá nhiều frame.',
        413,
      );
      const bytes = input.files.reduce((n, file) => n + file.size, 0);
      assert(
        bytes <= this.limits.maxImportBytes &&
          input.files.every((f) => f.size <= this.limits.maxFileBytes),
        'UPLOAD_LIMIT_EXCEEDED',
        'Vượt dung lượng cho phép.',
        413,
      );
      const session: ImportSession = {
        id: randomUUID(),
        projectId,
        expectedRevision: input.expectedRevision,
        purpose: input.purpose,
        mode: input.mode,
        status: 'open',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.limits.uploadTtlHours * 3600000).toISOString(),
        files: input.files.map((f) => ({
          ...f,
          fileId: randomUUID(),
          status: 'pending',
          receivedBytes: 0,
        })),
      };
      await this.quota.reserve(session.id, bytes);
      let published = false;
      try {
        await publishRecord(
          this.ws,
          { schemaVersion: 1, collection: 'uploads', objectId: session.id, operationKey, hash },
          { 'manifest.json': session },
        );
        published = true;
        const operations = { ...this.operations, [operationKey]: { hash, importId: session.id } };
        await this.ws.writer.run(() =>
          atomicJSON(this.ws.path('registry/import-operations.json'), operations),
        );
        this.operations = operations;
        this.sessions.set(session.id, session);
        return this.get(session.id);
      } catch (error) {
        this.quota.release(session.id);
        if (published)
          await rm(this.ws.path('uploads', session.id), { recursive: true, force: true });
        throw error;
      }
    });
  }
  async upload(importId: string, fileId: string, stream: Readable) {
    assert(!this.closing, 'APP_STOPPING', 'Ứng dụng đang dừng.', 409);
    const session = this.sessions.get(id.parse(importId));
    assert(session?.status === 'open', 'IMPORT_CLOSED', 'Phiên nhập không còn mở.', 409);
    assert(
      Date.parse(session.expiresAt) > Date.now(),
      'IMPORT_EXPIRED',
      'Phiên nhập đã hết hạn.',
      409,
    );
    const file = session.files.find((f) => f.fileId === id.parse(fileId));
    assert(file, 'FILE_NOT_FOUND', 'File không thuộc phiên nhập này.', 404);
    assert(!this.active.has(fileId), 'FILE_BUSY', 'File đang được tải lên.', 409);
    assert(
      this.active.size < this.limits.uploadConcurrency,
      'UPLOAD_BUSY',
      'Đã đạt số upload đồng thời.',
      409,
    );
    const previousAsset = file.assetId,
      controller = new AbortController();
    this.active.set(fileId, controller);
    let finish!: () => void;
    this.settled.set(
      fileId,
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const path = this.ws.objectPath('uploads', session.id, `${fileId}.part`);
    let handle: FileHandle | undefined;
    const hash = createHash('sha256');
    let received = 0;
    const abort = () =>
      stream.destroy(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new AppError('IMPORT_CANCELED', 'Đã hủy nhập dữ liệu.', 409),
      );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const activity = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          controller.abort(
            new AppError('UPLOAD_TIMEOUT', 'Upload không có dữ liệu trong 60 giây.', 408, true),
          ),
        60000,
      );
      idleTimer.unref();
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    // Cancellation can arrive while mkdir/open is pending, before async iteration
    // attaches its error listener. Preserve the rejection without an unhandled event.
    stream.once('error', () => {});
    try {
      await mkdir(this.ws.path('uploads', session.id), { recursive: true });
      handle = await open(path, 'w', 0o600);
      controller.signal.throwIfAborted();
      activity();
      file.status = 'uploading';
      file.receivedBytes = 0;
      delete file.error;
      for await (const chunk of stream) {
        controller.signal.throwIfAborted();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        activity();
        received += buffer.length;
        assert(
          received <= file.size && received <= this.limits.maxFileBytes,
          'UPLOAD_LIMIT_EXCEEDED',
          'File lớn hơn manifest.',
          413,
        );
        hash.update(buffer);
        await handle.writeFile(buffer);
        file.receivedBytes = received;
      }
      clearTimeout(idleTimer);
      assert(received === file.size, 'UPLOAD_INCOMPLETE', 'File tải lên chưa đủ byte.', 422);
      await handle.sync();
      await handle.close();
      const digest = hash.digest('hex');
      if (previousAsset) {
        const previous = this.assets.get(previousAsset);
        assert(
          previous?.sha256 === digest,
          'UPLOAD_CONFLICT',
          'Retry có nội dung khác file đã nhận.',
          409,
        );
        file.status = 'valid';
        return structuredClone(file);
      }
      const asset: Asset = {
        id: randomUUID(),
        kind: session.purpose,
        sha256: digest,
        fileSize: received,
      };
      if (session.purpose === 'frames')
        asset.image = await validateImage(path, this.limits.maxImagePixels);
      else asset.audio = await this.engine.validateAudio(path);
      controller.signal.throwIfAborted();
      await this.ws.writer.run(async () => {
        assert(session.status === 'open', 'IMPORT_CLOSED', 'Phiên nhập đã hủy.', 409);
        const final = this.ws.objectPath('assets', asset.id, 'source');
        await mkdir(this.ws.path('assets', asset.id), { recursive: true });
        await rename(path, final);
        asset.modifiedAtMs = (await stat(final)).mtimeMs;
        const next = [...this.assets.values(), asset];
        await atomicJSON(this.ws.path('registry/assets.json'), next);
        this.assets.set(asset.id, asset);
        this.hashIndex = null;
        file.assetId = asset.id;
        file.status = 'valid';
        await this.persist(session, true);
        this.quota.consumed(session.id, received);
      });
      return structuredClone(file);
    } catch (error) {
      if (!stream.destroyed)
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
      // A conflicting retry must not destroy the already accepted source.
      if (previousAsset) {
        file.status = 'valid';
        file.receivedBytes = file.size;
      } else {
        file.status = 'invalid';
        file.error = asAppError(error).toJSON();
      }
      await this.persist(session);
      throw error;
    } finally {
      clearTimeout(idleTimer);
      await handle?.close().catch(() => {});
      await unlink(path).catch(() => {});
      controller.signal.removeEventListener('abort', abort);
      this.active.delete(fileId);
      this.settled.delete(fileId);
      finish();
    }
  }
  async finalize(importId: string, expectedRevision: number) {
    const session = this.sessions.get(id.parse(importId));
    assert(session, 'IMPORT_NOT_FOUND', 'Không tìm thấy phiên nhập.', 404);
    if (session.status === 'finalized') return this.ws.project(session.projectId);
    assert(
      session.status === 'open' && !this.isProjectBusy(session.projectId),
      'IMPORT_CLOSED',
      'Phiên nhập không thể finalize lúc này.',
      409,
    );
    assert(
      session.files.length > 0 && session.files.every((f) => f.status === 'valid'),
      'IMPORT_INCOMPLETE',
      'Còn file lỗi/chưa nhận đủ.',
      409,
    );
    const project = await this.ws.updateProject(
      session.projectId,
      expectedRevision,
      async (project) => {
        assert(!this.isProjectBusy(session.projectId), 'JOB_BUSY', 'Dự án đang xuất.', 409);
        project.lastImportId = session.id;
        if (session.purpose === 'audio') {
          const asset = await this.asset(session.files[0]!.assetId!);
          if (session.mode === 'relink')
            assert(
              project.audio?.status === 'missing' && project.audio.sha256 === asset.sha256,
              'SOURCE_MISMATCH',
              'File nhạc không khớp nguồn còn thiếu.',
              422,
            );
          project.audio = {
            ...(session.mode === 'relink' ? project.audio : {}),
            assetId: asset.id,
            durationUs: asset.audio!.durationUs,
            volume: session.mode === 'relink' ? project.audio!.volume : 1,
            shortTrackPolicy:
              session.mode === 'relink' ? project.audio!.shortTrackPolicy : 'pad-silence',
            status: 'valid',
            sha256: asset.sha256,
            originalName: session.files[0]!.name,
          };
        } else {
          const sources: FrameSource[] = session.files.map((file) => {
            const asset = this.assets.get(file.assetId!)!;
            return {
              id: randomUUID(),
              assetId: asset.id,
              originalName: file.name,
              relativePath: file.relativePath,
              sha256: asset.sha256,
              fileSize: asset.fileSize,
              ...asset.image!,
              status: 'valid',
            };
          });
          if (session.mode === 'relink') {
            assert(
              sources.every((source) =>
                project.frames.some(
                  (frame) => frame.status === 'missing' && frame.sha256 === source.sha256,
                ),
              ),
              'SOURCE_MISMATCH',
              'Ảnh không khớp nguồn còn thiếu.',
              422,
            );
            const found = new Map(sources.map((source) => [source.sha256, source]));
            project.frames = project.frames.map((frame) => {
              const source = found.get(frame.sha256);
              return frame.status === 'missing' && source
                ? { ...frame, assetId: source.assetId, status: 'valid' }
                : frame;
            });
            return project;
          }
          const existing = session.mode === 'append' ? project.frames : [];
          const seen = new Set(existing.map((f) => `${f.relativePath}\0${f.sha256}`));
          project.frames = [
            ...existing,
            ...sources.filter((f) => {
              const key = `${f.relativePath}\0${f.sha256}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
          ].sort(
            (a, b) =>
              naturalCompare(a.originalName, b.originalName) ||
              naturalCompare(a.relativePath, b.relativePath) ||
              naturalCompare(a.id, b.id),
          );
          assert(
            project.frames.length <= this.limits.maxFrames,
            'UPLOAD_LIMIT_EXCEEDED',
            'Quá nhiều frame.',
            413,
          );
        }
        return project;
      },
    );
    session.status = 'finalized';
    session.resultRevision = project.revision;
    await this.persist(session);
    this.quota.release(session.id);
    return project;
  }
  async removeFile(importId: string, fileId: string) {
    const session = this.sessions.get(id.parse(importId));
    assert(session?.status === 'open', 'IMPORT_CLOSED', 'Phiên nhập không còn mở.', 409);
    assert(!this.active.has(fileId), 'FILE_BUSY', 'Hãy hủy upload trước.', 409);
    const index = session.files.findIndex((f) => f.fileId === id.parse(fileId));
    assert(index >= 0, 'FILE_NOT_FOUND', 'Không tìm thấy file.', 404);
    const [file] = session.files.splice(index, 1);
    // Committed asset bytes have already reduced the reservation during upload.
    if (!file!.assetId) this.quota.consumed(session.id, file!.size);
    await this.persist(session);
    return this.get(importId);
  }
  async cancel(importId: string) {
    const session = this.sessions.get(id.parse(importId));
    assert(session, 'IMPORT_NOT_FOUND', 'Không tìm thấy phiên nhập.', 404);
    assert(session.status !== 'finalized', 'IMPORT_CLOSED', 'Dữ liệu đã thuộc project.', 409);
    session.status = 'canceled';
    for (const file of session.files) this.active.get(file.fileId)?.abort();
    await this.persist(session);
    await Promise.all(session.files.map((file) => this.settled.get(file.fileId)));
    this.quota.release(session.id);
  }

  async expire(now = Date.now()) {
    let expired = 0;
    for (const session of this.sessions.values())
      if (session.status === 'open' && Date.parse(session.expiresAt) <= now) {
        await this.cancel(session.id);
        expired++;
      }
    if (expired) await this.collectGarbage();
    return { expired };
  }
  async shutdown() {
    this.closing = true;
    await this.creation.idle();
    for (const session of this.sessions.values())
      if (session.status === 'open') await this.cancel(session.id);
    await Promise.all(this.settled.values());
  }

  async collectGarbage() {
    return this.ws.writer.run(async () => {
      const referenced = new Set<string>(this.pins.keys());
      const add = (project: ReturnType<typeof projectSchema.parse>) => {
        project.frames.forEach((frame) => referenced.add(frame.assetId));
        if (project.audio) referenced.add(project.audio.assetId);
      };
      // Refuse to collect if authoritative metadata is unreadable; a corrupt project
      // is not proof that its sources may be deleted.
      for (const project of await this.ws.listProjects()) {
        add(project);
        const path = this.ws.objectPath('projects', project.id, 'project.json.bak');
        try {
          add(await readJSON(path, (raw) => projectSchema.parse(raw)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      for (const entry of await readdir(this.ws.path('jobs'), { withFileTypes: true })) {
        if (!entry.isDirectory() || !id.safeParse(entry.name).success) continue;
        add(
          await readJSON(this.ws.objectPath('jobs', entry.name, 'snapshot.json'), (raw) =>
            projectSchema.parse(raw),
          ),
        );
      }
      for (const session of this.sessions.values())
        if (session.status === 'open')
          for (const file of session.files) if (file.assetId) referenced.add(file.assetId);
      const candidates = new Set(
        [...this.assets.keys()].filter((assetId) => !referenced.has(assetId)),
      );
      await atomicJSON(
        this.ws.path('registry/assets.json'),
        [...this.assets.values()].filter((asset) => !candidates.has(asset.id)),
      );
      for (const assetId of candidates) this.assets.delete(assetId);
      this.hashIndex = null;
      let removed = 0;
      for (const entry of await readdir(this.ws.path('assets'), { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          id.safeParse(entry.name).success &&
          !referenced.has(entry.name) &&
          !this.assets.has(entry.name)
        ) {
          await rm(this.ws.path('assets', entry.name), { recursive: true, force: true });
          removed++;
        }
      }
      return { removed, retained: this.assets.size };
    });
  }
}
