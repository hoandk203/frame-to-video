import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import type { PreparedPackage } from '../services/cli-package.js';
import type { Quota } from '../storage/quota.js';
import { assert, AppError } from '../errors.js';

interface Archive extends Readable {
  append(input: Readable, data: { name: string; date: Date; mode: number }): this;
  finalize(): Promise<void>; abort(): this;
}
type Factory = (format: 'zip', options: { forceZip64: boolean; statConcurrency: number; zlib: { level: number } }) => Archive;
/** Runtime facade keeps video/core usable while an incomplete developer install reports a clear ZIP error. */
export function archiveFactory(): Factory {
  try {
    const factory: unknown = createRequire(import.meta.url)('archiver');
    assert(typeof factory === 'function', 'ARCHIVE_ENGINE_UNAVAILABLE', 'Thư viện ZIP không hợp lệ.', 503);
    return factory as Factory;
  } catch { throw new AppError('ARCHIVE_ENGINE_UNAVAILABLE', 'Thiếu thư viện tạo ZIP. Cần bản ứng dụng có đủ dependency.', 503); }
}
export async function archivePackage(prepared: PreparedPackage, destination: string, quota: Quota, signal: AbortSignal,
  onBytes: (bytes: number) => Promise<void> = async () => {}, factory = archiveFactory()) {
  signal.throwIfAborted();
  const archive = factory('zip', { forceZip64: true, statConcurrency: 1, zlib: { level: 6 } });
  const handle = await open(destination, 'wx', 0o600);
  let bytes = 0;
  let source: ReturnType<typeof createReadStream> | null = null;
  const sink = new Writable({ highWaterMark: 65536, write(chunk: Buffer, _encoding, callback) {
    quota.ensure(prepared.reservationKey, chunk.length, 1024 * 1024).then(async () => {
      signal.throwIfAborted(); await handle.writeFile(chunk);
      bytes += chunk.length; quota.consumed(prepared.reservationKey, chunk.length); await onBytes(bytes);
    }).then(() => callback(), (error: Error) => callback(error));
  } });
  const abort = () => { source?.destroy(signal.reason instanceof Error ? signal.reason : new Error('Canceled')); archive.abort(); archive.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  archive.on('warning', (error: Error) => archive.destroy(error));
  const piping = pipeline(archive, sink, { signal });
  void piping.catch(() => {});
  try {
    // One source at a time: no thousands of open file descriptors; abort owns the active source.
    for (const entry of prepared.entries) {
      signal.throwIfAborted();
      source = createReadStream(entry.path, { highWaterMark: 65536, signal });
      source.on('error', (error) => archive.destroy(error));
      const entered = once(archive, 'entry', { signal });
      archive.append(source, { name: entry.name, date: new Date('2000-01-01T00:00:00Z'), mode: 0o600 });
      await entered; await finished(source, { cleanup: true }); source = null;
    }
    await Promise.all([archive.finalize(), piping]);
    signal.throwIfAborted(); await handle.sync(); await handle.close();
    await verifyZipEnvelope(destination, prepared.entries.length);
    return { bytes };
  } catch (error) {
    abort(); await piping.catch(() => {});
    if (source) await finished(source, { cleanup: true }).catch(() => {});
    await handle.close().catch(() => {}); await unlink(destination).catch(() => {}); throw error;
  } finally { signal.removeEventListener('abort', abort); }
}
/** Checks completion/count only; integration tests must additionally unzip and validate CRC/hashes. */
export async function verifyZipEnvelope(path: string, expectedEntries: number) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat(); assert(size >= 22, 'PACKAGE_VALIDATION_FAILED', 'ZIP bị thiếu dữ liệu.', 422);
    const end = Buffer.alloc(22); await file.read(end, 0, 22, size - 22);
    assert(end.readUInt32LE(0) === 0x06054b50 && end.readUInt16LE(20) === 0, 'PACKAGE_VALIDATION_FAILED', 'ZIP chưa có footer hoàn chỉnh.', 422);
    let entries = BigInt(end.readUInt16LE(10));
    if (entries === 65535n) {
      const locator = Buffer.alloc(20); await file.read(locator, 0, 20, size - 42);
      assert(locator.readUInt32LE(0) === 0x07064b50, 'PACKAGE_VALIDATION_FAILED', 'Thiếu ZIP64 locator.', 422);
      const position = locator.readBigUInt64LE(8);
      assert(position <= BigInt(Number.MAX_SAFE_INTEGER) && position + 56n <= BigInt(size - 42), 'PACKAGE_VALIDATION_FAILED', 'ZIP64 offset không hợp lệ.', 422);
      const record = Buffer.alloc(56); await file.read(record, 0, 56, Number(position));
      assert(record.readUInt32LE(0) === 0x06064b50, 'PACKAGE_VALIDATION_FAILED', 'Thiếu ZIP64 record.', 422);
      entries = record.readBigUInt64LE(32);
    }
    assert(entries === BigInt(expectedEntries), 'PACKAGE_VALIDATION_FAILED', 'ZIP thiếu file đã chuẩn bị.', 422);
  } finally { await file.close(); }
}
