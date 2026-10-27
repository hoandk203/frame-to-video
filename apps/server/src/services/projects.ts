import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import {
  id,
  projectConfigSchema,
  projectSchema,
  safeRelativePath,
  type Project,
  type ProjectConfig,
} from '../../../../packages/contracts/src/index.js';
import { Workspace, atomicJSON } from '../storage/workspace.js';
import type { Imports } from './imports.js';
import type { Exports } from '../jobs/exports.js';
import { assert } from '../errors.js';
import { AppError } from '../errors.js';

export class Projects {
  constructor(
    private ws: Workspace,
    private imports: Imports,
    private jobs: Exports,
    private maxFrames: number,
  ) {}

  /** Finish deletes committed by directory rename before a previous crash. */
  async init() {
    await mkdir(this.ws.path('trash'), { recursive: true });
    let recoveredDeletion = false;
    for (const entry of await readdir(this.ws.path('trash'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !id.safeParse(entry.name).success) continue;
      await this.ws.writer.run(async () => {
        await this.jobs.removeProjectJobs(entry.name);
        await rm(this.ws.path('trash', entry.name), { recursive: true, force: true });
      });
      recoveredDeletion = true;
    }
    if (recoveredDeletion) await this.imports.collectGarbage();
  }

  async exportConfig(projectId: string): Promise<ProjectConfig> {
    return this.ws.writer.run(async () => {
      const project = await this.ws.project(projectId);
      const sources = new Map<string, ProjectConfig['sources'][number]>();
      for (const frame of project.frames)
        sources.set(frame.assetId, {
          assetId: frame.assetId,
          kind: 'frames',
          sha256: frame.sha256,
        });
      if (project.audio) {
        const hash = project.audio.sha256 ?? this.imports.metadata(project.audio.assetId)?.sha256;
        assert(
          hash,
          'SOURCE_MISSING',
          'Không có định danh nội dung cho nhạc. Chọn lại nguồn trước khi tải cấu hình.',
          422,
        );
        sources.set(project.audio.assetId, {
          assetId: project.audio.assetId,
          kind: 'audio',
          sha256: hash,
        });
      }
      return projectConfigSchema.parse({
        format: 'frame-to-video-studio',
        schemaVersion: 1,
        project,
        sources: [...sources.values()],
      });
    });
  }

  async open(projectId: string) {
    return this.ws.writer.run(async () => {
      const project = await this.ws.project(projectId);
      if (this.jobs.isProjectBusy(projectId)) return project;
      let changed = false;
      for (const frame of project.frames) {
        let available = false;
        try {
          available = (await this.imports.asset(frame.assetId)).sha256 === frame.sha256;
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            !['SOURCE_MISSING', 'SOURCE_CHANGED'].includes(error.code)
          )
            throw error;
        }
        const status = available ? 'valid' : 'missing';
        if (frame.status !== status) {
          frame.status = status;
          changed = true;
        }
      }
      if (project.audio) {
        let available = false;
        try {
          const asset = await this.imports.asset(project.audio.assetId);
          available =
            asset.kind === 'audio' &&
            (!project.audio.sha256 || asset.sha256 === project.audio.sha256);
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            !['SOURCE_MISSING', 'SOURCE_CHANGED'].includes(error.code)
          )
            throw error;
        }
        const status = available ? 'valid' : 'missing';
        if ((project.audio.status ?? 'valid') !== status) {
          project.audio.status = status;
          changed = true;
        }
      }
      if (changed) {
        project.revision++;
        project.updatedAt = new Date().toISOString();
        await atomicJSON(
          this.ws.objectPath('projects', projectId, 'project.json'),
          projectSchema.parse(project),
        );
      }
      return project;
    });
  }

  async importConfig(raw: unknown) {
    const config = projectConfigSchema.parse(raw);
    assert(
      config.project.frames.length <= this.maxFrames,
      'UPLOAD_LIMIT_EXCEEDED',
      'Cấu hình có quá nhiều frame.',
      413,
    );
    assert(
      new Set(config.sources.map((source) => source.assetId)).size === config.sources.length,
      'INVALID_PROJECT_CONFIG',
      'Định danh nguồn bị trùng.',
      422,
    );
    assert(
      new Set(config.project.frames.map((frame) => frame.id)).size === config.project.frames.length,
      'INVALID_PROJECT_CONFIG',
      'Định danh frame bị trùng.',
      422,
    );
    const descriptions = new Map(config.sources.map((source) => [source.assetId, source]));
    for (const frame of config.project.frames) {
      safeRelativePath.parse(frame.relativePath);
      const source = descriptions.get(frame.assetId);
      assert(
        source?.kind === 'frames' && source.sha256 === frame.sha256,
        'INVALID_PROJECT_CONFIG',
        'Định danh nguồn ảnh không khớp.',
        422,
      );
    }
    if (config.project.audio)
      assert(
        descriptions.get(config.project.audio.assetId)?.kind === 'audio',
        'INVALID_PROJECT_CONFIG',
        'Thiếu định danh nguồn nhạc.',
        422,
      );
    return this.ws.writer.run(async () => {
      const now = new Date().toISOString();
      const project: Project = structuredClone(config.project);
      project.id = randomUUID();
      project.revision = 1;
      project.createdAt = now;
      project.updatedAt = now;
      delete project.lastImportId;
      const resolved = new Map<string, Awaited<ReturnType<Imports['findByHash']>>>();
      const resolveSource = async (assetId: string) => {
        const source = descriptions.get(assetId)!;
        const key = `${source.kind}:${source.sha256}`;
        if (!resolved.has(key))
          resolved.set(key, await this.imports.findByHash(source.sha256, source.kind));
        return resolved.get(key)!;
      };
      for (const frame of project.frames) {
        frame.id = randomUUID();
        const asset = await resolveSource(frame.assetId);
        if (asset?.image) {
          frame.assetId = asset.id;
          frame.status = 'valid';
          frame.fileSize = asset.fileSize;
          Object.assign(frame, asset.image);
        } else {
          frame.assetId = randomUUID();
          frame.status = 'missing';
        }
      }
      if (project.audio) {
        const description = descriptions.get(project.audio.assetId)!;
        const asset = await resolveSource(project.audio.assetId);
        project.audio = {
          ...project.audio,
          assetId: asset?.id ?? randomUUID(),
          sha256: description.sha256,
          status: asset ? 'valid' : 'missing',
          ...(asset?.audio ? { durationUs: asset.audio.durationUs } : {}),
        };
      }
      const checked = projectSchema.parse(project);
      await this.ws.publishProject(checked);
      return checked;
    });
  }

  async remove(projectId: string, expectedRevision: number) {
    id.parse(projectId);
    await this.ws.writer.run(async () => {
      const project = await this.ws.project(projectId);
      assert(project.revision === expectedRevision, 'REVISION_CONFLICT', 'Dự án đã thay đổi.', 409);
      assert(
        !this.imports.hasOpenImport(projectId),
        'IMPORT_BUSY',
        'Hãy hoàn tất hoặc hủy nhập trước khi xóa dự án.',
        409,
      );
      const finishDelete = this.jobs.beginProjectDeletion(projectId);
      try {
        // Rename is the delete commit. Recovery can finish the rest after a crash.
        await mkdir(this.ws.path('trash'), { recursive: true });
        await rename(this.ws.path('projects', projectId), this.ws.path('trash', projectId));
        await this.jobs.removeProjectJobs(projectId);
        await rm(this.ws.path('trash', projectId), { recursive: true, force: true });
      } finally {
        finishDelete();
      }
    });
    return this.imports.collectGarbage();
  }
}
