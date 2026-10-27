import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { byteRange, mediaResponse } from '../apps/server/src/services/media-response.js';

test('single byte ranges reject unsafe/multiple ranges and handle suffixes, clamping and empty media', () => {
  assert.deepEqual(byteRange(10, 'bytes=2-5'), {
    status: 206,
    start: 2,
    end: 5,
    length: 4,
    contentRange: 'bytes 2-5/10',
  });
  assert.equal(byteRange(10, 'bytes=-3').start, 7);
  assert.equal(byteRange(10, 'bytes=-99').length, 10);
  assert.equal(byteRange(10, 'bytes=7-99').end, 9);
  assert.equal(byteRange(10, 'bytes=7-').length, 3);
  for (const range of [
    'bytes=-0',
    'bytes=-',
    'bytes=10-',
    'bytes=5-2',
    'bytes=0-1,3-4',
    'bytes=0-999999999999999999999999',
    'bytes=999999999999999999999999-',
    'items=0-1',
  ])
    assert.equal(byteRange(10, range).status, 416, range);
  assert.equal(byteRange(0).status, 200);
  assert.equal(byteRange(0, 'bytes=0-').status, 416);
  assert.throws(() => byteRange(-1), RangeError);
});
test('memory and file responses share exact byte ranges and leases end only after file source closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ftvs-response-'));
  try {
    const path = join(root, 'media.m4a');
    const data = Buffer.from('0123456789');
    await writeFile(path, data);
    for (const source of [data, path]) {
      let releases = 0;
      const result = await mediaResponse(source, 'audio/mp4', 'bytes=2-5', () => {
        releases++;
      });
      assert.equal(result.status, 206);
      assert.equal(result.headers['Content-Length'], '4');
      let body: Buffer;
      if (Buffer.isBuffer(result.body)) {
        body = result.body;
        assert.equal(releases, 0);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of result.body!) chunks.push(Buffer.from(chunk));
        body = Buffer.concat(chunks);
        assert.equal(releases, 1);
      }
      assert.equal(body.toString(), '2345');
      result.dispose();
      result.dispose();
      assert.equal(releases, 1);
    }
    let released = false;
    const aborted = await mediaResponse(path, 'audio/mp4', undefined, () => {
      released = true;
    });
    assert(aborted.body && !Buffer.isBuffer(aborted.body));
    const closed = once(aborted.body, 'close');
    aborted.dispose();
    assert.equal(
      released,
      false,
      'destroy requests closure but does not release an open file immediately',
    );
    await closed;
    assert.equal(released, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('invalid ranges and failed stat release their lease without opening a stream', async () => {
  let releases = 0;
  const response = await mediaResponse(Buffer.from('abc'), 'audio/mp4', 'bytes=3-', () => {
    releases++;
  });
  assert.equal(response.status, 416);
  assert.equal(response.body, undefined);
  response.dispose();
  assert.equal(releases, 1);
  await assert.rejects(
    mediaResponse('/missing/file', 'video/mp4', undefined, () => {
      releases++;
    }),
  );
  assert.equal(releases, 2);
});
