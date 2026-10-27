import { z } from 'zod';
import {
  id,
  exportJobSchema,
  type ExportJob,
} from '../../../../../packages/contracts/src/index.js';
import { APIError } from '../../api.js';

const requestSchema = z
  .object({
    projectId: id,
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(['video', 'cli']),
    fileName: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\\/\x00-\x1f<>:"|?*]+$/),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.kind === 'video' ? !/\.mp4$/i.test(input.fileName) : !/\.zip$/i.test(input.fileName))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Đuôi file xuất không hợp lệ.' });
  });
export type ExportRequest = z.infer<typeof requestSchema>;
const attemptSchema = z
  .object({ schemaVersion: z.literal(1), key: id, request: requestSchema })
  .strict();
export type ExportAttempt = z.infer<typeof attemptSchema>;
export interface SubmissionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function submissionStorage(): SubmissionStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
const journal = 'ftvs-export-request-v1';
function definitiveRejection(error: unknown) {
  return (
    error instanceof APIError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 408, 429].includes(error.status) &&
    error.code !== 'APP_STOPPING'
  );
}
/** One frozen request per tab. Ambiguous responses keep its key through retry/reload. */
export class ExportSubmission {
  private attempt: ExportAttempt | null = null;
  private inFlight: Promise<ExportJob> | null = null;
  constructor(
    private storage: SubmissionStorage | null,
    private createKey = () => crypto.randomUUID(),
  ) {
    try {
      const raw = storage?.getItem(journal);
      if (raw) {
        const parsed = raw.length <= 8192 ? attemptSchema.safeParse(JSON.parse(raw)) : null;
        if (parsed?.success) this.attempt = parsed.data;
        else storage?.removeItem(journal);
      }
    } catch {
      try {
        storage?.removeItem(journal);
      } catch {
        this.storage = null;
      }
    }
  }
  get pending(): ExportAttempt | null {
    return this.attempt ? structuredClone(this.attempt) : null;
  }
  private persist() {
    try {
      if (this.attempt) this.storage?.setItem(journal, JSON.stringify(this.attempt));
      else this.storage?.removeItem(journal);
    } catch {
      this.storage = null;
    } // history/status still permits recovery if browser storage is disabled
  }
  submit(
    input: ExportRequest,
    send: (request: Readonly<ExportRequest>, key: string) => Promise<unknown>,
  ): Promise<ExportJob> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new Error('Tên file hoặc thông tin xuất chưa hợp lệ.'));
    const request = parsed.data;
    if (this.attempt && JSON.stringify(this.attempt.request) !== JSON.stringify(request))
      return Promise.reject(
        new Error('Có yêu cầu xuất chưa nhận được xác nhận. Hãy kết nối lại yêu cầu đó trước.'),
      );
    if (this.inFlight) return this.inFlight;
    if (!this.attempt) {
      this.attempt = { schemaVersion: 1, key: id.parse(this.createKey()), request };
      this.persist(); // record before the first byte can be sent
    }
    const attempt = this.attempt;
    this.inFlight = Promise.resolve()
      .then(() => send(Object.freeze({ ...attempt.request }), attempt.key))
      .then((raw) => {
        const result = exportJobSchema.safeParse(raw);
        if (
          !result.success ||
          result.data.projectId !== request.projectId ||
          result.data.projectRevision !== request.expectedRevision ||
          result.data.kind !== request.kind ||
          result.data.fileName !== request.fileName
        )
          throw new Error('Phản hồi tác vụ chưa hợp lệ. Kết nối lại để xác minh yêu cầu xuất.');
        this.attempt = null;
        this.persist();
        return result.data;
      })
      .catch((error) => {
        if (definitiveRejection(error)) {
          this.attempt = null;
          this.persist();
        }
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
