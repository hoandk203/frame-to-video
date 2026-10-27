import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, readFile, rename, unlink, utimes } from 'node:fs/promises';
import { AppError, assert } from '../errors.js';
import { SerialWriter, type Workspace } from './workspace.js';
import type { Quota } from './quota.js';

const owned = /^[a-f0-9]{64}\.(png|m4a)$/;
const temporary = /^(?:\.cache-[0-9a-f-]{36}\.part|[a-f0-9]{64}\.(?:png|m4a)\.[0-9a-f-]{36}\.tmp)$/;
type Extension = 'png' | 'm4a';
interface Entry {
  name: string;
  bytes: number;
  touched: number;
  readers: number;
  path?: string;
  data?: Buffer;
}
export interface CacheLease {
  bytes: number;
  path?: string;
  data?: Buffer;
  release: () => void;
}
/** Cache owns only hash-named media and its UUID temporary files, never its whole directory. */
export class PreviewCache {
  private entries = new Map<string, Entry>();
  private writer = new SerialWriter();
  private initialized?: Promise<void>;
  private epoch = 0;
  constructor(
    private ws: Workspace,
    private quota: Quota,
    private memoryLimit: number,
    private diskLimit: number,
    private maxEntries = 4096,
  ) {
    for (const value of [memoryLimit, diskLimit, maxEntries]) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError('Invalid preview cache budget');
    }
    if (!maxEntries) throw new RangeError('Cache entry limit must be positive');
  }
  get stats() {
    return {
      entries: this.entries.size,
      memoryBytes: [...this.entries.values()].reduce(
        (n, entry) => n + (entry.data?.length ?? 0),
        0,
      ),
      diskBytes: [...this.entries.values()].reduce(
        (n, entry) => n + (entry.path ? entry.bytes : 0),
        0,
      ),
      readers: [...this.entries.values()].reduce((n, entry) => n + entry.readers, 0),
    };
  }
  init() {
    return (this.initialized ??= this.writer.run(async () => {
      for (const dirent of await readdir(this.ws.path('cache'), { withFileTypes: true })) {
        if (!owned.test(dirent.name) && !temporary.test(dirent.name)) continue;
        const path = this.ws.path('cache', dirent.name);
        assert(dirent.isFile(), 'INVALID_PATH', 'Cache media không phải file thường.', 403);
        if (temporary.test(dirent.name)) {
          await unlink(path);
          continue;
        }
        const info = await lstat(path);
        this.entries.set(dirent.name, {
          name: dirent.name,
          path,
          bytes: info.size,
          touched: info.mtimeMs,
          readers: 0,
        });
        await this.trim(0, 0, 0);
      }
    }));
  }
  private name(key: string, extension: Extension) {
    const name = `${key}.${extension}`;
    assert(owned.test(name), 'INVALID_CACHE_KEY', 'Cache key không hợp lệ.');
    return name;
  }
  async has(key: string, extension: Extension) {
    const lease = await this.acquire(key, extension);
    if (!lease) return false;
    lease.release();
    return true;
  }
  async acquire(key: string, extension: Extension): Promise<CacheLease | null> {
    await this.init();
    const name = this.name(key, extension);
    return this.writer.run(async () => {
      const entry = this.entries.get(name);
      if (!entry) return null;
      if (entry.path) {
        try {
          const info = await lstat(entry.path);
          assert(
            info.isFile() && info.size === entry.bytes,
            'CACHE_CHANGED',
            'File cache đã thay đổi.',
            409,
          );
          await utimes(entry.path, new Date(), new Date());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!entry.readers) this.entries.delete(name);
          return null;
        }
      }
      if (!entry.data && entry.path && entry.bytes <= this.memoryLimit) {
        await this.trimMemory(entry.bytes);
        if (this.stats.memoryBytes + entry.bytes <= this.memoryLimit)
          entry.data = await readFile(entry.path);
      }
      entry.touched = Date.now();
      entry.readers++;
      this.entries.delete(name);
      this.entries.set(name, entry);
      let released = false;
      return {
        bytes: entry.bytes,
        path: entry.path,
        data: entry.data,
        release: () => {
          if (!released) {
            released = true;
            entry.readers--;
          }
        },
      };
    });
  }
  /** Producer must enforce maxBytes while writing (FFmpeg uses -fs); publication checks it again. */
  async generate(
    key: string,
    extension: Extension,
    maxBytes: number,
    producer: (path: string) => Promise<void>,
    signal?: AbortSignal,
  ) {
    await this.init();
    const name = this.name(key, extension);
    assert(
      Number.isSafeInteger(maxBytes) && maxBytes > 0,
      'INVALID_CACHE_SIZE',
      'Cache size không hợp lệ.',
    );
    assert(
      maxBytes <= Math.max(this.memoryLimit, this.diskLimit),
      'PREVIEW_CACHE_LIMIT',
      'Preview vượt ngân sách cache.',
      507,
    );
    const epoch = this.epoch,
      reservation = `cache:${randomUUID()}`;
    const temp = this.ws.path('cache', `.cache-${randomUUID()}.part`);
    let created = false;
    await this.writer.run(async () => {
      await this.trim(0, this.diskLimit ? Math.min(maxBytes, this.diskLimit) : 0, 1);
    });
    await this.quota.reserve(reservation, maxBytes);
    try {
      signal?.throwIfAborted();
      const handle = await open(temp, 'wx');
      created = true;
      await handle.close();
      await producer(temp);
      signal?.throwIfAborted();
      const info = await lstat(temp);
      assert(
        info.isFile() && info.size > 0 && info.size <= maxBytes,
        'PREVIEW_CACHE_LIMIT',
        'Preview vượt giới hạn dung lượng hoặc file rỗng.',
        507,
      );
      await this.writer.run(async () => {
        signal?.throwIfAborted();
        assert(
          epoch === this.epoch,
          'PREVIEW_SUPERSEDED',
          'Cache đã được xóa khi preview đang tạo.',
          409,
        );
        // A duplicate producer cannot replace an entry held by an active reader.
        if (this.entries.has(name)) return;
        const keepDisk = info.size <= this.diskLimit;
        const keepMemory = info.size <= this.memoryLimit;
        await this.trim(keepDisk ? 0 : info.size, keepDisk ? info.size : 0, 1);
        let data: Buffer | undefined;
        if (keepMemory) {
          await this.trimMemory(info.size);
          if (this.stats.memoryBytes + info.size <= this.memoryLimit) data = await readFile(temp);
        }
        assert(
          keepDisk || data,
          'PREVIEW_CACHE_BUSY',
          'Cache đang được sử dụng. Thử lại sau.',
          503,
        );
        const path = keepDisk ? this.ws.path('cache', name) : undefined;
        if (path) await rename(temp, path);
        this.entries.set(name, {
          name,
          path,
          data,
          bytes: info.size,
          touched: Date.now(),
          readers: 0,
        });
      });
      this.quota.consumed(reservation, info.size);
    } finally {
      try {
        if (created)
          await unlink(temp).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
      } finally {
        this.quota.release(reservation);
      }
    }
  }
  async put(key: string, data: Buffer, signal?: AbortSignal) {
    await this.generate(
      key,
      'png',
      data.length,
      async (path) => {
        const handle = await open(path, 'r+');
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      signal,
    );
  }
  private async remove(entry: Entry) {
    assert(!entry.readers, 'PREVIEW_CACHE_BUSY', 'Cache đang được đọc.', 409);
    if (entry.path)
      await unlink(entry.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    this.entries.delete(entry.name);
  }
  private async trimMemory(additional: number) {
    for (const entry of [...this.entries.values()].sort((a, b) => a.touched - b.touched)) {
      if (this.stats.memoryBytes + additional <= this.memoryLimit) break;
      if (entry.readers || !entry.data) continue;
      if (entry.path) entry.data = undefined;
      else await this.remove(entry);
    }
  }
  private async trim(memory: number, disk: number, count: number) {
    await this.trimMemory(memory);
    for (const entry of [...this.entries.values()].sort((a, b) => a.touched - b.touched)) {
      if (
        this.stats.diskBytes + disk <= this.diskLimit &&
        this.entries.size + count <= this.maxEntries
      )
        break;
      if (!entry.readers) await this.remove(entry);
    }
    assert(
      this.stats.diskBytes + disk <= this.diskLimit &&
        this.stats.memoryBytes + memory <= this.memoryLimit &&
        this.entries.size + count <= this.maxEntries,
      'PREVIEW_CACHE_BUSY',
      'Cache đã đầy và đang được đọc. Thử lại sau.',
      503,
    );
  }
  async clear() {
    await this.init();
    await this.writer.run(async () => {
      assert(!this.stats.readers, 'PREVIEW_CACHE_BUSY', 'Preview đang được đọc. Thử lại sau.', 409);
      this.epoch++;
      for (const entry of [...this.entries.values()]) await this.remove(entry);
    });
  }
}
