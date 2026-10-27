import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, assert } from '../errors.js';

export class Sessions {
  private sessions = new Map<string, string>();
  readonly cookieName: string;
  constructor(
    public port: number,
    private devOrigin?: string,
  ) {
    this.cookieName = `ftvs_${port}`;
  }
  private token() {
    return randomBytes(32).toString('base64url');
  }
  private cookieValue(header?: string) {
    return header
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1);
  }
  host(host?: string) {
    assert(host === `127.0.0.1:${this.port}`, 'INVALID_HOST', 'Host không được phép.', 403);
  }
  origin(origin?: string, required = false) {
    assert(
      (!required && !origin) ||
        origin === `http://127.0.0.1:${this.port}` ||
        (!!this.devOrigin && origin === this.devOrigin),
      'INVALID_ORIGIN',
      'Origin không được phép.',
      403,
    );
  }
  bootstrap(headers: Record<string, string | string[] | undefined>) {
    this.host(headers.host as string | undefined);
    this.origin(headers.origin as string | undefined);
    assert(
      headers['x-app-client'] === 'frame-to-video-studio' &&
        headers['sec-fetch-site'] !== 'cross-site',
      'INVALID_CLIENT',
      'Yêu cầu session không hợp lệ.',
      403,
    );
    const previous = this.cookieValue(headers.cookie as string | undefined);
    if (previous && this.sessions.has(previous))
      return { token: this.sessions.get(previous)!, cookie: null };
    const session = this.token(),
      csrf = this.token();
    this.sessions.set(session, csrf);
    return {
      token: csrf,
      cookie: `${this.cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/api/v1`,
    };
  }
  check(headers: Record<string, string | string[] | undefined>, mutation: boolean) {
    this.host(headers.host as string | undefined);
    this.origin(headers.origin as string | undefined, mutation);
    const session = this.cookieValue(headers.cookie as string | undefined),
      token = session && this.sessions.get(session);
    if (!token)
      throw new AppError('SESSION_REQUIRED', 'Phiên đã hết hạn. Hãy tải lại website.', 401);
    if (mutation) {
      const csrf = headers['x-csrf-token'];
      assert(
        headers['x-app-client'] === 'frame-to-video-studio' &&
          typeof csrf === 'string' &&
          Buffer.byteLength(csrf) === Buffer.byteLength(token) &&
          timingSafeEqual(Buffer.from(csrf), Buffer.from(token)),
        'INVALID_CSRF',
        'CSRF token không hợp lệ.',
        403,
      );
    }
  }
}
