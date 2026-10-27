import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const vite = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const children = [];
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  for (const child of children) if (child.exitCode === null) child.kill();
}
for (const args of [
  ['--import', 'tsx', 'apps/server/src/main.ts'],
  [vite, '--config', 'apps/web/vite.config.ts'],
]) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      APP_ROOT: root,
      APP_DEV: '1',
      DATA_DIR: process.env.DATA_DIR || '.local-data',
    },
  });
  children.push(child);
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.once('exit', (code) => {
    if (!closing) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
