import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SerialWriter } from './workspace.js';

interface Limits {
  maxBytes: number;
  maxEntryBytes: number;
  maxFiles: number;
  maxAgeMs: number;
}
const defaults: Limits = {
  maxBytes: 10 * 1024 * 1024,
  maxEntryBytes: 64 * 1024,
  maxFiles: 1000,
  maxAgeMs: 7 * 86400000,
};
export class Diagnostics {
  private writer = new SerialWriter();
  private limits: Limits;
  constructor(
    private dir: string,
    limits: Partial<Limits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
    if (Object.values(this.limits).some((value) => !Number.isFinite(value) || value <= 0))
      throw new Error('Invalid diagnostic limits');
  }
  async record(error: unknown) {
    return this.writer.run(async () => {
      await mkdir(this.dir, { recursive: true });
      const id = randomUUID(),
        path = resolve(this.dir, `${id}.log`);
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const content = Buffer.from(`${new Date().toISOString()} ${message}\n`).subarray(
        0,
        Math.min(this.limits.maxEntryBytes, this.limits.maxBytes),
      );
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      try {
        await this.trim(id);
      } catch (cause) {
        await unlink(path).catch(() => {});
        throw cause;
      }
      return id;
    });
  }
  private async trim(keep?: string) {
    const entries = [];
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.log$/.test(entry.name)
      )
        continue;
      const info = await stat(resolve(this.dir, entry.name));
      entries.push({ name: entry.name, bytes: info.size, at: info.mtimeMs });
    }
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0),
      count = entries.length;
    entries.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === `${keep}.log`) continue;
      if (
        bytes <= this.limits.maxBytes &&
        count <= this.limits.maxFiles &&
        Date.now() - entry.at <= this.limits.maxAgeMs
      )
        continue;
      try {
        await unlink(resolve(this.dir, entry.name));
        bytes -= entry.bytes;
        count--;
      } catch (error) {
        if (
          !['EPERM', 'EACCES', 'EBUSY', 'ENOENT'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
      }
    }
    if (bytes > this.limits.maxBytes || count > this.limits.maxFiles)
      throw new Error('Diagnostic log quota cannot be reclaimed');
  }
  async idle() {
    await this.writer.idle();
  }
}
