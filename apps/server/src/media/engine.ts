import type { Project } from '../../../../packages/contracts/src/index.js';
import { dimensions } from '../../../../packages/contracts/src/index.js';
import { capture } from './process.js';
import { AppError, assert } from '../errors.js';

export interface ProbeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  nb_read_frames?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}
export interface Probe {
  streams: ProbeStream[];
  format: { duration?: string; size?: string };
}
export class Engine {
  constructor(
    public ffmpeg: string,
    public ffprobe: string,
  ) {}
  async status() {
    try {
      const [version, probe, encoders] = await Promise.all([
        capture(this.ffmpeg, ['-version']),
        capture(this.ffprobe, ['-version']),
        capture(this.ffmpeg, ['-hide_banner', '-encoders']),
      ]);
      assert(
        /\blibx264\b/.test(encoders.stdout) && /\baac\b/.test(encoders.stdout),
        'ENCODER_UNAVAILABLE',
        'Engine thiếu encoder libx264/AAC.',
        503,
      );
      return {
        ready: true,
        version: version.stdout.split('\n')[0],
        probeVersion: probe.stdout.split('\n')[0],
        error: null,
      };
    } catch (error) {
      return {
        ready: false,
        version: null,
        probeVersion: null,
        error:
          error instanceof AppError
            ? error.toJSON()
            : { code: 'ENGINE_UNAVAILABLE', message: String(error) },
      };
    }
  }
  async probe(path: string, countFrames = false, signal?: AbortSignal): Promise<Probe> {
    const { stdout } = await capture(
      this.ffprobe,
      [
        '-v',
        'error',
        ...(countFrames ? ['-count_frames'] : []),
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path,
      ],
      60000,
      signal,
    );
    const parsed = JSON.parse(stdout) as Probe;
    assert(
      Array.isArray(parsed.streams),
      'MEDIA_PROBE_FAILED',
      'Metadata media không hợp lệ.',
      422,
    );
    return parsed;
  }
  async validateAudio(path: string) {
    const probe = await this.probe(path);
    const stream = probe.streams.find((s) => s.codec_type === 'audio');
    const duration = Number(probe.format.duration || stream?.duration);
    assert(
      stream && Number.isFinite(duration) && duration > 0,
      'AUDIO_DECODE_FAILED',
      'File nhạc không có audio hữu hạn hợp lệ.',
      422,
    );
    await capture(
      this.ffmpeg,
      ['-v', 'error', '-i', path, '-map', '0:a:0', '-f', 'null', '-'],
      60000,
    );
    return { durationUs: Math.round(duration * 1000000) };
  }
  async verify(path: string, project: Project, signal?: AbortSignal) {
    const probe = await this.probe(path, true, signal),
      { width, height } = dimensions(project.video);
    const video = probe.streams.find((s) => s.codec_type === 'video');
    const audio = probe.streams.filter((s) => s.codec_type === 'audio');
    const [num, den] = (video?.avg_frame_rate ?? '0/1').split('/').map(Number);
    const targetDuration = project.frames.length / project.video.fps;
    const tolerance = Math.max(1 / project.video.fps, 1024 / 48000) + 0.01;
    assert(
      video?.codec_name === 'h264' &&
        video.width === width &&
        video.height === height &&
        video.pix_fmt === 'yuv420p' &&
        Number(video.nb_read_frames) === project.frames.length &&
        num! / den! === project.video.fps,
      'OUTPUT_VALIDATION_FAILED',
      'Video không đúng codec, kích thước, FPS hoặc số frame.',
      422,
    );
    assert(
      Math.abs(Number(probe.format.duration) - targetDuration) <= tolerance,
      'OUTPUT_VALIDATION_FAILED',
      'Thời lượng video ngoài sai số cho phép.',
      422,
    );
    assert(
      project.audio
        ? audio.length === 1 &&
            audio[0]!.codec_name === 'aac' &&
            audio[0]!.sample_rate === '48000' &&
            audio[0]!.channels === 2
        : audio.length === 0,
      'OUTPUT_VALIDATION_FAILED',
      'Audio đầu ra không đúng cấu hình.',
      422,
    );
    if (project.audio)
      assert(
        Math.abs(Number(audio[0]!.duration) - targetDuration) <= tolerance,
        'OUTPUT_VALIDATION_FAILED',
        'Audio bị thiếu hoặc quá dài.',
        422,
      );
    return probe;
  }
}
export function audioArgs(
  project: Project,
  audioPath?: string,
): { input: string[]; output: string[] } {
  if (!project.audio) return { input: [], output: ['-an'] };
  assert(audioPath, 'SOURCE_MISSING', 'Không tìm thấy file nhạc.', 422);
  const audio = project.audio,
    duration = (project.frames.length / project.video.fps).toFixed(9);
  const input = [
    ...(audio.shortTrackPolicy === 'loop' ? ['-stream_loop', '-1'] : []),
    '-i',
    audioPath,
  ];
  const filter = `[1:a:0]asetpts=PTS-STARTPTS,aresample=48000,volume=${audio.volume},${audio.shortTrackPolicy === 'pad-silence' ? 'apad,' : ''}atrim=duration=${duration}[a]`;
  return {
    input,
    output: [
      '-filter_complex',
      filter,
      '-map',
      '[a]',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
    ],
  };
}
export function encoderArgs(project: Project, output: string, audioPath?: string) {
  const { width, height } = dimensions(project.video),
    audio = audioArgs(project, audioPath);
  return [
    '-hide_banner',
    '-nostats',
    '-progress',
    'pipe:1',
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgba',
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    String(project.video.fps),
    '-i',
    'pipe:0',
    ...audio.input,
    '-map',
    '0:v:0',
    ...audio.output,
    '-vf',
    'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    project.video.encoding.preset,
    '-crf',
    String(project.video.encoding.crf),
    '-color_range',
    'tv',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-frames:v',
    String(project.frames.length),
    '-t',
    (project.frames.length / project.video.fps).toFixed(9),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ];
}

/** Prepared frames already contain composition; no background filter is repeated. */
export function preparedEncoderArgs(project: Project, output = 'output.mp4', audioPath?: string) {
  const args = encoderArgs(project, output, audioPath);
  const start = args.indexOf('-f');
  const input = args.indexOf('pipe:0');
  args.splice(start, input - start + 1, '-framerate', String(project.video.fps), '-start_number', '0', '-i', 'frames/frame_%08d.png');
  return args;
}
