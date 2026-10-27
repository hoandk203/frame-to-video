import { readJSON } from './workspace.js';
import { z } from 'zod';
import { id, safeRelativePath, appErrorSchema } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.refine((value) => value > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const assetSchema = z
  .object({
    id,
    sha256: hash,
    fileSize: positive,
    modifiedAtMs: z.number().finite().nonnegative().optional(),
    kind: z.enum(['frames', 'audio']),
    image: z
      .object({
        width: positive,
        height: positive,
        format: z.enum(['png', 'jpeg', 'webp']),
        orientation: z.number().int().min(1).max(8),
      })
      .strict()
      .optional(),
    audio: z.object({ durationUs: positive }).strict().optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.kind === 'frames' ? !asset.image || !!asset.audio : !asset.audio || !!asset.image)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Metadata nguồn không khớp loại ảnh/nhạc.',
      });
  });
export type Asset = z.infer<typeof assetSchema>;
export const assetRegistrySchema = z.array(assetSchema).superRefine((assets, context) => {
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Asset ID bị trùng trong registry.' });
});
const uploadFileSchema = z
  .object({
    fileId: id,
    clientFileId: id,
    name: z.string().min(1).max(255),
    relativePath: safeRelativePath,
    size: positive,
    status: z.enum(['pending', 'uploading', 'valid', 'invalid']),
    receivedBytes: integer,
    assetId: id.optional(),
    error: appErrorSchema.optional(),
  })
  .strict()
  .superRefine((file, context) => {
    if (
      file.receivedBytes > file.size ||
      (file.status === 'valid' && (!file.assetId || file.receivedBytes !== file.size))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Trạng thái/byte nguồn nhập không nhất quán.',
      });
  });
export const importSessionSchema = z
  .object({
    id,
    projectId: id,
    expectedRevision: positive,
    purpose: z.enum(['frames', 'audio']),
    mode: z.enum(['replace', 'append', 'relink']),
    status: z.enum(['open', 'finalized', 'canceled']),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    files: z.array(uploadFileSchema).max(100000),
    resultRevision: positive.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    const files = session.files;
    if (
      new Set(files.map((file) => file.fileId)).size !== files.length ||
      new Set(files.map((file) => file.clientFileId)).size !== files.length ||
      new Set(files.map((file) => file.relativePath)).size !== files.length ||
      (session.purpose === 'audio' && (files.length > 1 || session.mode === 'append')) ||
      (session.status === 'finalized' && (!session.resultRevision || !files.length))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Manifest nhập có ID/trạng thái trùng hoặc không nhất quán.',
      });
  });
export type ImportSession = z.infer<typeof importSessionSchema>;
export const importOperationsSchema = z.record(id, z.object({ hash, importId: id }).strict());
export const exportOperationsSchema = z.record(id, z.object({ hash, jobId: id }).strict());
/** Schema errors in persisted files are storage failures, never invalid HTTP requests. */
export function stored<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
  code: string,
): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new AppError(
      code,
      'Metadata lưu trên disk không hợp lệ. Giữ nguyên dữ liệu và kiểm tra backup/log.',
      500,
    );
  return result.data;
}

export async function readManifest<T>(
  path: string,
  validate: (raw: unknown) => T,
  code: string,
): Promise<T> {
  try {
    return await readJSON(path, validate);
  } catch (error) {
    if (error instanceof AppError || typeof (error as NodeJS.ErrnoException)?.code === 'string')
      throw error;
    throw new AppError(
      code,
      'Không đọc được metadata hợp lệ hoặc backup. Giữ nguyên dữ liệu để phục hồi.',
      500,
    );
  }
}
