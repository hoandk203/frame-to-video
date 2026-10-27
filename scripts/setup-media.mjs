import { readFile, mkdir, rename, rm, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function manifest() {
  const result = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
  if (result.schemaVersion !== 1 || result.target !== 'win-x64')
    throw new Error('Invalid release manifest');
  for (const role of result.requiredRoles) {
    const artifact = result.artifacts.find((a) => a.role === role);
    if (
      !artifact ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !artifact.version ||
      !artifact.url?.startsWith('https://') ||
      !artifact.path ||
      !artifact.licensePath
    )
      throw new Error(
        `Release artifact ${role} chưa pin version/URL/SHA-256/license. Không tải latest hoặc tạo gói thiếu engine.`,
      );
    const rel = relative(root, resolve(root, artifact.path));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
      throw new Error('Artifact path escapes repository');
  }
  return result;
}
export async function setupMedia() {
  const m = await manifest();
  for (const artifact of m.artifacts) {
    const destination = resolve(root, artifact.path);
    if ((await sha256(destination).catch(() => '')) === artifact.sha256) continue;
    const response = await fetch(artifact.url);
    if (!response.ok || !response.body)
      throw new Error(`Download failed: ${artifact.role} ${response.status}`);
    await mkdir(dirname(destination), { recursive: true });
    const temp = `${destination}.${randomUUID()}.part`;
    try {
      const handle = await open(temp, 'wx');
      try {
        for await (const chunk of response.body) await handle.writeFile(chunk);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await sha256(temp)) !== artifact.sha256)
        throw new Error(`Checksum mismatch: ${artifact.role}`);
      await rename(temp, destination);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  setupMedia().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
