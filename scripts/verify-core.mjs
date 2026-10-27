import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const evidenceDir = resolve(root, 'docs/verification');
const media = process.argv.includes('--media');
await mkdir(evidenceDir, { recursive: true });
await writeFile(
  resolve(evidenceDir, 'script-core.json'),
  JSON.stringify({ passed: false, state: 'starting', recordedAt: new Date().toISOString() }),
);
if (media && (!process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH)) {
  console.error(
    '--media requires explicit FFMPEG_PATH and FFPROBE_PATH. No skipped media cases may be claimed as verified.',
  );
  process.exitCode = 1;
} else {
  await mkdir(evidenceDir, { recursive: true });
  const files = (await readdir(resolve(root, 'tests')))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `tests/${name}`);
  const typeArgs = [
    require.resolve('typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--noUncheckedIndexedAccess',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2023',
    '--esModuleInterop',
    ...files,
    'apps/server/src/services/previews.ts',
    'apps/server/src/launcher-control.ts',
    'apps/server/src/config.ts',
  ];
  const compiler = spawnSync(process.execPath, typeArgs, { cwd: root, encoding: 'utf8' });
  await writeFile(
    resolve(evidenceDir, 'script-core-typecheck.txt'),
    (compiler.stdout ?? '') + (compiler.stderr ?? ''),
  );
  const tests =
    compiler.status === 0 && !compiler.error
      ? spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            '--test',
            '--experimental-test-isolation=none',
            '--test-reporter=tap',
            ...files,
          ],
          { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        )
      : null;
  const tap = tests?.stdout ?? '';
  if (tests) await writeFile(resolve(evidenceDir, 'script-core.tap'), tap + (tests.stderr ?? ''));
  const value = (name) => Number(new RegExp(`^# ${name} ([0-9]+)$`, 'm').exec(tap)?.[1] ?? 0);
  const counts = {
    total: value('tests'),
    pass: value('pass'),
    fail: value('fail'),
    skipped: value('skipped'),
  };
  const passed =
    compiler.status === 0 &&
    !compiler.error &&
    tests?.status === 0 &&
    !tests.error &&
    counts.total > 0 &&
    counts.fail === 0 &&
    (!media || counts.skipped === 0);
  let ffmpegVersion = null;
  if (process.env.FFMPEG_PATH) {
    try {
      ffmpegVersion = execFileSync(process.env.FFMPEG_PATH, ['-version'], {
        encoding: 'utf8',
        timeout: 10000,
      }).split('\n')[0];
    } catch {
      ffmpegVersion = 'unavailable';
    }
  }
  const sources = [];
  async function visit(dir) {
    for (const entry of await readdir(resolve(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (/\.(ts|tsx|mjs)$/.test(path)) sources.push(path);
    }
  }
  for (const dir of ['apps', 'packages', 'tests', 'scripts']) await visit(dir);
  const hash = createHash('sha256');
  for (const path of sources.sort()) {
    hash.update(path);
    hash.update(await readFile(resolve(root, path)));
  }
  await writeFile(
    resolve(evidenceDir, 'script-core.json'),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        typescript: require('typescript/package.json').version,
        sharp: require('sharp').versions,
        ffmpegVersion,
        mediaRequired: media,
        typecheckExitCode: compiler.error ? null : compiler.status,
        typecheckSpawnError: compiler.error?.message ?? null,
        testsExitCode: tests?.error ? null : (tests?.status ?? null),
        testsSpawnError: tests?.error?.message ?? null,
        counts,
        passed,
        sourceDigest: hash.digest('hex'),
        testFiles: files,
        scope:
          'Core/service tests and their TypeScript graph, plus previews/config/launcher-control. Excludes Fastify HTTP integration, React browser runtime, Go compilation and Windows release gates.',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed,
      ...counts,
      typecheckExitCode: compiler.error ? null : compiler.status,
    }),
  );
  if (!passed) {
    console.error(
      compiler.error?.message ?? '',
      compiler.stderr ?? '',
      compiler.stdout ?? '',
      tests?.error?.message ?? '',
      tests?.stderr ?? '',
    );
    process.exitCode = 1;
  }
}
