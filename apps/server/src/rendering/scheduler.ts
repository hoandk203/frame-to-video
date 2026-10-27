import { AppError } from '../errors.js';

export type MediaPriority = 'export' | 'seek' | 'prefetch' | 'thumbnail';
const rank: Record<MediaPriority, number> = { export: 0, seek: 1, prefetch: 2, thumbnail: 3 };
export interface Scheduled<T> {
  promise: Promise<T>;
  signal: AbortSignal;
  cancel: (reason?: Error) => void;
}
interface Entry {
  priority: MediaPriority;
  scope?: string;
  controller: AbortController;
  state: 'queued' | 'running' | 'done';
  work: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}
export class MediaScheduler {
  private queue: Entry[] = [];
  private active: Entry | null = null;
  private exports = 0;
  private stopped = false;
  private waiters: (() => void)[] = [];
  constructor(private maxPending = 64) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1)
      throw new RangeError('maxPending must be a positive integer');
  }
  get stats() {
    return {
      queued: this.queue.length,
      running: this.active ? 1 : 0,
      previewPaused: this.exports > 0,
    };
  }
  beginExport() {
    this.exports++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.exports--;
      this.pump();
    };
  }
  schedule<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: { priority?: MediaPriority; signal?: AbortSignal; replaceScope?: string } = {},
  ): Scheduled<T> {
    const controller = new AbortController();
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(() => {});
    const entry: Entry = {
      priority: options.priority ?? 'seek',
      scope: options.replaceScope,
      controller,
      state: 'queued',
      work,
      resolve: (value) => resolve(value as T),
      reject,
      detach: () => {},
    };
    const cancel = (
      reason: Error = new AppError('MEDIA_CANCELED', 'Tác vụ media đã hủy.', 409, true),
    ) => {
      if (entry.state === 'done') return;
      controller.abort(reason);
      if (entry.state === 'queued') {
        this.queue = this.queue.filter((item) => item !== entry);
        entry.state = 'done';
        entry.detach();
        reject(reason);
        this.pump();
      }
      // A running task retains its lease until native work actually settles.
    };
    const abort = () =>
      cancel(options.signal?.reason instanceof Error ? options.signal.reason : undefined);
    entry.detach = () => options.signal?.removeEventListener('abort', abort);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (this.stopped) cancel(new AppError('APP_STOPPING', 'Hàng đợi media đã dừng.', 409));
    else if (options.signal?.aborted) abort();
    else {
      if (entry.scope) {
        for (const old of [...this.queue, ...(this.active ? [this.active] : [])])
          if (old.scope === entry.scope) {
            old.controller.abort(
              new AppError(
                'PREVIEW_SUPERSEDED',
                'Preview đã được thay bằng vị trí mới.',
                409,
                true,
              ),
            );
            if (old.state === 'queued') {
              this.queue = this.queue.filter((item) => item !== old);
              old.state = 'done';
              old.detach();
              old.reject(old.controller.signal.reason);
            }
          }
      }
      if (this.queue.length >= this.maxPending && entry.priority === 'export') {
        const dropped = [...this.queue].reverse().find((item) => item.priority !== 'export');
        if (dropped) {
          this.queue = this.queue.filter((item) => item !== dropped);
          dropped.state = 'done';
          dropped.detach();
          dropped.controller.abort(
            new AppError(
              'PREVIEW_DEFERRED',
              'Ưu tiên tác vụ xuất. Thử lại preview sau.',
              503,
              true,
            ),
          );
          dropped.reject(dropped.controller.signal.reason);
        }
      }
      if (this.queue.length >= this.maxPending)
        cancel(new AppError('MEDIA_QUEUE_FULL', 'Hàng đợi media đã đầy. Thử lại sau.', 503, true));
      else {
        this.queue.push(entry);
        this.pump();
      }
    }
    return { promise, signal: controller.signal, cancel };
  }
  run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: { priority?: MediaPriority; signal?: AbortSignal } = {},
  ) {
    return this.schedule(work, options).promise;
  }
  private pump() {
    if (this.active) return;
    const allowed = this.queue.filter((entry) => entry.priority === 'export' || this.exports === 0);
    const next = allowed.sort((a, b) => rank[a.priority] - rank[b.priority])[0];
    if (!next) {
      if (!this.queue.length) this.waiters.splice(0).forEach((resolve) => resolve());
      return;
    }
    this.queue = this.queue.filter((entry) => entry !== next);
    next.state = 'running';
    this.active = next;
    queueMicrotask(() => {
      void (async () => {
        try {
          next.controller.signal.throwIfAborted();
          const value = await next.work(next.controller.signal);
          next.controller.signal.throwIfAborted();
          next.resolve(value);
        } catch (error) {
          next.reject(error);
        } finally {
          next.state = 'done';
          next.detach();
          this.active = null;
          this.pump();
        }
      })();
    });
  }
  async idle() {
    if (!this.active && !this.queue.length) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  async shutdown() {
    this.stopped = true;
    for (const entry of this.queue.splice(0)) {
      entry.state = 'done';
      entry.detach();
      entry.controller.abort(new AppError('APP_STOPPING', 'Ứng dụng đang dừng.', 409));
      entry.reject(entry.controller.signal.reason);
    }
    this.active?.controller.abort(new AppError('APP_STOPPING', 'Ứng dụng đang dừng.', 409));
    this.pump();
    await this.idle();
  }
}
