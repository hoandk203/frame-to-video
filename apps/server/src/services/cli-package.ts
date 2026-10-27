import { MediaScheduler } from '../rendering/scheduler.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import type { Workspace } from '../storage/workspace.js';
import type { Imports } from './imports.js';
import type { Quota } from '../storage/quota.js';
import { framePNG, renderFrame, RENDERER_VERSION } from '../rendering/renderer.js';
import { preparedEncoderArgs } from '../media/engine.js';
import {
  dimensions,
  id,
  type Config,
  type Project,
} from '../../../../packages/contracts/src/index.js';
import { assert } from '../errors.js';

export interface PackageEntry {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}
export interface PreparedPackage {
  jobId: string;
  directory: string;
  reservationKey: string;
  entries: PackageEntry[];
  stageBytes: number;
}
export interface PackageManifest {
  format: 'frame-to-video-studio-cli';
  schemaVersion: 1;
  rendererVersion: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  durationUs: number;
  frames: { index: number; name: string; sourceSha256: string; renderedSha256: string }[];
  audio: { name: string; sha256: string; volume: number; shortTrackPolicy: string } | null;
  encoding: Project['video']['encoding'];
}
export function packageEstimate(project: Project) {
  const { width, height } = dimensions(project.video);
  const rawFrameBytes = width * height * 4;
  return {
    frameCount: project.frames.length,
    rawFrameBytes,
    rawSequenceBytes: rawFrameBytes * project.frames.length,
    approximate: true,
    note: 'PNG và ZIP phụ thuộc nội dung. Workspace phải đủ chỗ cho cả frame trung gian và ZIP; quota được kiểm tra theo từng file.',
  };
}
export function windowsEncodeScript(project: Project) {
  const args = preparedEncoderArgs(
    project,
    'output.mp4',
    project.audio ? 'audio.source' : undefined,
  );
  // Batch files expand %0..%9; the image2 placeholder must be doubled in .cmd.
  const quote = (arg: string) => `"${arg.replaceAll('%', '%%')}"`;
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'pushd "%~dp0" || exit /b 1',
    'if exist "output.mp4" (',
    '  echo output.mp4 already exists. Rename or remove it before encoding.',
    '  popd',
    '  exit /b 2',
    ')',
    'ffmpeg -version >nul 2>&1',
    'if errorlevel 1 (',
    '  echo FFmpeg is required on PATH.',
    '  popd',
    '  exit /b 3',
    ')',
    `ffmpeg ${args.map(quote).join(' ')}`,
    'set "FTVS_ENCODE_EXIT=%ERRORLEVEL%"',
    'popd',
    'exit /b %FTVS_ENCODE_EXIT%',
    '',
  ].join('\r\n');
}
export class CliPackageBuilder {
  constructor(
    private ws: Workspace,
    private imports: Imports,
    private quota: Quota,
    private limits: Config['limits'],
    private scheduler = new MediaScheduler(),
  ) {}
  async prepare(
    project: Project,
    jobId: string,
    signal: AbortSignal,
    progress: (frames: number) => Promise<void> = async () => {},
  ) {
    id.parse(jobId);
    assert(
      project.frames.length &&
        project.frames.every((frame) => frame.status === 'valid') &&
        project.audio?.status !== 'missing',
      'SOURCE_MISSING',
      'Gói CLI cần đủ nguồn hợp lệ.',
      422,
    );
    const reservationKey = `cli:${jobId}`,
      directory = this.ws.path('packages', jobId, 'staging');
    const entries: PackageEntry[] = [];
    await this.quota.reserve(reservationKey, 65536 + project.frames.length * 512);
    let stageBytes = 0;
    let createdRoot = false;
    let remainingZipBytes = 65536 + project.frames.length * 512;
    const reserveFile = async (bytes: number) => {
      const archiveBytes = bytes + Math.ceil(bytes * 0.002) + 512;
      await this.quota.ensure(reservationKey, remainingZipBytes + bytes + archiveBytes);
      remainingZipBytes += archiveBytes;
    };
    const save = async (name: string, data: Buffer) => {
      signal.throwIfAborted();
      const path = this.ws.path('packages', jobId, 'staging', name);
      // Account for staging and a future copy in ZIP, including deflate/header growth.
      await reserveFile(data.length);
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.quota.consumed(reservationKey, data.length);
      stageBytes += data.length;
      const entry = {
        name,
        path,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
      entries.push(entry);
      return entry;
    };
    try {
      // Never merge with files from an earlier attempt.
      await mkdir(this.ws.path('packages', jobId), { recursive: false });
      createdRoot = true;
      await mkdir(directory, { recursive: false });
      await mkdir(this.ws.path('packages', jobId, 'staging', 'frames'));
      const { width, height } = dimensions(project.video);
      const manifest: PackageManifest = {
        format: 'frame-to-video-studio-cli',
        schemaVersion: 1,
        rendererVersion: RENDERER_VERSION,
        frameCount: project.frames.length,
        fps: project.video.fps,
        width,
        height,
        durationUs: Math.round((project.frames.length / project.video.fps) * 1e6),
        frames: [],
        audio: null,
        encoding: project.video.encoding,
      };
      for (let index = 0; index < project.frames.length; index++) {
        signal.throwIfAborted();
        const source = project.frames[index]!;
        const release = this.imports.pin(source.assetId);
        try {
          const asset = await this.imports.asset(source.assetId, true);
          assert(asset.sha256 === source.sha256, 'SOURCE_CHANGED', 'Nguồn ảnh đã thay đổi.', 422);
          const frame = await this.scheduler.run(
            (renderSignal) =>
              renderFrame(
                asset.path,
                project.video,
                this.limits.maxImagePixels,
                'output-check',
                renderSignal,
              ),
            { priority: 'export', signal },
          );
          const entry = await save(
            `frames/frame_${String(index).padStart(8, '0')}.png`,
            await framePNG(frame),
          );
          manifest.frames.push({
            index,
            name: entry.name,
            sourceSha256: asset.sha256,
            renderedSha256: entry.sha256,
          });
        } finally {
          release();
        }
        await progress(index + 1);
      }
      if (project.audio) {
        signal.throwIfAborted();
        const release = this.imports.pin(project.audio.assetId);
        try {
          const asset = await this.imports.asset(project.audio.assetId, true);
          await reserveFile(asset.fileSize);
          const path = this.ws.path('packages', jobId, 'staging', 'audio.source');
          const handle = await open(path, 'wx', 0o600);
          const hash = createHash('sha256');
          let bytes = 0;
          try {
            for await (const chunk of createReadStream(asset.path, { signal })) {
              signal.throwIfAborted();
              hash.update(chunk);
              await handle.writeFile(chunk);
              bytes += chunk.length;
              this.quota.consumed(reservationKey, chunk.length);
            }
            await handle.sync();
          } finally {
            await handle.close();
          }
          const sha256 = hash.digest('hex');
          assert(
            bytes === asset.fileSize && sha256 === asset.sha256,
            'SOURCE_CHANGED',
            'Nhạc bị thay đổi trong lúc copy.',
            422,
          );
          entries.push({ name: 'audio.source', path, bytes, sha256 });
          stageBytes += bytes;
          manifest.audio = {
            name: 'audio.source',
            sha256,
            volume: project.audio.volume,
            shortTrackPolicy: project.audio.shortTrackPolicy,
          };
        } finally {
          release();
        }
      }
      await save('encode.cmd', Buffer.from(windowsEncodeScript(project), 'utf8'));
      await save('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
      await save(
        'README.txt',
        Buffer.from(
          [
            'FRAME TO VIDEO STUDIO - PREPARED CLI PACKAGE',
            '',
            'Extract the whole ZIP to a local folder. Keep frames/, audio.source (if any), and encode.cmd together.',
            'Install a compatible FFmpeg with libx264/AAC on PATH on the machine that runs encode.cmd.',
            'Double-click encode.cmd to create output.mp4. Existing output.mp4 is never overwritten.',
            'Frames are already composed by the application renderer. Do not apply background blur again.',
            `Frames: ${project.frames.length}; FPS: ${project.video.fps}; size: ${width}x${height}.`,
            'manifest.json records source/rendered SHA-256 hashes, order, audio policy and encoder settings.',
            'This package is independent of the original image/audio paths. FFmpeg itself is not included.',
            '',
          ].join('\r\n'),
          'utf8',
        ),
      );
      return { jobId, directory, reservationKey, entries, stageBytes } satisfies PreparedPackage;
    } catch (error) {
      try {
        if (createdRoot)
          await rm(this.ws.path('packages', jobId), { recursive: true, force: true });
      } finally {
        this.quota.release(reservationKey);
      }
      throw error;
    }
  }
  async cleanup(prepared: PreparedPackage) {
    assert(
      prepared.reservationKey === `cli:${id.parse(prepared.jobId)}`,
      'INVALID_PACKAGE',
      'Gói CLI không hợp lệ.',
      500,
    );
    try {
      await rm(this.ws.path('packages', prepared.jobId), { recursive: true, force: true });
    } finally {
      this.quota.release(prepared.reservationKey);
    }
  }
}
