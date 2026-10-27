import { mediaResponse } from './services/media-response.js';
import { MediaScheduler } from './rendering/scheduler.js';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  id,
  previewRequestSchema,
  previewCancelSchema,
  audioPreviewRequestSchema,
  videoSchema,
  audioSchema,
  type ExportJob,
} from '../../../packages/contracts/src/index.js';
import { AppError, asAppError, assert } from './errors.js';
import type { RuntimeConfig } from './config.js';
import { Workspace } from './storage/workspace.js';
import { Quota } from './storage/quota.js';
import { Engine } from './media/engine.js';
import { Imports } from './services/imports.js';
import { Previews } from './services/previews.js';
import { Exports } from './jobs/exports.js';
import { Sessions } from './security/session.js';
import { Projects } from './services/projects.js';
import { Diagnostics } from './storage/diagnostics.js';
import { packageEstimate } from './services/cli-package.js';

export async function createApp(config: RuntimeConfig) {
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: false, requestTimeout: 60000 });
  const ws = new Workspace(config.dataRoot);
  await ws.init();
  const diagnostics = new Diagnostics(ws.path('logs'));
  let expireTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const engine = new Engine(config.ffmpeg, config.ffprobe),
      quota = new Quota(ws, config.limits);
    const imports = new Imports(ws, config.limits, quota, engine);
    const scheduler = new MediaScheduler();
    const jobs = new Exports(ws, imports, engine, quota, config.limits, scheduler);
    jobs.on('maintenance-error', (error) => {
      void diagnostics.record(error).catch(() => {});
    });
    await jobs.init();
    await imports.init();
    const projects = new Projects(ws, imports, jobs, config.limits.maxFrames);
    await projects.init();
    const previews = new Previews(ws, imports, engine, config.limits, scheduler, quota);
    await previews.init();
    const sessions = new Sessions(
      config.port,
      process.env.APP_DEV === '1' ? 'http://127.0.0.1:5173' : undefined,
    );
    const p = '/api/v1';
    let stopping = false;
    let maintenance: Promise<unknown> | null = null;
    expireTimer = setInterval(() => {
      if (maintenance) return;
      maintenance = imports
        .expire()
        .catch((error) => diagnostics.record(error).catch(() => {}))
        .finally(() => {
          maintenance = null;
        });
    }, 30000);
    expireTimer.unref();
    app.addHook('onRequest', async (req, reply) => {
      sessions.host(req.headers.host);
      reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .header(
          'Content-Security-Policy',
          "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
      const path = req.url.split('?')[0]!;
      if (path.startsWith(p) && path !== `${p}/health` && path !== `${p}/session`) {
        sessions.check(req.headers, !['GET', 'HEAD'].includes(req.method));
        reply.header('Cache-Control', 'no-store');
      }
    });
    app.setErrorHandler(async (error, _req, reply) => {
      const mapped = asAppError(error);
      // Do not claim a diagnostic exists if disk/permission failure prevented it.
      const diagnosticId = await diagnostics.record(error).catch(() => undefined);
      reply
        .code(mapped.statusCode)
        .send({ error: { ...mapped.toJSON(), ...(diagnosticId ? { diagnosticId } : {}) } });
    });
    await app.register(multipart, {
      limits: { files: 1, fields: 0, parts: 1, fileSize: config.limits.maxFileBytes },
      throwFileSizeLimit: true,
    });
    app.get(`${p}/health`, async () => ({
      data: { ready: !stopping, app: 'frame-to-video-studio' },
    }));
    app.get(`${p}/session`, async (req, reply) => {
      const result = sessions.bootstrap(req.headers);
      reply.header('Cache-Control', 'no-store');
      if (result.cookie) reply.header('Set-Cookie', result.cookie);
      return { data: { csrfToken: result.token } };
    });
    app.get(`${p}/engine`, async () => ({ data: await engine.status() }));
    app.get(`${p}/app/status`, async () => ({
      data: {
        version: '0.1.0',
        stopping,
        activeJob: jobs.activeJob,
        engine: await engine.status(),
      },
    }));
    app.get(`${p}/projects`, async () => ({ data: await ws.listProjects() }));
    app.post(`${p}/projects`, async (req, reply) => {
      const body = z
        .object({ name: z.string().trim().min(1).max(120) })
        .strict()
        .parse(req.body);
      return reply.code(201).send({ data: await ws.createProject(body.name) });
    });
    app.get<{ Params: { projectId: string } }>(`${p}/projects/:projectId`, async (req) => ({
      data: await projects.open(req.params.projectId),
    }));
    app.patch<{ Params: { projectId: string } }>(`${p}/projects/:projectId`, async (req) => {
      const patch = z
        .object({
          expectedRevision: z.number().int().positive(),
          name: z.string().trim().min(1).max(120).optional(),
          video: videoSchema.optional(),
          audio: audioSchema.nullable().optional(),
          order: z.array(id).optional(),
          removedFrameIds: z.array(id).optional(),
        })
        .strict()
        .parse(req.body);
      const project = await ws.updateProject(
        req.params.projectId,
        patch.expectedRevision,
        (project) => {
          assert(!jobs.isProjectBusy(project.id), 'JOB_BUSY', 'Dự án đang xuất.', 409);
          if (patch.name) project.name = patch.name;
          if (patch.video) project.video = patch.video;
          if (patch.audio !== undefined) {
            assert(
              patch.audio === null || patch.audio.assetId === project.audio?.assetId,
              'INVALID_ASSET',
              'Không thể gán nhạc của dự án khác.',
              403,
            );
            project.audio =
              patch.audio && project.audio
                ? {
                    ...project.audio,
                    volume: patch.audio.volume,
                    shortTrackPolicy: patch.audio.shortTrackPolicy,
                  }
                : null;
          }
          if (patch.removedFrameIds)
            project.frames = project.frames.filter((f) => !patch.removedFrameIds!.includes(f.id));
          if (patch.order) {
            const order = patch.order,
              byId = new Map(project.frames.map((f) => [f.id, f]));
            assert(
              order.length === byId.size &&
                new Set(order).size === order.length &&
                order.every((i) => byId.has(i)),
              'INVALID_ORDER',
              'Thứ tự frame không đầy đủ.',
            );
            project.frames = order.map((i) => byId.get(i)!);
          }
          return project;
        },
      );
      return { data: project };
    });
    app.get<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/config`,
      async (req, reply) => {
        reply.header('Content-Disposition', 'attachment; filename="project.ftvs.json"');
        return projects.exportConfig(req.params.projectId);
      },
    );
    app.post(`${p}/projects/import-config`, async (req, reply) =>
      reply.code(201).send({ data: await projects.importConfig(req.body) }),
    );
    app.delete<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId`,
      async (req, reply) => {
        const body = z
          .object({ expectedRevision: z.number().int().positive(), confirm: z.literal(true) })
          .strict()
          .parse(req.body);
        await projects.remove(req.params.projectId, body.expectedRevision);
        return reply.code(204).send();
      },
    );
    app.post(`${p}/storage/collect-garbage`, async () => ({
      data: await imports.collectGarbage(),
    }));
    app.get<{ Params: { projectId: string } }>(`${p}/projects/:projectId/jobs`, async (req) => ({
      data: jobs.list(req.params.projectId),
    }));
    app.post<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/imports`,
      async (req, reply) =>
        reply.code(201).send({
          data: await imports.create(
            req.params.projectId,
            req.body,
            id.parse(req.headers['idempotency-key']),
          ),
        }),
    );
    app.get<{ Params: { projectId: string } }>(`${p}/projects/:projectId/imports`, async (req) => {
      await ws.project(req.params.projectId);
      return { data: imports.list(req.params.projectId) };
    });
    app.get<{ Params: { importId: string } }>(`${p}/imports/:importId`, async (req) => ({
      data: imports.get(req.params.importId),
    }));
    app.put<{ Params: { importId: string; fileId: string } }>(
      `${p}/imports/:importId/files/:fileId`,
      async (req) => {
        const file = await req.file();
        assert(
          file && file.fieldname === 'file',
          'INVALID_UPLOAD',
          'Cần một multipart part tên file.',
        );
        return { data: await imports.upload(req.params.importId, req.params.fileId, file.file) };
      },
    );
    app.delete<{ Params: { importId: string; fileId: string } }>(
      `${p}/imports/:importId/files/:fileId`,
      async (req) => ({ data: await imports.removeFile(req.params.importId, req.params.fileId) }),
    );
    app.delete<{ Params: { importId: string } }>(`${p}/imports/:importId`, async (req, reply) => {
      await imports.cancel(req.params.importId);
      return reply.code(204).send();
    });
    app.post<{ Params: { importId: string } }>(`${p}/imports/:importId/finalize`, async (req) => {
      const body = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(req.body);
      return { data: await imports.finalize(req.params.importId, body.expectedRevision) };
    });
    app.post<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/previews`,
      async (req, reply) => {
        const body = previewRequestSchema.parse(req.body);
        return reply.code(202).send({
          data: await previews.request(
            req.params.projectId,
            body.revision,
            body.frameIndex,
            body.mode,
            body.clientId
              ? { clientId: body.clientId, sequence: body.sequence!, intent: body.intent }
              : undefined,
          ),
        });
      },
    );
    app.post<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/previews/cancel`,
      async (req, reply) => {
        const body = previewCancelSchema.parse(req.body);
        id.parse(req.params.projectId);
        previews.cancel(req.params.projectId, body.clientId, body.sequence);
        return reply.code(204).send();
      },
    );
    app.get<{ Params: { previewId: string } }>(`${p}/previews/:previewId/status`, async (req) => ({
      data: previews.get(req.params.previewId),
    }));
    app.get<{ Params: { previewId: string } }>(`${p}/previews/:previewId`, async (req, reply) => {
      const lease = await previews.acquire(req.params.previewId, 'image');
      return streamFile(
        lease.data ?? lease.path!,
        'image/png',
        req.headers.range,
        reply,
        lease.release,
      );
    });
    app.get<{ Params: { assetId: string } }>(
      `${p}/assets/:assetId/thumbnail`,
      async (req, reply) => {
        const lease = await previews.thumbnail(req.params.assetId);
        return streamFile(
          lease.data ?? lease.path!,
          'image/png',
          req.headers.range,
          reply,
          lease.release,
        );
      },
    );
    app.post<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/audio-preview`,
      async (req, reply) => {
        const body = audioPreviewRequestSchema.parse(req.body);
        return reply
          .code(202)
          .send({
            data: await previews.audio(
              req.params.projectId,
              body.revision,
              body.clientId ? { clientId: body.clientId, sequence: body.sequence! } : undefined,
            ),
          });
      },
    );
    app.post<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/audio-preview/cancel`,
      async (req, reply) => {
        const body = previewCancelSchema.parse(req.body);
        id.parse(req.params.projectId);
        previews.cancelAudio(req.params.projectId, body.clientId, body.sequence);
        return reply.code(204).send();
      },
    );
    app.get<{ Params: { previewId: string } }>(
      `${p}/audio-previews/:previewId/status`,
      async (req) => ({ data: previews.get(req.params.previewId) }),
    );
    app.get<{ Params: { previewId: string } }>(
      `${p}/audio-previews/:previewId`,
      async (req, reply) => {
        const lease = await previews.acquire(req.params.previewId, 'audio');
        return streamFile(
          lease.data ?? lease.path!,
          'audio/mp4',
          req.headers.range,
          reply,
          lease.release,
        );
      },
    );
    app.post<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/exports`,
      async (req, reply) => {
        assert(!stopping, 'APP_STOPPING', 'Ứng dụng đang dừng.', 409);
        const body = z
          .object({ expectedRevision: z.number().int().positive(), fileName: z.string() })
          .strict()
          .parse(req.body);
        const key = id.parse(req.headers['idempotency-key']);
        return reply.code(202).send({
          data: await jobs.submit(req.params.projectId, body.expectedRevision, body.fileName, key),
        });
      },
    );
    app.get<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/cli-estimate`,
      async (req) => ({ data: packageEstimate(await ws.project(req.params.projectId)) }),
    );
    app.post<{ Params: { projectId: string } }>(
      `${p}/projects/:projectId/cli-packages`,
      async (req, reply) => {
        assert(!stopping, 'APP_STOPPING', 'Ứng dụng đang dừng.', 409);
        const body = z
          .object({
            expectedRevision: z.number().int().positive(),
            fileName: z.string().default('frames-cli.zip'),
          })
          .strict()
          .parse(req.body);
        return reply.code(202).send({
          data: await jobs.submit(
            req.params.projectId,
            body.expectedRevision,
            body.fileName,
            id.parse(req.headers['idempotency-key']),
            'cli',
          ),
        });
      },
    );
    app.get<{ Params: { jobId: string } }>(`${p}/jobs/:jobId`, async (req) => ({
      data: jobs.get(req.params.jobId),
    }));
    app.post<{ Params: { jobId: string } }>(`${p}/jobs/:jobId/cancel`, async (req) => ({
      data: await jobs.cancel(req.params.jobId),
    }));
    app.get<{ Params: { jobId: string } }>(`${p}/jobs/:jobId/events`, async (req, reply) => {
      jobs.get(req.params.jobId);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      const write = (job: ExportJob) => {
        if (job.id === req.params.jobId && !reply.raw.destroyed)
          reply.raw.write(
            `id: ${job.sequence}\nevent: job-status\ndata: ${JSON.stringify(job)}\n\n`,
          );
      };
      write(jobs.get(req.params.jobId));
      jobs.on('status', write);
      const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
      reply.raw.once('close', () => {
        clearInterval(heartbeat);
        jobs.off('status', write);
      });
    });
    for (const action of ['result', 'download'])
      app.get<{ Params: { jobId: string } }>(`${p}/jobs/:jobId/${action}`, async (req, reply) => {
        const path = await jobs.resultPath(req.params.jobId),
          job = jobs.get(req.params.jobId);
        if (action === 'download')
          reply.header(
            'Content-Disposition',
            `attachment; filename="${job.kind === 'cli' ? 'frames-cli.zip' : 'video.mp4'}"; filename*=UTF-8''${encodeURIComponent(job.fileName)}`,
          );
        const release = jobs.acquireReader(job.id);
        return streamFile(path, job.result!.mime, req.headers.range, reply, release);
      });
    app.delete<{ Params: { jobId: string } }>(`${p}/jobs/:jobId/result`, async (req, reply) => {
      await jobs.deleteResult(req.params.jobId);
      return reply.code(204).send();
    });
    app.get(`${p}/storage`, async () => ({
      data: { ...(await quota.info()), path: ws.root, cache: previews.cacheStats },
    }));
    app.post(`${p}/storage/clear-cache`, async () => {
      await previews.clearCache();
      return { data: { cleared: true } };
    });
    app.post(`${p}/app/shutdown`, async (req, reply) => {
      const body = z
        .object({ cancelActiveJob: z.boolean().default(false), jobId: id.optional() })
        .strict()
        .parse(req.body);
      const active = jobs.activeJob;
      assert(
        !active || (body.cancelActiveJob && body.jobId === active.id),
        'ACTIVE_JOB',
        'Cần xác nhận hủy tác vụ đang chạy.',
        409,
      );
      stopping = true;
      reply.raw.once('finish', () => {
        setImmediate(() => {
          void app.close();
        });
      });
      return reply.code(202).send({ data: { stopping: true } });
    });
    app.addHook('onClose', async () => {
      clearInterval(expireTimer);
      const stoppingPreviews = previews.shutdown();
      await jobs.shutdown();
      await scheduler.shutdown();
      await stoppingPreviews;
      await imports.shutdown();
      await maintenance;
      await diagnostics.idle();
      await previews.idle();
      await ws.close();
    });
    const webRoot = process.env.WEB_ROOT || resolve(config.root, 'dist/web');
    if (await stat(webRoot).catch(() => null))
      await app.register(staticFiles, { root: webRoot, prefix: '/' });
    else
      app.get('/', async (_req, reply) =>
        reply
          .type('text/html')
          .send(
            '<html lang="vi"><body><h1>Frame to Video Studio</h1><p>Frontend chưa build. Chạy pnpm build.</p></body></html>',
          ),
      );
    return { app, ws, imports, jobs, previews, engine, projects };
  } catch (error) {
    clearInterval(expireTimer);
    await ws.close();
    throw error;
  }
}

async function streamFile(
  path: string | Buffer,
  mime: string,
  range: string | undefined,
  reply: import('fastify').FastifyReply,
  release = () => {},
) {
  const response = await mediaResponse(path, mime, range, release);
  reply.raw.once('close', response.dispose);
  reply.raw.once('finish', response.dispose);
  try {
    return reply.code(response.status).headers(response.headers).send(response.body);
  } catch (error) {
    response.dispose();
    throw error;
  }
}
