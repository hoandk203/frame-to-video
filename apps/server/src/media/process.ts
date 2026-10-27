import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AppError } from '../errors.js';

export interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{ stdout: string; stderr: string }>;
}
export function startProcess(
  binary: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutput?: number;
    onOutput?: (chunk: string) => void;
    cwd?: string;
  } = {},
): RunningProcess {
  const child = spawn(binary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    cwd: options.cwd,
  });
  let stdout = '',
    stderr = '',
    finished = false,
    timedOut = false;
  const max = options.maxOutput ?? 262144;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (s: string) => {
    stdout = (stdout + s).slice(-max);
    options.onOutput?.(s);
  });
  child.stderr.on('data', (s: string) => {
    stderr = (stderr + s).slice(-max);
  });
  // stdin may emit EPIPE before close; owner observes done and write errors separately.
  child.stdin.on('error', () => {});
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (!finished) {
      child.kill();
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      forceTimer.unref();
    }
  };
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs)
    : undefined;
  const abort = () => stop();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) stop();
  const done = new Promise<{ stdout: string; stderr: string }>((res, rej) => {
    let spawnError: Error | null = null;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) return rej(options.signal.reason);
      if (timedOut)
        return rej(
          new AppError('ENGINE_TIMEOUT', 'Engine xử lý quá thời gian cho phép.', 504, true),
        );
      if (spawnError)
        return rej(
          new AppError('ENGINE_UNAVAILABLE', `Không chạy được engine: ${spawnError.message}`, 503),
        );
      if (code !== 0)
        return rej(
          new AppError(
            'ENCODE_FAILED',
            `Engine kết thúc với code ${code ?? signal}. ${stderr.slice(-3000)}`,
            422,
          ),
        );
      res({ stdout, stderr });
    });
  });
  // The caller can write stdin while this promise is already rejecting.
  void done.catch(() => {});
  return { child, done };
}
export async function capture(
  binary: string,
  args: string[],
  timeoutMs = 30000,
  signal?: AbortSignal,
  cwd?: string,
) {
  const process = startProcess(binary, args, { timeoutMs, signal, cwd, maxOutput: 4 * 1024 * 1024 });
  process.child.stdin.end();
  return process.done;
}
