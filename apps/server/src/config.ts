import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, type Config } from '../../../packages/contracts/src/index.js';

export interface RuntimeConfig extends Config {
  root: string;
  dataRoot: string;
  ffmpeg: string;
  ffprobe: string;
}
export async function loadConfig(
  root = process.env.APP_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
): Promise<RuntimeConfig> {
  if (!process.env.APP_ROOT && basename(root) === 'dist') root = dirname(root);
  const raw = await readFile(resolve(root, 'config.json'), 'utf8').catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return '{}';
      throw e;
    },
  );
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const config = configSchema.parse({
    ...parsed,
    ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
    ...(process.env.DATA_DIR ? { dataDir: process.env.DATA_DIR } : {}),
  });
  return {
    ...config,
    root,
    dataRoot: resolve(root, config.dataDir),
    ffmpeg:
      process.env.FFMPEG_PATH ||
      resolve(root, 'media', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ffprobe:
      process.env.FFPROBE_PATH ||
      resolve(root, 'media', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
  };
}
