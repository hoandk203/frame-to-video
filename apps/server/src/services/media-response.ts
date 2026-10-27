import { createReadStream, type ReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

interface SelectedByteRange {
  status: 200 | 206 | 416;
  start: number;
  end: number;
  length: number;
  contentRange?: string;
}
export function byteRange(size: number, range?: string): SelectedByteRange {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid media size');
  if (range === undefined) return { status: 200, start: 0, end: size - 1, length: size };
  const invalid: SelectedByteRange = {
    status: 416,
    start: 0,
    end: -1,
    length: 0,
    contentRange: `bytes */${size}`,
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return invalid;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return invalid;
  if (first === undefined && (!last || last < 0)) return invalid;
  const start = first ?? Math.max(0, size - last!);
  const end = first === undefined ? size - 1 : Math.min(size - 1, last ?? size - 1);
  if (start < 0 || start > end || start >= size) return invalid;
  return {
    status: 206,
    start,
    end,
    length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}
/** File leases end on source close, including when a disconnected response destroys its source. */
export async function mediaResponse(
  source: string | Buffer,
  mime: string,
  range?: string,
  release = () => {},
) {
  let released = false;
  const done = () => {
    if (!released) {
      released = true;
      release();
    }
  };
  let body: ReadStream | Buffer | undefined;
  try {
    const selected = byteRange(
      Buffer.isBuffer(source) ? source.length : (await stat(source)).size,
      range,
    );
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Content-Type': mime,
      'Content-Length': String(selected.length),
    };
    if (selected.contentRange) headers['Content-Range'] = selected.contentRange;
    if (selected.status !== 416) {
      body = Buffer.isBuffer(source)
        ? source.subarray(selected.start, selected.end + 1)
        : createReadStream(
            source,
            selected.status === 206 ? { start: selected.start, end: selected.end } : {},
          );
      if (!Buffer.isBuffer(body)) body.once('close', done);
    }
    return {
      status: selected.status,
      headers,
      body,
      dispose: () => {
        if (body && !Buffer.isBuffer(body)) body.destroy();
        else done();
      },
    };
  } catch (error) {
    done();
    throw error;
  }
}
