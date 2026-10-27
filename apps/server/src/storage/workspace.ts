import { randomUUID, createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  open,
  rename,
  copyFile,
  stat,
  readdir,
  unlink,
  realpath,
} from 'node:fs/promises';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import {
  id,
  projectSchema,
  videoSchema,
  type Project,
} from '../../../../packages/contracts/src/index.js';
import { AppError, assert } from '../errors.js';

export class SerialWriter {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async idle() {
    await this.tail;
  }
}
export async function atomicJSON(path: string, value: unknown, backup = true): Promise<void> {
  // Serialize before touching disk; invalid/circular values must not leave temp files.
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('JSON value cannot be undefined');
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const file = await open(temp, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    if (backup) {
      const backupTemp = `${path}.${randomUUID()}.bak.tmp`;
      try {
        await copyFile(path, backupTemp);
        await rename(backupTemp, `${path}.bak`);
      } catch (error) {
        await unlink(backupTemp).catch(() => {});
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    // Never unlink the last-good target before replacing it.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, path);
        break;
      } catch (error) {
        if (
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
          attempt >= 4
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } finally {
    if (created) await unlink(temp).catch(() => {});
  }
}
/** Startup only: callers must validate durable primary/backup before discarding unfinished atomic writes. */
export async function cleanupAtomicTemps(path: string) {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const prefix = `${basename(path)}.`;
  let removed = 0;
  for (const entry of await readdir(dirname(path), { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    const suffix = entry.name.slice(prefix.length);
    const match = /^([0-9a-f-]{36})\.(?:bak\.)?tmp$/.exec(suffix);
    if (!match || !id.safeParse(match[1]).success) continue;
    assert(
      entry.isFile(),
      'CORRUPT_METADATA',
      'Atomic metadata temp không phải file thường; giữ nguyên dữ liệu.',
      500,
    );
    await unlink(resolve(dirname(path), entry.name));
    removed++;
  }
  return removed;
}
export async function readJSON<T>(path: string, validate: (raw: unknown) => T): Promise<T> {
  try {
    return validate(JSON.parse(await readFile(path, 'utf8')));
  } catch (primary) {
    try {
      const recovered = validate(JSON.parse(await readFile(`${path}.bak`, 'utf8')));
      // Do not overwrite the backup with the damaged primary during recovery.
      await atomicJSON(path, recovered, false);
      return recovered;
    } catch (backup) {
      if (
        (primary as NodeJS.ErrnoException).code === 'ENOENT' &&
        (backup as NodeJS.ErrnoException).code !== 'ENOENT'
      )
        throw backup;
      throw primary;
    }
  }
}
export class Workspace {
  readonly writer = new SerialWriter();
  private lock: Awaited<ReturnType<typeof open>> | null = null;
  constructor(public root: string) {}
  path(...parts: string[]) {
    const path = resolve(this.root, ...parts);
    const rel = relative(this.root, path);
    assert(
      rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
      'INVALID_PATH',
      'Đường dẫn ngoài workspace bị từ chối',
    );
    return path;
  }
  objectPath(kind: string, objectId: string, file: string) {
    return this.path(kind, id.parse(objectId), file);
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    this.root = await realpath(this.root);
    const lockPath = this.path('.workspace.lock');
    try {
      this.lock = await open(lockPath, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      throw new AppError(
        'WORKSPACE_LOCKED',
        'Workspace đang được sử dụng hoặc còn lock sau crash. Launcher phải xác minh instance trước khi phục hồi lock.',
        409,
      );
    }
    try {
      await this.lock.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      for (const folder of [
        'projects',
        'assets',
        'uploads',
        'jobs',
        'outputs',
        'packages',
        'cache',
        'logs',
        'registry',
      ])
        await mkdir(this.path(folder), { recursive: true });
      const { preflightStages } = await import('./creation.js');
      const cleanProjectStages = await preflightStages(this, 'projects', new Set());
      const projects = await this.listProjects();
      for (const project of projects) {
        await cleanupAtomicTemps(this.objectPath('projects', project.id, 'project.json'));
        await cleanupAtomicTemps(this.objectPath('projects', project.id, 'creation.json'));
      }
      await cleanProjectStages();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }
  async close() {
    await this.writer.idle();
    if (this.lock) {
      await this.lock.close();
      this.lock = null;
      await unlink(this.path('.workspace.lock'));
    }
  }
  async project(projectId: string): Promise<Project> {
    try {
      return await readJSON(this.objectPath('projects', projectId, 'project.json'), (x) => {
        const parsed = projectSchema.safeParse(x);
        assert(parsed.success, 'CORRUPT_PROJECT', 'Metadata project không hợp lệ.', 500);
        const project = parsed.data;
        assert(project.id === projectId, 'CORRUPT_PROJECT', 'Project ID không khớp thư mục.', 500);
        return project;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError('PROJECT_NOT_FOUND', 'Không tìm thấy dự án.', 404);
      if (error instanceof SyntaxError)
        throw new AppError('CORRUPT_PROJECT', 'Không đọc được project hoặc backup hợp lệ.', 500);
      throw error;
    }
  }
  async listProjects() {
    const entries = await readdir(this.path('projects'), { withFileTypes: true });
    const result: Project[] = [];
    for (const entry of entries)
      if (entry.isDirectory() && id.safeParse(entry.name).success)
        result.push(await this.project(entry.name));
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async createProject(name: string) {
    return this.writer.run(async () => {
      const now = new Date().toISOString();
      const project = projectSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        revision: 1,
        name,
        createdAt: now,
        updatedAt: now,
        frames: [],
        video: videoSchema.parse({}),
        audio: null,
      });
      await this.publishProject(project);
      return project;
    });
  }
  async publishProject(project: Project) {
    const { publishRecord } = await import('./creation.js');
    await publishRecord(
      this,
      {
        schemaVersion: 1,
        collection: 'projects',
        objectId: project.id,
        operationKey: project.id,
        hash: createHash('sha256').update(JSON.stringify(project)).digest('hex'),
      },
      { 'project.json': project },
    );
  }
  async updateProject(
    projectId: string,
    expected: number,
    change: (current: Project) => Project | Promise<Project>,
  ) {
    return this.writer.run(async () => {
      const current = await this.project(projectId);
      assert(
        current.revision === expected,
        'REVISION_CONFLICT',
        `Dự án đã thay đổi. Revision hiện tại: ${current.revision}`,
        409,
      );
      const changed = await change(structuredClone(current));
      const next = projectSchema.parse({
        ...changed,
        id: current.id,
        createdAt: current.createdAt,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await atomicJSON(this.objectPath('projects', projectId, 'project.json'), next);
      return next;
    });
  }
  async diskUsage(path = this.root): Promise<number> {
    let bytes = 0;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (path !== this.root && (error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isSymbolicLink())
        throw new AppError('INVALID_PATH', 'Workspace chứa symbolic link không được hỗ trợ.', 403);
      try {
        bytes += entry.isDirectory() ? await this.diskUsage(child) : (await stat(child)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return bytes;
  }
  async verifiedPath(...parts: string[]) {
    const canonical = await realpath(this.path(...parts));
    this.path(relative(this.root, canonical));
    return canonical;
  }
}
