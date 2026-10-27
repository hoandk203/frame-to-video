import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { connectLauncher } from './launcher-control.js';
import { resolve } from 'node:path';
import { Diagnostics } from './storage/diagnostics.js';

let appToClose: Awaited<ReturnType<typeof createApp>>['app'] | null = null;
let startupDiagnostics = new Diagnostics(resolve(process.env.DATA_DIR || '.local-data', 'logs'));

try {
  const config = await loadConfig();
  startupDiagnostics = new Diagnostics(resolve(config.dataRoot, 'logs'));
  const { app, jobs } = await createApp(config);
  appToClose = app;
  let control: Awaited<ReturnType<typeof connectLauncher>> = null;
  app.addHook('onClose', async () => {
    control?.end();
  });
  await app.listen({ port: config.port, host: '127.0.0.1' });
  control = await connectLauncher(jobs, () => app.close());
  console.log(`Frame to Video Studio: http://127.0.0.1:${config.port}`);
  console.log(`Workspace: ${config.dataRoot}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.close();
    });
} catch (error) {
  await appToClose?.close().catch(() => {});
  await startupDiagnostics.record(error).catch(() => {});
  console.error(error);
  process.exitCode = 1;
}
