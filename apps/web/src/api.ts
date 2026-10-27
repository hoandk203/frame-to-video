let csrf = '';
let bootstrap: Promise<void> | null = null;
const prefix = '/api/v1';
export class APIError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function connect() {
  if (!bootstrap)
    bootstrap = fetch(`${prefix}/session`, { headers: { 'X-App-Client': 'frame-to-video-studio' } })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok)
          throw new APIError(
            body.error?.message ?? 'Không kết nối được backend.',
            body.error?.code ?? 'CONNECTION',
            r.status,
          );
        csrf = body.data.csrfToken;
      })
      .finally(() => {
        bootstrap = null;
      });
  return bootstrap;
}
export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  if (!csrf) await connect();
  const headers = new Headers(options.headers);
  headers.set('X-App-Client', 'frame-to-video-studio');
  if (options.method && !['GET', 'HEAD'].includes(options.method))
    headers.set('X-CSRF-Token', csrf);
  if (typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(`${prefix}${path}`, { ...options, headers });
  if (response.status === 401 && retry) {
    csrf = '';
    await connect();
    return api<T>(path, options, false);
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok)
    throw new APIError(
      body.error?.message ?? 'Yêu cầu thất bại.',
      body.error?.code ?? 'UNKNOWN',
      response.status,
    );
  return body.data as T;
}
export function post<T>(path: string, data: unknown, key?: string) {
  return api<T>(path, {
    method: 'POST',
    body: JSON.stringify(data),
    headers: key ? { 'Idempotency-Key': key } : {},
  });
}
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function previewBlob(url: string, retry = true): Promise<Blob> {
  if (!/^\/api\/v1\/previews\/[0-9a-f-]{36}$/.test(url))
    throw new Error('URL preview không hợp lệ.');
  const response = await fetch(url, { credentials: 'same-origin' });
  if (response.status === 401 && retry) {
    await connect();
    return previewBlob(url, false);
  }
  if (!response.ok) {
    const body = await response.json();
    throw new APIError(
      body.error?.message ?? 'Không tải được preview.',
      body.error?.code ?? 'PREVIEW_FAILED',
      response.status,
    );
  }
  if (!response.headers.get('Content-Type')?.startsWith('image/png'))
    throw new Error('Định dạng preview không hợp lệ.');
  return response.blob();
}
