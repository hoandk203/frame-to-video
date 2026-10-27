import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyZipEnvelope } from '../apps/server/src/media/archive.js';

test('ZIP64 envelope verification accepts an independently created fixture and rejects truncation/count/offset corruption', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/zip64-envelope.zip', import.meta.url));
  await verifyZipEnvelope(fixture, 1);
  await assert.rejects(verifyZipEnvelope(fixture, 2), /thiếu file/);
  const root = await mkdtemp(join(tmpdir(), 'ftvs-zip-envelope-'));
  try {
    const bytes = await readFile(fixture), path = join(root, 'corrupt.zip');
    await writeFile(path, bytes.subarray(0, bytes.length - 3));
    await assert.rejects(verifyZipEnvelope(path, 1), /footer/);
    const badOffset = Buffer.from(bytes);
    badOffset.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, badOffset.length - 42 + 8);
    await writeFile(path, badOffset); await assert.rejects(verifyZipEnvelope(path, 1), /offset/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
