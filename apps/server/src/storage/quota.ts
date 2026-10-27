import { statfs } from 'node:fs/promises';
import type { Config } from '../../../../packages/contracts/src/index.js';
import { assert } from '../errors.js';
import type { Workspace } from './workspace.js';

export class Quota {
  private reserved = new Map<string, number>();
  constructor(
    private ws: Workspace,
    private limits: Config['limits'],
  ) {}
  async reserve(key: string, bytes: number) {
    assert(Number.isSafeInteger(bytes) && bytes >= 0, 'INVALID_RESERVATION', 'Dung lượng reservation không hợp lệ.');
    return this.ws.writer.run(async () => {
      assert(!this.reserved.has(key), 'RESERVATION_EXISTS', 'Reservation đã tồn tại', 409);
      const [usage, disk] = await Promise.all([this.ws.diskUsage(), statfs(this.ws.root)]);
      const reserved = [...this.reserved.values()].reduce((a, b) => a + b, 0);
      const free = disk.bavail * disk.bsize;
      assert(
        usage + reserved + bytes <= this.limits.workspaceQuotaBytes,
        'UPLOAD_LIMIT_EXCEEDED',
        'Vượt quota workspace.',
        507,
      );
      assert(
        free - reserved - bytes >= this.limits.minFreeDiskBytes,
        'DISK_FULL',
        'Không đủ dung lượng trống dự phòng.',
        507,
      );
      this.reserved.set(key, bytes);
    });
  }
  /** Batch reservation avoids a full directory scan for every small prepared frame. */
  async ensure(key: string, minimum: number, batchBytes = 64 * 1024 * 1024) {
    assert(Number.isSafeInteger(minimum) && minimum >= 0 && Number.isSafeInteger(batchBytes) && batchBytes >= 0,
      'INVALID_RESERVATION', 'Dung lượng reservation không hợp lệ.');
    const current = this.reserved.get(key);
    assert(current !== undefined, 'RESERVATION_MISSING', 'Không có reservation cho tác vụ.', 409);
    if (current >= minimum) return;
    await this.ws.writer.run(async () => {
      const remaining = this.reserved.get(key);
      assert(remaining !== undefined, 'RESERVATION_MISSING', 'Reservation đã được thu hồi.', 409);
      if (remaining >= minimum) return;
      const info = await this.info(), needed = minimum - remaining;
      const available = Math.floor(Math.min(info.quota - info.usage - info.reserved, info.free - info.reserved - info.minFree));
      assert(available >= needed, 'UPLOAD_LIMIT_EXCEEDED', 'Không đủ quota cho frame trung gian và ZIP.', 507);
      this.reserved.set(key, remaining + Math.min(available, Math.max(needed, batchBytes)));
    });
  }
  consumed(key: string, bytes: number) {
    assert(Number.isSafeInteger(bytes) && bytes >= 0, 'INVALID_RESERVATION', 'Dung lượng tiêu thụ không hợp lệ.');
    const remaining = this.reserved.get(key);
    if (remaining !== undefined) this.reserved.set(key, Math.max(0, remaining - bytes));
  }
  release(key: string) {
    this.reserved.delete(key);
  }
  async info() {
    const [usage, disk] = await Promise.all([this.ws.diskUsage(), statfs(this.ws.root)]);
    const reserved = [...this.reserved.values()].reduce((sum, bytes) => sum + bytes, 0);
    return {
      usage,
      quota: this.limits.workspaceQuotaBytes,
      free: disk.bavail * disk.bsize,
      reserved,
      minFree: this.limits.minFreeDiskBytes,
    };
  }
  async check() {
    const info = await this.info();
    assert(
      info.usage + info.reserved < info.quota && info.free - info.reserved > info.minFree,
      'DISK_FULL',
      'Quota hoặc dung lượng trống không đủ để tiếp tục.',
      507,
    );
    return info;
  }
}
