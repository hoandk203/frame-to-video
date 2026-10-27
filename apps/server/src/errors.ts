import { ZodError } from 'zod';
import type { AppErrorData } from '../../../packages/contracts/src/index.js';

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public retryable = false,
    public sourceId?: string,
  ) {
    super(message);
  }
  toJSON(): AppErrorData {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.sourceId ? { sourceId: this.sourceId } : {}),
    };
  }
}
export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError)
    return new AppError('INVALID_REQUEST', error.issues.map((i) => i.message).join('; '));
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC') return new AppError('DISK_FULL', 'Ổ đĩa đã hết dung lượng.', 507);
  if (code === 'EACCES' || code === 'EPERM')
    return new AppError('OUTPUT_NOT_WRITABLE', 'Không có quyền truy cập dữ liệu.', 403);
  return new AppError('INTERNAL_ERROR', 'Xử lý thất bại. Xem mã chẩn đoán.', 500);
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
