import { createConnection } from 'node:net';
import type { Exports } from './jobs/exports.js';
import { assert } from './errors.js';

// Only the native launcher creates this ACL-restricted named pipe.
// No HTTP endpoint exposes nonce/control messages.
export async function connectLauncher(jobs: Exports, shutdown: () => Promise<void>) {
  const pipe = process.env.FTVS_CONTROL_PIPE,
    nonce = process.env.FTVS_STARTUP_NONCE;
  delete process.env.FTVS_STARTUP_NONCE;
  delete process.env.FTVS_CONTROL_PIPE;
  if (!pipe && !nonce) return null; // source developer mode
  assert(
    pipe?.startsWith('\\\\.\\pipe\\ftvs-') && nonce?.match(/^[a-f0-9]{64}$/),
    'INVALID_LAUNCHER',
    'Launcher control không hợp lệ.',
    500,
  );
  assert(typeof pipe === 'string', 'INVALID_LAUNCHER', 'Thiếu control pipe.', 500);
  const socket = createConnection(pipe);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const send = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)),
      head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    socket.write(Buffer.concat([head, body]));
  };
  const status = () => {
    const candidate = jobs.activeJob;
    const active =
      candidate && !['completed', 'failed', 'canceled', 'interrupted'].includes(candidate.status)
        ? candidate
        : null;
    send({ action: 'status', active: !!active, jobId: active?.id ?? '' });
  };
  send({ action: 'ready', nonce, pid: process.pid });
  status();
  jobs.on('status', status);
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > 65536) {
        socket.destroy();
        return;
      }
      if (buffer.length < length + 4) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        const message = JSON.parse(body.toString('utf8')) as {
          action: string;
          requestId: string;
          cancelActiveJob?: boolean;
          jobId?: string;
        };
        if (message.action !== 'shutdown') continue;
        const active = jobs.activeJob;
        if (
          active &&
          !['completed', 'failed', 'canceled', 'interrupted'].includes(active.status) &&
          (!message.cancelActiveJob || message.jobId !== active.id)
        ) {
          send({
            action: 'shutdown-response',
            requestId: message.requestId,
            error: 'Tác vụ đã thay đổi. Hãy xác nhận dừng lại.',
          });
          status();
          continue;
        }
        send({ action: 'shutdown-response', requestId: message.requestId });
        void shutdown()
          .then(() => socket.end())
          .catch(() => socket.destroy());
      } catch {
        socket.destroy();
      }
    }
  });
  socket.on('error', () => {});
  socket.once('close', () => jobs.off('status', status));
  return socket;
}
