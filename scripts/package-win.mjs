import { readFile, mkdir, cp, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, manifest, sha256 } from './setup-media.mjs';

async function rejectSymlinks(dir) {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, file.name);
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`Portable artifact cannot contain external symlinks: ${path}`);
    if (file.isDirectory()) await rejectSymlinks(path);
  }
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('Packaging requires Windows x64. Linux test success is not a Windows release.');
  const m = await manifest();
  for (const artifact of m.artifacts) {
    if ((await sha256(resolve(root, artifact.path))) !== artifact.sha256)
      throw new Error(`Invalid artifact checksum ${artifact.role}`);
    await readFile(resolve(root, artifact.licensePath));
  }
  // Do not publish an app with no reproducible dependency lock.
  await readFile(resolve(root, 'pnpm-lock.yaml'));
  const packageJSON = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const stage = resolve(root, 'artifacts/staging/FrameToVideoStudio');
  await rm(stage, { force: true, recursive: true });
  await mkdir(stage, { recursive: true });
  for (const dir of ['runtime', 'app/server', 'app/web', 'media', 'licenses'])
    await mkdir(resolve(stage, dir), { recursive: true });
  await cp(resolve(root, 'dist/apps'), resolve(stage, 'app/server/dist/apps'), { recursive: true });
  await cp(resolve(root, 'dist/packages'), resolve(stage, 'app/server/dist/packages'), {
    recursive: true,
  });
  await cp(resolve(root, 'dist/web'), resolve(stage, 'app/web'), { recursive: true });
  await writeFile(
    resolve(stage, 'app/server/main.js'),
    `import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
try { await import('./dist/apps/server/src/main.js'); }
catch (error) {
  const logs = resolve(process.env.DATA_DIR || 'data', 'logs');
  await mkdir(logs, { recursive: true }).catch(() => {});
  const content = Buffer.from(String(error?.stack || error)).subarray(0, 65536);
  await writeFile(resolve(logs, 'bootstrap.log'), content, { mode: 0o600 }).catch(() => {});
  process.exitCode = 1;
}
`,
  );
  await writeFile(resolve(stage, 'app/server/package.json'), JSON.stringify(packageJSON, null, 2));
  await cp(resolve(root, 'pnpm-lock.yaml'), resolve(stage, 'app/server/pnpm-lock.yaml'));
  await writeFile(resolve(stage, 'app/server/pnpm-workspace.yaml'), 'packages: []\n');
  if (!process.env.npm_execpath) throw new Error('Run packager through pnpm package:win');
  execFileSync(
    process.execPath,
    [
      process.env.npm_execpath,
      'install',
      '--prod',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--node-linker=hoisted',
    ],
    { cwd: resolve(stage, 'app/server'), stdio: 'inherit' },
  );
  for (const artifact of m.artifacts) {
    const destination =
      artifact.role === 'node' ? 'runtime/node.exe' : `media/${artifact.role}.exe`;
    await cp(resolve(root, artifact.path), resolve(stage, destination));
    await cp(
      resolve(root, artifact.licensePath),
      resolve(stage, 'licenses', `${artifact.role}.txt`),
    );
  }
  for (const mode of ['Start', 'Stop'])
    execFileSync(
      'go',
      ['build', '-trimpath', '-ldflags=-H=windowsgui', '-o', resolve(stage, `${mode}.exe`), '.'],
      {
        cwd: resolve(root, 'launcher'),
        stdio: 'inherit',
        env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GOAMD64: 'v1' },
      },
    );
  await cp(resolve(root, 'config.json'), resolve(stage, 'config.json'));
  await cp(resolve(root, 'README.txt'), resolve(stage, 'README.txt'));
  await writeFile(resolve(stage, 'release-manifest.json'), JSON.stringify(m, null, 2));
  await rejectSymlinks(stage);
  const archiver = (await import('archiver')).default;
  const path = resolve(root, `artifacts/FrameToVideoStudio-${m.appVersion}-win-x64.zip`);
  const stream = createWriteStream(path),
    zip = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise((res, rej) => {
    stream.on('close', res);
    stream.on('error', rej);
    zip.on('error', rej);
  });
  zip.pipe(stream);
  zip.directory(stage, 'FrameToVideoStudio');
  await zip.finalize();
  await done;
  await writeFile(`${path}.sha256`, `${await sha256(path)}  ${path.split(/[\\/]/).pop()}\n`);
  console.log(`Artifact built, not certified until Windows clean-machine gates pass: ${path}`);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
