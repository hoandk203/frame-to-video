import { setMaxListeners } from 'node:events';
import { AppError, assert } from '../errors.js';

export interface PreviewScheduling {
  clientId: string;
  sequence: number;
  intent: 'seek' | 'prefetch';
}
interface View {
  sequence: number;
  controller: AbortController;
  refs: number;
  touched: number;
  canceled: boolean;
}
function controller() {
  const value = new AbortController();
  // One view can own the service's 64 admitted tasks; every scheduler detaches on settlement.
  setMaxListeners(64, value.signal);
  return value;
}
const superseded = () =>
  new AppError('PREVIEW_SUPERSEDED', 'Vị trí xem trước đã thay đổi.', 409, true);
/** Registration precedes metadata IO, so late older requests cannot replace the newest selection. */
export class PreviewSelections {
  private views = new Map<string, View>();
  private closing = false;
  constructor(
    private maxViews = 1024,
    private ttlMs = 30 * 60 * 1000,
    private now = Date.now,
  ) {
    if (
      !Number.isSafeInteger(maxViews) ||
      maxViews < 1 ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1
    )
      throw new RangeError('Invalid preview view limit');
  }
  private view(projectId: string, clientId: string, sequence: number) {
    assert(!this.closing, 'APP_STOPPING', 'Preview đang dừng.', 409);
    assert(
      Number.isSafeInteger(sequence) && sequence > 0,
      'INVALID_PREVIEW_SEQUENCE',
      'Sequence preview không hợp lệ.',
    );
    const key = `${projectId}:${clientId}`;
    let view = this.views.get(key);
    if (!view) {
      const cutoff = this.now() - this.ttlMs;
      for (const [id, old] of this.views)
        if (!old.refs && old.touched <= cutoff) this.views.delete(id);
      assert(
        this.views.size < this.maxViews,
        'PREVIEW_CLIENT_LIMIT',
        'Quá nhiều phiên preview. Thử lại sau.',
        503,
      );
      view = {
        sequence,
        controller: controller(),
        refs: 0,
        touched: this.now(),
        canceled: false,
      };
      this.views.set(key, view);
    }
    if (sequence > view.sequence) {
      view.controller.abort(superseded());
      view.sequence = sequence;
      view.controller = controller();
      view.canceled = false;
    }
    view.touched = this.now();
    return { key, view };
  }
  begin(projectId: string, options: PreviewScheduling) {
    const { key, view } = this.view(projectId, options.clientId, options.sequence);
    assert(
      options.sequence === view.sequence && !view.canceled,
      'PREVIEW_SUPERSEDED',
      'Vị trí xem trước đã thay đổi.',
      409,
    );
    view.refs++;
    let released = false;
    return {
      owner: `${key}:${options.sequence}:${options.intent}`,
      signal: view.controller.signal,
      release: () => {
        if (!released) {
          released = true;
          view.refs--;
          view.touched = this.now();
        }
      },
    };
  }
  cancel(projectId: string, clientId: string, sequence: number) {
    const { view } = this.view(projectId, clientId, sequence);
    if (sequence < view.sequence) return;
    view.canceled = true;
    view.controller.abort(superseded());
  }
  shutdown() {
    this.closing = true;
    for (const view of this.views.values())
      view.controller.abort(new AppError('APP_STOPPING', 'Preview đang dừng.', 409));
  }
}
