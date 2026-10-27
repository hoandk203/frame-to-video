import { PreviewSelections, type PreviewScheduling } from '../rendering/preview-selection.js';
import { MediaScheduler } from '../rendering/scheduler.js';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Config } from '../../../../packages/contracts/src/index.js';
import type { Workspace } from '../storage/workspace.js';
import type { Imports } from './imports.js';
import type { Engine } from '../media/engine.js';
import { capture } from '../media/process.js';
import { framePNG, renderFrame, RENDERER_VERSION } from '../rendering/renderer.js';
import { assert, asAppError, AppError } from '../errors.js';
import { audioArgs } from '../media/engine.js';
import { PreviewCache } from '../storage/preview-cache.js';
import { Quota } from '../storage/quota.js';

interface Preview {
  id: string;
  revision: number;
  status: 'pending' | 'ready' | 'failed';
  key: string;
  error?: ReturnType<ReturnType<typeof asAppError>['toJSON']>;
  kind: 'image' | 'audio';
  owner?: string;
}
export class Previews {
  private selections = new PreviewSelections();
  private audioSelections = new PreviewSelections();
  private cache: PreviewCache;
  private clearing = false;
  private requests = new Map<string, Preview>();
  private loading = 0;
  private waitingAdmission = 0;
  private admissionWaiters: (() => void)[] = [];
  private closing = false;
  private loadingWaiters: (() => void)[] = [];
  private pending = new Set<Promise<unknown>>();
  constructor(
    private ws: Workspace,
    private imports: Imports,
    private engine: Engine,
    private limits: Config['limits'],
    private scheduler = new MediaScheduler(),
    quota = new Quota(ws, limits),
  ) {
    this.cache = new PreviewCache(ws, quota, limits.previewMemoryBytes, limits.previewDiskBytes);
  }
  init() {
    return this.cache.init();
  }
  get cacheStats() {
    return {
      ...this.cache.stats,
      memoryLimit: this.limits.previewMemoryBytes,
      diskLimit: this.limits.previewDiskBytes,
    };
  }
  get(previewId: string) {
    const p = this.requests.get(previewId);
    assert(p, 'PREVIEW_NOT_FOUND', 'Không tìm thấy preview.', 404);
    return {
      id: p.id,
      revision: p.revision,
      status: p.status,
      error: p.error,
      imageUrl: p.kind === 'image' ? `/api/v1/previews/${p.id}` : undefined,
      mediaUrl: p.kind === 'audio' ? `/api/v1/audio-previews/${p.id}` : undefined,
    };
  }
  async acquire(previewId: string, kind: 'image' | 'audio') {
    const p = this.requests.get(previewId);
    assert(
      p?.status === 'ready' && p.kind === kind,
      'PREVIEW_NOT_READY',
      'Preview chưa sẵn sàng.',
      409,
    );
    const lease = await this.cache.acquire(p.key, kind === 'image' ? 'png' : 'm4a');
    assert(lease, 'PREVIEW_EXPIRED', 'Preview đã được thu hồi. Yêu cầu xem trước lại.', 410);
    return lease;
  }

  async request(
    projectId: string,
    revision: number,
    index: number,
    mode: 'interactive' | 'output-check',
    options?: PreviewScheduling,
  ) {
    const selection = options ? this.selections.begin(projectId, options) : undefined;
    return this.scopedRequest(selection, (handOff) =>
      this.createFrameRequest(
        projectId,
        revision,
        index,
        mode,
        selection,
        options?.intent ?? 'seek',
        handOff,
      ),
    );
  }
  private async scopedRequest<T>(
    selection: ReturnType<PreviewSelections['begin']> | undefined,
    work: (handOff: () => void) => Promise<T>,
  ) {
    let handedOff = false;
    let waiting = false;
    try {
      if (selection) {
        assert(
          this.waitingAdmission < 64,
          'MEDIA_QUEUE_FULL',
          'Quá nhiều yêu cầu preview mới. Thử lại sau.',
          503,
        );
        this.waitingAdmission++;
        waiting = true;
        // Let canceled queued work release admission slots before admitting its replacement.
        await new Promise<void>((resolve) => setImmediate(resolve));
        selection.signal.throwIfAborted();
        this.waitingAdmission--;
        waiting = false;
        if (!this.waitingAdmission) this.admissionWaiters.splice(0).forEach((resolve) => resolve());
      }
      return await this.admitted(() =>
        work(() => {
          handedOff = true;
        }),
      );
    } finally {
      if (waiting) {
        this.waitingAdmission--;
        if (!this.waitingAdmission) this.admissionWaiters.splice(0).forEach((resolve) => resolve());
      }
      if (!handedOff) selection?.release();
    }
  }

  cancel(projectId: string, clientId: string, sequence: number) {
    this.selections.cancel(projectId, clientId, sequence);
  }
  private async createFrameRequest(
    projectId: string,
    revision: number,
    index: number,
    mode: 'interactive' | 'output-check',
    selection: ReturnType<PreviewSelections['begin']> | undefined,
    priority: 'seek' | 'prefetch',
    handOff: () => void,
  ) {
    this.admit();
    const project = await this.ws.project(projectId);
    assert(project.revision === revision, 'REVISION_CONFLICT', 'Dự án đã thay đổi.', 409);
    selection?.signal.throwIfAborted();
    const video = project.video;
    const source = project.frames[index];
    assert(source, 'INVALID_FRAME', 'Frame không tồn tại.', 404);
    const release = this.imports.pin(source.assetId);
    const asset = await this.imports.asset(source.assetId).catch((error) => {
      release();
      throw error;
    });
    if (selection?.signal.aborted) {
      release();
      selection.signal.throwIfAborted();
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          hash: asset.sha256,
          video,
          mode,
          version: RENDERER_VERSION,
        }),
      )
      .digest('hex');
    const existing = [...this.requests.values()].find(
      (item) =>
        item.key === key &&
        item.revision === revision &&
        item.status === 'pending' &&
        item.owner === selection?.owner,
    );
    if (existing) {
      release();
      return this.get(existing.id);
    }
    try {
      this.admit();
    } catch (error) {
      release();
      throw error;
    }
    const request: Preview = {
      id: randomUUID(),
      revision,
      status: 'pending',
      key,
      kind: 'image',
      owner: selection?.owner,
    };
    this.requests.set(request.id, request);
    try {
      if (await this.cache.has(key, 'png')) {
        selection?.signal.throwIfAborted();
        request.status = 'ready';
        release();
        return this.get(request.id);
      }
    } catch (error) {
      release();
      this.requests.delete(request.id);
      throw error;
    }
    if (selection?.signal.aborted) {
      release();
      this.requests.delete(request.id);
      selection.signal.throwIfAborted();
    }
    const task = this.scheduler.run(
      async (signal) => {
        try {
          if (!(await this.cache.has(key, 'png'))) {
            const frame = await renderFrame(
              asset.path,
              video,
              this.limits.maxImagePixels,
              mode,
              signal,
            );
            await this.cache.put(key, await framePNG(frame), signal);
          }
          request.status = 'ready';
        } catch (error) {
          request.status = 'failed';
          request.error = asAppError(error).toJSON();
        } finally {
          release();
        }
      },
      { priority, signal: selection?.signal },
    );
    handOff();
    this.track(task, request, () => {
      release();
      selection?.release();
    });
    return this.get(request.id);
  }
  async audio(
    projectId: string,
    revision: number,
    options?: Pick<PreviewScheduling, 'clientId' | 'sequence'>,
  ) {
    const selection = options
      ? this.audioSelections.begin(projectId, { ...options, intent: 'seek' })
      : undefined;
    return this.scopedRequest(selection, (handOff) =>
      this.createAudioRequest(projectId, revision, selection, handOff),
    );
  }
  cancelAudio(projectId: string, clientId: string, sequence: number) {
    this.audioSelections.cancel(projectId, clientId, sequence);
  }
  private async createAudioRequest(
    projectId: string,
    revision: number,
    selection: ReturnType<PreviewSelections['begin']> | undefined,
    handOff: () => void,
  ) {
    this.admit();
    const project = await this.ws.project(projectId);
    assert(
      project.revision === revision &&
        project.audio &&
        project.audio.status !== 'missing' &&
        project.frames.length,
      'INVALID_AUDIO_PREVIEW',
      'Cấu hình preview nhạc chưa hợp lệ.',
      409,
    );
    selection?.signal.throwIfAborted();
    const release = this.imports.pin(project.audio.assetId);
    const asset = await this.imports.asset(project.audio.assetId).catch((error) => {
      release();
      throw error;
    });
    if (selection?.signal.aborted) {
      release();
      selection.signal.throwIfAborted();
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          audio: project.audio,
          count: project.frames.length,
          fps: project.video.fps,
          hash: asset.sha256,
        }),
      )
      .digest('hex');
    const existing = [...this.requests.values()].find(
      (item) =>
        item.key === key &&
        item.revision === revision &&
        item.status === 'pending' &&
        item.owner === selection?.owner,
    );
    if (existing) {
      release();
      return this.get(existing.id);
    }
    try {
      this.admit();
    } catch (error) {
      release();
      throw error;
    }
    const args = audioArgs(project, asset.path);
    const duration = (project.frames.length / project.video.fps).toFixed(9);
    const request: Preview = {
      id: randomUUID(),
      revision,
      status: 'pending',
      key,
      kind: 'audio',
      owner: selection?.owner,
    };
    this.requests.set(request.id, request);
    try {
      if (await this.cache.has(key, 'm4a')) {
        selection?.signal.throwIfAborted();
        request.status = 'ready';
        release();
        return this.get(request.id);
      }
    } catch (error) {
      release();
      this.requests.delete(request.id);
      throw error;
    }
    if (selection?.signal.aborted) {
      release();
      this.requests.delete(request.id);
      selection.signal.throwIfAborted();
    }
    const task = this.scheduler.run(
      async (signal) => {
        try {
          if (!(await this.cache.has(key, 'm4a'))) {
            const maxBytes = Math.ceil(Number(duration) * 30000) + 65536;
            await this.cache.generate(
              key,
              'm4a',
              maxBytes,
              async (temp) => {
                // Audio-only input is index 0 in this invocation.
                const output = args.output.map((arg) => arg.replace('[1:a:0]', '[0:a:0]'));
                await capture(
                  this.engine.ffmpeg,
                  [
                    '-y',
                    '-v',
                    'error',
                    ...args.input,
                    ...output,
                    '-vn',
                    '-t',
                    duration,
                    '-fs',
                    String(maxBytes + 1),
                    '-f',
                    'ipod',
                    temp,
                  ],
                  60000,
                  signal,
                );
                const probe = await this.engine.probe(temp, false, signal);
                const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
                assert(
                  audio?.codec_name === 'aac' &&
                    audio.sample_rate === '48000' &&
                    audio.channels === 2 &&
                    Math.abs(Number(probe.format.duration) - Number(duration)) <=
                      1024 / 48000 + 0.01,
                  'AUDIO_PREVIEW_INVALID',
                  'Audio preview không đúng cấu hình hoặc bị cắt ngắn.',
                  422,
                );
              },
              signal,
            );
          }
          request.status = 'ready';
        } catch (error) {
          request.status = 'failed';
          request.error = asAppError(error).toJSON();
        } finally {
          release();
        }
      },
      { priority: 'seek', signal: selection?.signal },
    );
    handOff();
    this.track(task, request, () => {
      release();
      selection?.release();
    });
    return this.get(request.id);
  }
  thumbnail(assetId: string) {
    return this.admitted(async () => {
      const release = this.imports.pin(assetId);
      try {
        const asset = await this.imports.asset(assetId);
        assert(asset.kind === 'frames', 'INVALID_ASSET', 'Nguồn không phải ảnh.', 422);
        const key = createHash('sha256')
          .update(
            JSON.stringify({
              hash: asset.sha256,
              target: 'thumbnail-96-cover',
              version: RENDERER_VERSION,
            }),
          )
          .digest('hex');
        let lease = await this.cache.acquire(key, 'png');
        if (lease) return lease;
        await this.scheduler.run(
          async (signal) => {
            if (!(await this.cache.has(key, 'png'))) {
              const data = await sharp(asset.path, { limitInputPixels: this.limits.maxImagePixels })
                .autoOrient()
                .resize(96, 96, { fit: 'cover' })
                .png()
                .toBuffer();
              signal.throwIfAborted();
              await this.cache.put(key, data, signal);
            }
          },
          { priority: 'thumbnail' },
        );
        lease = await this.cache.acquire(key, 'png');
        assert(lease, 'PREVIEW_EXPIRED', 'Thumbnail đã được thu hồi. Thử lại sau.', 410);
        return lease;
      } finally {
        release();
      }
    });
  }
  private async admitted<T>(work: () => Promise<T>): Promise<T> {
    assert(!this.closing, 'APP_STOPPING', 'Preview đang dừng.', 409);
    assert(!this.clearing, 'PREVIEW_CACHE_BUSY', 'Đang xóa cache. Thử lại sau.', 409);
    assert(
      this.pending.size + this.loading < 64,
      'MEDIA_QUEUE_FULL',
      'Hàng đợi preview đã đầy. Thử lại sau.',
      503,
    );
    this.loading++;
    try {
      return await work();
    } finally {
      this.loading--;
      if (!this.loading) this.loadingWaiters.splice(0).forEach((resolve) => resolve());
    }
  }
  private admit() {
    if (this.pending.size >= 64)
      throw new AppError('MEDIA_QUEUE_FULL', 'Hàng đợi preview đã đầy. Thử lại sau.', 503, true);
    // Terminal request metadata is bounded independently of disk cache ownership.
    for (const [id, request] of this.requests) {
      if (this.requests.size < 2048) break;
      if (request.status !== 'pending') this.requests.delete(id);
    }
    assert(this.requests.size < 2048, 'MEDIA_QUEUE_FULL', 'Quá nhiều preview đang chờ.', 503);
  }
  private track(task: Promise<unknown>, request: Preview, release: () => void) {
    const tracked = task
      .catch((error) => {
        request.status = 'failed';
        request.error = asAppError(error).toJSON();
      })
      .finally(() => {
        release();
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }
  async clearCache() {
    assert(!this.clearing && !this.closing, 'PREVIEW_CACHE_BUSY', 'Cache đang bận.', 409);
    assert(
      !this.scheduler.stats.previewPaused || (!this.pending.size && !this.loading),
      'PREVIEW_CACHE_BUSY',
      'Preview đang chờ tác vụ xuất. Thử xóa cache sau.',
      409,
    );
    this.clearing = true;
    try {
      await this.idle();
      await this.cache.clear();
    } finally {
      this.clearing = false;
    }
  }
  async shutdown() {
    this.closing = true;
    this.selections.shutdown();
    this.audioSelections.shutdown();
    await this.idle();
  }
  async idle() {
    if (this.waitingAdmission)
      await new Promise<void>((resolve) => this.admissionWaiters.push(resolve));
    if (this.loading) await new Promise<void>((resolve) => this.loadingWaiters.push(resolve));
    await Promise.allSettled([...this.pending]);
  }
}
