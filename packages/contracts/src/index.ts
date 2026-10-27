import { z } from 'zod';

export const id = z.string().uuid();
export const videoSchema = z
  .object({
    aspectRatio: z.enum(['16:9', '9:16']).default('16:9'),
    resolution: z.enum(['720p', '1080p', '4k']).default('1080p'),
    fps: z.union([z.literal(12), z.literal(24), z.literal(30), z.literal(60)]).default(24),
    background: z
      .object({
        mode: z.enum(['blur', 'solid']).default('blur'),
        blurStrength: z.number().min(0).max(30).default(15),
        brightness: z.number().min(0).max(1).default(0.6),
        matteColor: z
          .string()
          .regex(/^#[\da-f]{6}$/i)
          .default('#000000'),
      })
      .strict()
      .default({}),
    encoding: z
      .object({
        container: z.literal('mp4').default('mp4'),
        codec: z.literal('h264').default('h264'),
        crf: z.number().int().min(18).max(28).default(23),
        preset: z.enum(['fast', 'medium']).default('medium'),
        pixelFormat: z.literal('yuv420p').default('yuv420p'),
      })
      .strict()
      .default({}),
  })
  .strict();
export type VideoSettings = z.infer<typeof videoSchema>;
export const audioSchema = z
  .object({
    assetId: id,
    durationUs: z.number().int().positive(),
    volume: z.number().min(0).max(2).default(1),
    shortTrackPolicy: z.enum(['pad-silence', 'loop']).default('pad-silence'),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    originalName: z.string().min(1).max(255).optional(),
    status: z.enum(['valid', 'missing']).optional(),
  })
  .strict();
export type AudioSettings = z.infer<typeof audioSchema>;
export const frameSchema = z
  .object({
    id,
    assetId: id,
    originalName: z.string(),
    relativePath: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileSize: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.enum(['png', 'jpeg', 'webp']),
    orientation: z.number().int().min(1).max(8),
    status: z.enum(['pending', 'valid', 'missing', 'invalid']),
  })
  .strict();
export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().trim().min(1).max(120),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    frames: z.array(frameSchema),
    video: videoSchema,
    audio: audioSchema.nullable(),
    lastImportId: id.optional(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;
export type FrameSource = z.infer<typeof frameSchema>;
export const limitsSchema = z
  .object({
    maxFrames: z.number().int().min(1).max(100000).default(20000),
    maxImagePixels: z.number().int().positive().max(200000000).default(100000000),
    maxFileBytes: z.number().int().positive().default(536870912),
    maxImportBytes: z.number().int().positive().default(21474836480),
    workspaceQuotaBytes: z.number().int().positive().default(53687091200),
    minFreeDiskBytes: z.number().int().nonnegative().default(2147483648),
    uploadConcurrency: z.number().int().min(1).max(4).default(2),
    uploadTtlHours: z.number().min(1).max(168).default(24),
    renderWorkers: z.literal(1).default(1),
    previewMemoryBytes: z.number().int().nonnegative().default(134217728),
    previewDiskBytes: z.number().int().nonnegative().default(1073741824),
  })
  .strict();
export const configSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    port: z.number().int().min(1024).max(65535).default(3000),
    dataDir: z.string().min(1).default('data'),
    limits: limitsSchema.default({}),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export const safeRelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.includes('\0') &&
      !p.includes('\\') &&
      !p.startsWith('/') &&
      !p.includes(':') &&
      p.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
    'Đường dẫn không hợp lệ',
  );
export const importSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    purpose: z.enum(['frames', 'audio']),
    mode: z.enum(['replace', 'append', 'relink']),
    files: z
      .array(
        z
          .object({
            clientFileId: id,
            name: z.string().min(1).max(255),
            relativePath: safeRelativePath,
            size: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(20000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.purpose === 'audio' && (v.files.length !== 1 || v.mode === 'append'))
      ctx.addIssue({
        code: 'custom',
        message: 'Nhạc phải là một file, chế độ thay thế hoặc liên kết lại',
      });
    if (new Set(v.files.map((f) => f.clientFileId)).size !== v.files.length)
      ctx.addIssue({ code: 'custom', message: 'clientFileId bị trùng' });
    if (new Set(v.files.map((f) => f.relativePath)).size !== v.files.length)
      ctx.addIssue({ code: 'custom', message: 'Đường dẫn tương đối bị trùng' });
  });
export type ImportInput = z.infer<typeof importSchema>;
export const projectConfigSchema = z
  .object({
    format: z.literal('frame-to-video-studio'),
    schemaVersion: z.literal(1),
    project: projectSchema,
    sources: z
      .array(
        z
          .object({
            assetId: id,
            kind: z.enum(['frames', 'audio']),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(20001),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
const safeCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const jobStatusSchema = z.enum([
  'validating',
  'preparing',
  'encoding',
  'finalizing',
  'completed',
  'failed',
  'canceling',
  'canceled',
  'interrupted',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const appErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    sourceId: z.string().optional(),
    diagnosticId: z.string().optional(),
  })
  .strict();
export type AppErrorData = z.infer<typeof appErrorSchema>;
export const exportJobSchema = z
  .object({
    id,
    projectId: id,
    projectRevision: safeCounter.refine((value) => value > 0),
    kind: z.enum(['video', 'cli']),
    status: jobStatusSchema,
    processedFrames: safeCounter,
    encodedFrames: safeCounter,
    totalFrames: safeCounter.refine((value) => value > 0),
    percent: z.number().int().min(0).max(100),
    sequence: safeCounter,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    elapsedMs: safeCounter,
    speedFps: z.number().finite().positive().nullable(),
    etaMs: safeCounter.nullable(),
    fileName: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\\/\x00-\x1f<>:"|?*]+$/),
    result: z
      .object({
        bytes: safeCounter.refine((value) => value > 0),
        durationUs: safeCounter.refine((value) => value > 0),
        mime: z.enum(['video/mp4', 'application/zip']),
      })
      .strict()
      .nullable(),
    error: appErrorSchema.nullable(),
  })
  .strict()
  .superRefine((job, context) => {
    const expected = job.kind === 'cli' ? 'application/zip' : 'video/mp4';
    if (
      job.processedFrames > job.totalFrames ||
      job.encodedFrames > job.totalFrames ||
      (job.kind === 'video' ? !/\.mp4$/i.test(job.fileName) : !/\.zip$/i.test(job.fileName)) ||
      (job.result && (job.status !== 'completed' || job.result.mime !== expected)) ||
      (job.status === 'completed' &&
        (job.percent !== 100 ||
          job.processedFrames !== job.totalFrames ||
          job.encodedFrames !== job.totalFrames))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Trạng thái/kết quả tác vụ không nhất quán.',
      });
  });
export type ExportJob = z.infer<typeof exportJobSchema>;
export function dimensions(video: Pick<VideoSettings, 'aspectRatio' | 'resolution'>) {
  const sizes = { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] } as const;
  const [w, h] = sizes[video.resolution];
  return video.aspectRatio === '16:9' ? { width: w, height: h } : { width: h, height: w };
}
export function naturalCompare(a: string, b: string): number {
  const aa =
    a
      .normalize('NFC')
      .toLowerCase()
      .match(/\d+|\D+/g) ?? [];
  const bb =
    b
      .normalize('NFC')
      .toLowerCase()
      .match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const x = aa[i]!,
      y = bb[i]!;
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const n = BigInt(x),
        m = BigInt(y);
      if (n !== m) return n < m ? -1 : 1;
    } else return x < y ? -1 : 1;
  }
  return aa.length - bb.length || (a < b ? -1 : a > b ? 1 : 0);
}

const previewSequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const previewRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    frameIndex: z.number().int().nonnegative(),
    mode: z.enum(['interactive', 'output-check']),
    clientId: id.optional(),
    sequence: previewSequence.optional(),
    intent: z.enum(['seek', 'prefetch']).default('seek'),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Boolean(value.clientId) !== (value.sequence !== undefined) ||
      (value.intent === 'prefetch' && !value.clientId)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientId và sequence phải đi cùng nhau; prefetch yêu cầu cả hai.',
      });
    if (value.intent === 'prefetch' && value.mode === 'output-check')
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Output-check không được prefetch.',
      });
  });
export const previewCancelSchema = z.object({ clientId: id, sequence: previewSequence }).strict();

export const audioPreviewRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    clientId: id.optional(),
    sequence: previewSequence.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.clientId) !== (value.sequence !== undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientId và sequence phải đi cùng nhau.',
      });
  });
