import {
  ExportSubmission,
  submissionStorage,
  type ExportRequest,
} from './features/export/submission.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as Dialog from '@radix-ui/react-dialog';
import type { Project, VideoSettings, ExportJob } from '../../../packages/contracts/src/index.js';
import { naturalCompare } from '../../../packages/contracts/src/index.js';
import { api, post, connect, sleep, previewBlob, APIError } from './api.js';
import { useStudio } from './store.js';
import './styles.css';
import { ProjectTools } from './features/projects/ProjectTools.js';
import { mergeJobUpdate } from './features/export/job-state.js';
import { CliExportButton } from './features/export/CliExportButton.js';

interface UploadSession {
  id: string;
  files: {
    fileId: string;
    clientFileId: string;
    name: string;
    status: string;
    error?: { message: string };
  }[];
}
interface Preview {
  id: string;
  revision: number;
  status: string;
  error?: { message: string };
  imageUrl?: string;
  mediaUrl?: string;
}
const fmt = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const bytes = (n: number) =>
  n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GiB` : `${(n / 1048576).toFixed(1)} MiB`;
const statusText: Record<string, string> = {
  validating: 'Kiểm tra đầu vào',
  preparing: 'Chuẩn bị xuất',
  encoding: 'Đang mã hóa',
  finalizing: 'Xác minh video',
  completed: 'Video đã sẵn sàng',
  failed: 'Xuất không thành công',
  canceled: 'Đã hủy',
  canceling: 'Đang hủy',
  interrupted: 'Bị gián đoạn',
};

function App() {
  const { project, job, currentFrame, busy, error, set } = useStudio();
  const [engine, setEngine] = useState<{
    ready: boolean;
    version?: string | null;
    error?: { message: string } | null;
  } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState<VideoSettings | null>(null);
  const [session, setSession] = useState<UploadSession | null>(null);
  const [uploadProgress, setUploadProgress] = useState('');
  const [outputName, setOutputName] = useState('output.mp4');
  const [exportSubmission] = useState(() => new ExportSubmission(submissionStorage()));
  const [pendingExport, setPendingExport] = useState(() => exportSubmission.pending);
  const [preview, setPreview] = useState('');
  const [previewMode, setPreviewMode] = useState<'interactive' | 'output-check'>('interactive');
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [audioURL, setAudioURL] = useState('');
  const [storage, setStorage] = useState<{
    path: string;
    usage: number;
    quota: number;
    cache: { memoryBytes: number; diskBytes: number; memoryLimit: number; diskLimit: number };
  } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [stopped, setStopped] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null),
    directoryInput = useRef<HTMLInputElement>(null),
    audioInput = useRef<HTMLInputElement>(null);
  const imageImportMode = useRef<'replace' | 'append' | 'relink'>('replace');
  const audioImportMode = useRef<'replace' | 'relink'>('replace');
  const audioRef = useRef<HTMLAudioElement>(null);
  const uploadFiles = useRef(new Map<string, File>());
  const previewCache = useRef(new Map<string, { url: string; pixels: number; touched: number }>());
  const pendingPreview = useRef(
    new Map<
      string,
      { promise: Promise<string | null>; sequence: number; intent: 'seek' | 'prefetch' }
    >(),
  );
  const [previewClientId] = useState(() => crypto.randomUUID());
  const previewSequence = useRef(0);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const advancePreviewSelection = useCallback(() => {
    const sequence = ++previewSequence.current;
    setPreviewEpoch(sequence);
    const projectId = useStudio.getState().project?.id;
    if (projectId && sequence > 1)
      void post(`/projects/${projectId}/previews/cancel`, {
        clientId: previewClientId,
        sequence: sequence - 1,
      }).catch(() => {});
  }, [previewClientId]);
  const prefetching = useRef(false);
  const manualSeek = useRef(false);
  const generation = useRef(0),
    audioGeneration = useRef(0),
    playTime = useRef(0),
    lastClock = useRef(0);
  useEffect(() => {
    setPreview('');
    advancePreviewSelection();
    return () => {
      generation.current++;
      const sequence = ++previewSequence.current;
      if (project?.id)
        void post(`/projects/${project.id}/previews/cancel`, {
          clientId: previewClientId,
          sequence,
        }).catch(() => {});
      for (const entry of previewCache.current.values()) URL.revokeObjectURL(entry.url);
      previewCache.current.clear();
      pendingPreview.current.clear();
    };
  }, [project?.id, project?.revision, stopped, advancePreviewSelection, previewClientId]);
  const active = !!job && !['completed', 'failed', 'canceled', 'interrupted'].includes(job.status);
  const locked = busy || active || stopped || !!pendingExport;
  const run = async (fn: () => Promise<unknown>) => {
    set({ error: null });
    try {
      await fn();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  const selectProject = useCallback(
    (p: Project) => {
      const current = useStudio.getState();
      const differentProject = current.project?.id !== p.id;
      const changed = differentProject || current.project?.revision !== p.revision;
      if (changed) generation.current++;
      else if (current.currentFrame !== 0) advancePreviewSelection();
      setPlaying(false);
      if (changed || current.currentFrame !== 0) setPreview('');
      if (differentProject) {
        setSession(null);
        setUploadProgress('');
      }
      set({ project: p, currentFrame: 0, job: differentProject ? null : useStudio.getState().job });
      setForm(structuredClone(p.video));
      localStorage.setItem('ftvs-project', p.id);
    },
    [set, advancePreviewSelection],
  );
  useEffect(() => {
    void run(async () => {
      await connect();
      const list = await api<Project[]>('/projects');
      setProjects(list);
      const p =
        list.find((p) => p.id === exportSubmission.pending?.request.projectId) ??
        list.find((p) => p.id === localStorage.getItem('ftvs-project')) ??
        list[0] ??
        (await post<Project>('/projects', { name: 'Dự án mới' }));
      selectProject(await api<Project>(`/projects/${p.id}`));
      setEngine(await api('/engine'));
      const saved = exportSubmission.pending;
      if (saved) await submitExport(saved.request);
    });
  }, []);
  useEffect(() => {
    if (!project) return;
    let canceled = false;
    void api<UploadSession[]>(`/projects/${project.id}/imports`)
      .then((sessions) => {
        if (!canceled) setSession(sessions[0] ?? null);
      })
      .catch(() => {});
    void api<ExportJob[]>(`/projects/${project.id}/jobs`)
      .then((list) => {
        if (!canceled && list[0]) set({ job: mergeJobUpdate(useStudio.getState().job, list[0]) });
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [project?.id]);
  useEffect(() => {
    if (!job || !active) return;
    let canceled = false;
    const receive = (updated: ExportJob) => {
      if (!canceled) set({ job: mergeJobUpdate(useStudio.getState().job, updated) });
    };
    const events = new EventSource(`/api/v1/jobs/${job.id}/events`);
    events.addEventListener('job-status', (event) =>
      receive(JSON.parse((event as MessageEvent).data)),
    );
    const timer = setInterval(() => {
      void api<ExportJob>(`/jobs/${job.id}`)
        .then(receive)
        .catch(() => {});
    }, 1000);
    return () => {
      canceled = true;
      events.close();
      clearInterval(timer);
    };
  }, [job?.id, active]);
  useEffect(() => {
    if (directoryInput.current) directoryInput.current.setAttribute('webkitdirectory', '');
  }, []);

  const patch = async (data: Record<string, unknown>) => {
    if (!project) return;
    const next = await api<Project>(`/projects/${project.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: project.revision, ...data }),
    });
    generation.current++;
    setPlaying(false);
    setPreview('');
    set({ project: next });
    setForm(structuredClone(next.video));
    return next;
  };
  const fetchPreview = useCallback(
    async (
      p: Project,
      index: number,
      mode: 'interactive' | 'output-check',
      gen: number,
      sequence: number,
      intent: 'seek' | 'prefetch' = 'seek',
    ) => {
      if (generation.current !== gen || previewSequence.current !== sequence) return null;
      const key = `${p.id}:${p.revision}:${index}:${mode}`;
      const found = previewCache.current.get(key);
      if (found) {
        found.touched = performance.now();
        return found.url;
      }
      const existing = pendingPreview.current.get(key);
      if (existing?.sequence === sequence && (intent === 'prefetch' || existing.intent === 'seek'))
        return existing.promise;
      const task = (async () => {
        let image: Blob | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const request = await post<Preview>(`/projects/${p.id}/previews`, {
              revision: p.revision,
              frameIndex: index,
              mode,
              clientId: previewClientId,
              sequence,
              intent,
            });
            let status = request;
            for (let i = 0; status.status === 'pending' && i < 600; i++) {
              if (generation.current !== gen || previewSequence.current !== sequence) return null;
              await sleep(100);
              status = await api<Preview>(`/previews/${request.id}/status`);
            }
            if (generation.current !== gen || previewSequence.current !== sequence) return null;
            if (status.status !== 'ready')
              throw new Error(status.error?.message ?? 'Preview chưa sẵn sàng.');
            image = await previewBlob(status.imageUrl!);
            break;
          } catch (error) {
            if (generation.current !== gen || previewSequence.current !== sequence) return null;
            if (attempt || !(error instanceof APIError) || ![404, 410].includes(error.status))
              throw error;
          }
        }
        if (generation.current !== gen || previewSequence.current !== sequence || !image)
          return null;
        const url = URL.createObjectURL(image);
        const img = new Image();
        img.src = url;
        try {
          await img.decode();
        } catch (error) {
          URL.revokeObjectURL(url);
          throw error;
        }
        if (generation.current !== gen || previewSequence.current !== sequence) {
          URL.revokeObjectURL(url);
          return null;
        }
        previewCache.current.set(key, {
          url,
          pixels: img.naturalWidth * img.naturalHeight * 4,
          touched: performance.now(),
        });
        let budget = [...previewCache.current.values()].reduce((n, v) => n + v.pixels, 0);
        while (budget > 64 * 1048576 && previewCache.current.size > 1) {
          const first = [...previewCache.current.entries()].sort(
            (a, b) => a[1].touched - b[1].touched,
          )[0]!;
          budget -= first[1].pixels;
          URL.revokeObjectURL(first[1].url);
          previewCache.current.delete(first[0]);
        }
        return url;
      })();
      const ticket = { promise: task, sequence, intent };
      pendingPreview.current.set(key, ticket);
      try {
        return await task;
      } finally {
        if (pendingPreview.current.get(key) === ticket) pendingPreview.current.delete(key);
      }
    },
    [previewClientId],
  );
  useEffect(() => {
    if (!project?.frames.length || project.frames[currentFrame]?.status !== 'valid' || stopped) {
      setPreview('');
      setBuffering(false);
      return;
    }
    let canceled = false;
    const gen = generation.current;
    const sequence = previewSequence.current;
    const timer = setTimeout(
      () => {
        setBuffering(true);
        void fetchPreview(project, currentFrame, previewMode, gen, sequence)
          .then((url) => {
            if (!canceled && url) {
              setPreview(url);
              manualSeek.current = false;
              setBuffering(false);
            }
          })
          .catch((e) => {
            if (!canceled) {
              setBuffering(false);
              setPlaying(false);
              set({ error: String(e) });
            }
          });
      },
      manualSeek.current ? 100 : playing ? 0 : 100,
    );
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [
    project?.id,
    project?.revision,
    currentFrame,
    previewMode,
    stopped,
    previewEpoch,
    fetchPreview,
  ]);
  useEffect(() => {
    const gen = ++audioGeneration.current;
    setAudioURL('');
    if (!project?.audio || project.audio.status === 'missing' || !project.frames.length || stopped)
      return;
    void run(async () => {
      try {
        let result = await post<Preview>(`/projects/${project.id}/audio-preview`, {
          revision: project.revision,
          clientId: previewClientId,
          sequence: gen,
        });
        while (result.status === 'pending' && audioGeneration.current === gen) {
          await sleep(200);
          result = await api(`/audio-previews/${result.id}/status`);
        }
        if (audioGeneration.current !== gen) return;
        if (result.status !== 'ready')
          throw new Error(result.error?.message ?? 'Không tạo được preview nhạc.');
        setAudioURL(result.mediaUrl!);
      } catch (error) {
        if (audioGeneration.current === gen) throw error;
      }
    });
    return () => {
      audioGeneration.current++;
      audioRef.current?.pause();
      void post(`/projects/${project.id}/audio-preview/cancel`, {
        clientId: previewClientId,
        sequence: gen,
      }).catch(() => {});
    };
  }, [project?.revision, project?.id, stopped, previewClientId]);
  useEffect(() => {
    if (!playing || !project || previewMode !== 'interactive') {
      audioRef.current?.pause();
      return;
    }
    let canceled = false,
      animation = 0;
    const gen = generation.current;
    const tick = () => {
      if (canceled || gen !== generation.current) return;
      const now = performance.now(),
        audio = audioRef.current;
      if (!buffering) {
        if (audioURL && audio && audio.paused) {
          audio.currentTime = playTime.current;
          void audio.play().catch(() => setPlaying(false));
        }
        playTime.current =
          audioURL && audio
            ? audio.currentTime
            : playTime.current + (now - lastClock.current) / 1000;
        const next = Math.floor(playTime.current * project.video.fps);
        if (next >= project.frames.length) {
          setPlaying(false);
          advancePreviewSelection();
          playTime.current = 0;
          set({ currentFrame: 0 });
          return;
        }
        set({ currentFrame: next });
        const ahead = Math.min(project.frames.length, next + 8);
        // Sequential prefetch bounds requests; output-check never enters this queue.
        if (!prefetching.current) {
          prefetching.current = true;
          const sequence = previewSequence.current;
          void (async () => {
            for (
              let i = next + 1;
              i < ahead && !canceled && previewSequence.current === sequence;
              i++
            )
              await fetchPreview(project, i, 'interactive', gen, sequence, 'prefetch');
          })()
            .catch(() => {})
            .finally(() => {
              prefetching.current = false;
            });
        }
      } else audio?.pause();
      lastClock.current = now;
      animation = requestAnimationFrame(tick);
    };
    lastClock.current = performance.now();
    animation = requestAnimationFrame(tick);
    return () => {
      canceled = true;
      cancelAnimationFrame(animation);
      audioRef.current?.pause();
    };
  }, [playing, buffering, audioURL, project?.revision, previewMode]);

  async function submitExport(request: ExportRequest) {
    setPlaying(false);
    set({ busy: true, error: null });
    try {
      const next = await exportSubmission.submit(request, (input, key) =>
        post<ExportJob>(
          `/projects/${input.projectId}/${input.kind === 'video' ? 'exports' : 'cli-packages'}`,
          { expectedRevision: input.expectedRevision, fileName: input.fileName },
          key,
        ),
      );
      const current = useStudio.getState();
      if (current.project?.id === next.projectId) set({ job: mergeJobUpdate(current.job, next) });
    } finally {
      setPendingExport(exportSubmission.pending);
      set({ busy: false });
    }
  }

  async function importMedia(
    files: File[],
    purpose: 'frames' | 'audio',
    mode: 'replace' | 'append' | 'relink' = 'replace',
  ) {
    if (!project || !files.length || locked) return;
    setPlaying(false);
    set({ busy: true, error: null });
    uploadFiles.current.clear();
    try {
      if (session) await api(`/imports/${session.id}`, { method: 'DELETE' });
      setSession(null);
      const manifest = files.map((file) => {
        const clientFileId = crypto.randomUUID();
        uploadFiles.current.set(clientFileId, file);
        return {
          clientFileId,
          name: file.name,
          relativePath: file.webkitRelativePath || file.name,
          size: file.size,
        };
      });
      let incoming = await post<UploadSession>(
        `/projects/${project.id}/imports`,
        {
          expectedRevision: project.revision,
          purpose,
          mode,
          files: manifest,
        },
        crypto.randomUUID(),
      );
      setSession(incoming);
      let next = 0,
        completed = 0;
      const worker = async () => {
        while (next < incoming.files.length) {
          const entry = incoming.files[next++]!,
            file = uploadFiles.current.get(entry.clientFileId)!;
          setUploadProgress(
            `${completed}/${files.length} file · ${bytes(files.reduce((n, f) => n + f.size, 0))}`,
          );
          const form = new FormData();
          form.append('file', file);
          try {
            await api(`/imports/${incoming.id}/files/${entry.fileId}`, {
              method: 'PUT',
              body: form,
            });
          } catch {
            /* status includes actionable per-file error */
          }
          completed++;
        }
      };
      await Promise.all([worker(), worker()]);
      incoming = await api(`/imports/${incoming.id}`);
      setSession(incoming);
      setUploadProgress(`${completed}/${files.length} file đã xử lý`);
      if (incoming.files.every((f) => f.status === 'valid')) await finalizeImport(incoming);
    } finally {
      set({ busy: false });
    }
  }
  async function finalizeImport(incoming: UploadSession) {
    const current = useStudio.getState().project!;
    const next = await post<Project>(`/imports/${incoming.id}/finalize`, {
      expectedRevision: current.revision,
    });
    selectProject(next);
    setSession(null);
    setUploadProgress('');
  }
  const seek = (index: number) => {
    advancePreviewSelection();
    manualSeek.current = true;
    setBuffering(true);
    setPreview('');
    audioRef.current?.pause();
    playTime.current = index / (project?.video.fps ?? 24);
    if (audioRef.current) audioRef.current.currentTime = playTime.current;
    set({ currentFrame: index });
  };
  const duration = project ? project.frames.length / project.video.fps : 0;
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            ▥
          </span>
          <div>
            <h1>
              Frame to Video <span>Studio</span>
            </h1>
            <p>Chuỗi ảnh của bạn. Video trên máy bạn.</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`badge ${engine?.ready ? 'ready' : 'pending'}`}>
            {engine?.ready ? '● Engine sẵn sàng' : '○ Engine chưa sẵn sàng'}
          </span>
          <button
            className="quiet"
            onClick={() => void run(async () => setStorage(await api('/storage')))}
          >
            Dữ liệu local
          </button>
          <button className="quiet" onClick={() => setShutdownOpen(true)}>
            Dừng ứng dụng
          </button>
        </div>
      </header>
      <main>
        {pendingExport && (
          <div className="notice" role="status">
            <p>
              Chưa nhận được xác nhận cho yêu cầu xuất “{pendingExport.request.fileName}”. Kết nối
              lại để xem đúng tác vụ đã yêu cầu.
            </p>
            <button
              disabled={busy || stopped}
              onClick={() => void run(() => submitExport(pendingExport.request))}
            >
              {busy ? 'Đang kết nối…' : 'Thử lại yêu cầu xuất'}
            </button>
          </div>
        )}
        <div className="workspace-heading">
          <div>
            <p className="eyebrow">KHÔNG GIAN LÀM VIỆC</p>
            <h2>{project?.name ?? 'Đang kết nối…'}</h2>
          </div>
          <div className="project-controls">
            <select
              aria-label="Mở dự án"
              disabled={locked}
              value={project?.id ?? ''}
              onChange={(e) =>
                void run(async () => selectProject(await api(`/projects/${e.target.value}`)))
              }
            >
              {project && !projects.some((p) => p.id === project.id) && (
                <option value={project.id}>{project.name}</option>
              )}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              disabled={locked}
              onClick={() =>
                void run(async () => {
                  const p = await post<Project>('/projects', {
                    name: `Dự án ${new Date().toLocaleDateString('vi')}`,
                  });
                  setProjects(await api('/projects'));
                  selectProject(p);
                })
              }
            >
              + Dự án mới
            </button>
          </div>
        </div>
        {project && (
          <ProjectTools
            key={project.id}
            project={project}
            locked={locked}
            onError={(message) => set({ error: message })}
            onLoaded={async (next) => {
              setProjects(await api('/projects'));
              selectProject(next);
            }}
            onRemoved={async () => {
              const remaining = await api<Project[]>('/projects');
              const next =
                remaining[0] ?? (await post<Project>('/projects', { name: 'Dự án mới' }));
              setProjects(await api('/projects'));
              selectProject(next);
            }}
          />
        )}
        {error && (
          <div role="alert" className="notice error">
            {error}
            <button aria-label="Đóng thông báo" onClick={() => set({ error: null })}>
              ×
            </button>
          </div>
        )}
        {stopped && (
          <div role="status" className="notice">
            Ứng dụng đã dừng. Bấm Start.exe để mở lại.
          </div>
        )}
        <div className="workspace-grid">
          <aside>
            <section className="panel">
              <div className="section-heading">
                <span className="step">01</span>
                <h3>Nguồn hình ảnh</h3>
                <span className="count">{project?.frames.length ?? 0} ảnh</span>
              </div>
              <div
                className={`drop-zone ${locked ? 'disabled' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!locked) void run(() => importMedia([...e.dataTransfer.files], 'frames'));
                }}
              >
                <span className="upload-symbol" aria-hidden="true">
                  ↑
                </span>
                <strong>Thả bộ ảnh vào đây</strong>
                <p>PNG, JPG, WebP tĩnh · sắp xếp theo tên</p>
                <div className="button-row">
                  <button
                    disabled={locked}
                    onClick={() => {
                      imageImportMode.current = 'replace';
                      filesInput.current?.click();
                    }}
                  >
                    Chọn ảnh
                  </button>
                  <button
                    className="quiet"
                    disabled={locked}
                    onClick={() => {
                      imageImportMode.current = 'replace';
                      directoryInput.current?.click();
                    }}
                  >
                    Chọn thư mục
                  </button>
                </div>
              </div>
              <input
                ref={filesInput}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={(e) => {
                  void run(() =>
                    importMedia([...(e.target.files ?? [])], 'frames', imageImportMode.current),
                  );
                  e.target.value = '';
                }}
              />
              <input
                ref={directoryInput}
                hidden
                type="file"
                multiple
                onChange={(e) => {
                  void run(() =>
                    importMedia([...(e.target.files ?? [])], 'frames', imageImportMode.current),
                  );
                  e.target.value = '';
                }}
              />
              {!!project?.frames.length && (
                <div className="button-row">
                  <button
                    disabled={locked}
                    onClick={() => {
                      imageImportMode.current = 'append';
                      filesInput.current?.click();
                    }}
                  >
                    + Thêm ảnh
                  </button>
                  {project.frames.some((frame) => frame.status === 'missing') && (
                    <button
                      disabled={locked}
                      onClick={() => {
                        imageImportMode.current = 'relink';
                        directoryInput.current?.click();
                      }}
                    >
                      Liên kết thư mục ảnh thiếu
                    </button>
                  )}
                </div>
              )}
              {project?.frames.some((frame) => frame.status === 'missing') && (
                <p className="notice" role="status">
                  Cấu hình còn thiếu ảnh. Chọn lại file có cùng nội dung để giữ thứ tự frame.
                </p>
              )}
              {uploadProgress && (
                <p aria-live="polite" className="helper">
                  {uploadProgress}
                </p>
              )}
              {session && !busy && (
                <div className="upload-errors">
                  {session.files
                    .filter((f) => f.status !== 'valid')
                    .map((f) => (
                      <div key={f.fileId}>
                        <span>
                          {f.name}: {f.error?.message ?? f.status}
                        </span>
                        <button
                          onClick={() =>
                            void run(async () => {
                              const file = uploadFiles.current.get(f.clientFileId);
                              if (!file)
                                throw new Error('Hãy chọn lại file sau khi tải lại trang.');
                              const form = new FormData();
                              form.append('file', file);
                              await api(`/imports/${session.id}/files/${f.fileId}`, {
                                method: 'PUT',
                                body: form,
                              });
                              setSession(await api(`/imports/${session.id}`));
                            })
                          }
                        >
                          Thử lại
                        </button>
                        <button
                          onClick={() =>
                            void run(async () =>
                              setSession(
                                await api(`/imports/${session.id}/files/${f.fileId}`, {
                                  method: 'DELETE',
                                }),
                              ),
                            )
                          }
                        >
                          Bỏ file
                        </button>
                      </div>
                    ))}
                  <div className="button-row">
                    <button onClick={() => void run(() => finalizeImport(session))}>
                      Hoàn tất nhập
                    </button>
                    <button
                      onClick={() =>
                        void run(async () => {
                          await api(`/imports/${session.id}`, { method: 'DELETE' });
                          setSession(null);
                          setUploadProgress('');
                        })
                      }
                    >
                      Hủy nhập
                    </button>
                  </div>
                </div>
              )}
              {!!project?.frames.length && (
                <>
                  <div className="list-toolbar">
                    <span>
                      {bytes(project.frames.reduce((n, f) => n + f.fileSize, 0))} · {fmt(duration)}
                    </span>
                    <button
                      className="quiet"
                      disabled={locked}
                      onClick={() =>
                        void run(() =>
                          patch({ order: [...project.frames].reverse().map((f) => f.id) }),
                        )
                      }
                    >
                      Đảo thứ tự
                    </button>
                    <button
                      className="quiet"
                      disabled={locked}
                      onClick={() =>
                        void run(() =>
                          patch({
                            order: [...project.frames]
                              .sort((a, b) => naturalCompare(a.originalName, b.originalName))
                              .map((f) => f.id),
                          }),
                        )
                      }
                    >
                      Theo tên
                    </button>
                  </div>
                  <FrameList
                    project={project}
                    current={currentFrame}
                    select={seek}
                    locked={locked}
                    remove={(frameId) => void run(() => patch({ removedFrameIds: [frameId] }))}
                  />
                </>
              )}
            </section>
            {form && (
              <section className="panel">
                <div className="section-heading">
                  <span className="step">02</span>
                  <h3>Hình ảnh & khung hình</h3>
                </div>
                <fieldset disabled={locked}>
                  <div className="ratio-group">
                    {(['16:9', '9:16'] as const).map((ratio) => (
                      <button
                        key={ratio}
                        aria-pressed={form.aspectRatio === ratio}
                        className={form.aspectRatio === ratio ? 'selected' : ''}
                        onClick={() => setForm({ ...form, aspectRatio: ratio })}
                      >
                        {ratio === '16:9' ? '▭ Ngang 16:9' : '▯ Dọc 9:16'}
                      </button>
                    ))}
                  </div>
                  <div className="form-grid">
                    <label>
                      Độ phân giải
                      <select
                        value={form.resolution}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            resolution: e.target.value as VideoSettings['resolution'],
                          })
                        }
                      >
                        <option value="720p">720p · HD</option>
                        <option value="1080p">1080p · Full HD</option>
                        <option value="4k">4K · Ultra HD</option>
                      </select>
                    </label>
                    <label>
                      Tốc độ khung hình
                      <select
                        value={form.fps}
                        onChange={(e) =>
                          setForm({ ...form, fps: Number(e.target.value) as VideoSettings['fps'] })
                        }
                      >
                        {[12, 24, 30, 60].map((fps) => (
                          <option key={fps} value={fps}>
                            {fps} FPS
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    Nền
                    <select
                      value={form.background.mode}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          background: {
                            ...form.background,
                            mode: e.target.value as 'blur' | 'solid',
                          },
                        })
                      }
                    >
                      <option value="blur">Ảnh phóng lớn, làm mờ</option>
                      <option value="solid">Màu đặc</option>
                    </select>
                  </label>
                  <label>
                    Độ mờ nền <span>{form.background.blurStrength}</span>
                    <input
                      type="range"
                      min="0"
                      max="30"
                      value={form.background.blurStrength}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          background: { ...form.background, blurStrength: Number(e.target.value) },
                        })
                      }
                    />
                  </label>
                  <label>
                    Độ sáng nền <span>{Math.round(form.background.brightness * 100)}%</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={form.background.brightness * 100}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          background: {
                            ...form.background,
                            brightness: Number(e.target.value) / 100,
                          },
                        })
                      }
                    />
                  </label>
                  <div className="form-grid">
                    <label>
                      Màu nền/matte
                      <input
                        type="color"
                        value={form.background.matteColor}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            background: { ...form.background, matteColor: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label>
                      Chất lượng
                      <select
                        value={form.encoding.crf}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            encoding: { ...form.encoding, crf: Number(e.target.value) },
                          })
                        }
                      >
                        <option value="18">Cao · CRF 18</option>
                        <option value="23">Cân bằng · CRF 23</option>
                        <option value="28">File nhỏ · CRF 28</option>
                      </select>
                    </label>
                  </div>
                  <button className="wide" onClick={() => void run(() => patch({ video: form }))}>
                    Áp dụng thông số
                  </button>
                </fieldset>
              </section>
            )}
            <section className="panel">
              <div className="section-heading">
                <span className="step">03</span>
                <h3>Nhạc nền</h3>
                <span className="muted">Tùy chọn</span>
              </div>
              <input
                ref={audioInput}
                hidden
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  void run(() =>
                    importMedia([...(e.target.files ?? [])], 'audio', audioImportMode.current),
                  );
                  e.target.value = '';
                }}
              />
              <button
                disabled={locked}
                className="wide"
                onClick={() => {
                  audioImportMode.current = 'replace';
                  audioInput.current?.click();
                }}
              >
                {project?.audio ? 'Thay nhạc nền' : '+ Chọn file âm thanh'}
              </button>
              {project?.audio?.originalName && (
                <p className="helper">Nhạc: {project.audio.originalName}</p>
              )}
              {project?.audio?.status === 'missing' && (
                <div className="notice">
                  <span>Nguồn nhạc còn thiếu.</span>
                  <button
                    disabled={locked}
                    onClick={() => {
                      audioImportMode.current = 'relink';
                      audioInput.current?.click();
                    }}
                  >
                    Liên kết nhạc
                  </button>
                </div>
              )}
              {project?.audio && (
                <fieldset disabled={locked}>
                  <label>
                    Âm lượng <span>{Math.round(project.audio.volume * 100)}%</span>
                    <input
                      type="range"
                      min="0"
                      max="200"
                      defaultValue={project.audio.volume * 100}
                      key={`${project.id}:${project.audio.volume}`}
                      onPointerUp={(e) => {
                        const volume = Number(e.currentTarget.value) / 100;
                        void run(() => patch({ audio: { ...project.audio, volume } }));
                      }}
                    />
                  </label>
                  {project.audio.volume > 1 && (
                    <p className="helper">Âm lượng trên 100% có thể gây méo tiếng.</p>
                  )}
                  <label>
                    Khi nhạc ngắn hơn video
                    <select
                      value={project.audio.shortTrackPolicy}
                      onChange={(e) =>
                        void run(() =>
                          patch({ audio: { ...project.audio, shortTrackPolicy: e.target.value } }),
                        )
                      }
                    >
                      <option value="pad-silence">Thêm khoảng lặng</option>
                      <option value="loop">Lặp nhạc</option>
                    </select>
                  </label>
                  <button className="quiet" onClick={() => void run(() => patch({ audio: null }))}>
                    Xóa nhạc
                  </button>
                </fieldset>
              )}
            </section>
          </aside>
          <div className="main-column">
            <section className="panel preview-panel">
              <div className="section-heading">
                <h3>Xem trước</h3>
                <span className="badge">{project?.video.aspectRatio ?? '16:9'}</span>
                <select
                  aria-label="Chế độ preview"
                  value={previewMode}
                  onChange={(e) => {
                    advancePreviewSelection();
                    setPreview('');
                    setBuffering(true);
                    setPlaying(false);
                    setPreviewMode(e.target.value as typeof previewMode);
                  }}
                >
                  <option value="interactive">Xem trước thu nhỏ</option>
                  <option value="output-check">Kiểm tra frame đầu ra</option>
                </select>
              </div>
              <div
                className="preview-stage"
                tabIndex={0}
                aria-label="Khung xem trước; Space phát hoặc dừng, phím mũi tên chuyển frame"
                onKeyDown={(e) => {
                  if (!project?.frames.length) return;
                  if (e.key === ' ') {
                    e.preventDefault();
                    setPlaying(!playing);
                  }
                  if (e.key === 'ArrowRight')
                    seek(Math.min(currentFrame + 1, project.frames.length - 1));
                  if (e.key === 'ArrowLeft') seek(Math.max(0, currentFrame - 1));
                }}
              >
                {preview ? (
                  <img src={preview} alt={`Frame ${currentFrame + 1} của chuỗi ảnh`} />
                ) : (
                  <div className="empty-preview">
                    <span aria-hidden="true">▧</span>
                    <strong>Biến từng khung hình thành câu chuyện</strong>
                    <p>Thêm bộ ảnh để xem trước video của bạn.</p>
                  </div>
                )}
                {buffering && (
                  <span className="buffering" role="status">
                    Đang chuẩn bị frame…
                  </span>
                )}
              </div>
              <div className="player">
                <button
                  disabled={
                    !project?.frames.length ||
                    project.frames.some((frame) => frame.status !== 'valid') ||
                    locked ||
                    previewMode !== 'interactive' ||
                    (!!project.audio && !audioURL)
                  }
                  aria-label={playing ? 'Tạm dừng' : 'Phát'}
                  onClick={() => setPlaying(!playing)}
                >
                  {playing ? 'Ⅱ' : '▶'}
                </button>
                <button
                  disabled={!project?.frames.length}
                  aria-label="Dừng và về đầu"
                  onClick={() => {
                    setPlaying(false);
                    seek(0);
                  }}
                >
                  ■
                </button>
                <input
                  aria-label="Tua frame"
                  type="range"
                  min="0"
                  max={Math.max(0, (project?.frames.length ?? 0) - 1)}
                  value={currentFrame}
                  disabled={!project?.frames.length}
                  onChange={(e) => seek(Number(e.target.value))}
                />
                <span className="timecode">
                  {fmt(currentFrame / (project?.video.fps ?? 24))} / {fmt(duration)}
                </span>
              </div>
              <div className="preview-meta">
                <span>
                  FRAME {project?.frames.length ? currentFrame + 1 : 0} /{' '}
                  {project?.frames.length ?? 0}
                </span>
                <span>{project?.video.fps ?? 24} FPS · SDR</span>
              </div>
              <audio ref={audioRef} src={audioURL || undefined} preload="auto" hidden />
            </section>
            <section className="panel export-panel">
              <div className="section-heading">
                <span className="step">04</span>
                <h3>Xuất video</h3>
                <span className="badge">MP4 / H.264</span>
              </div>
              <p className="muted">Xử lý hoàn toàn trên máy. Tải kết quả khi video đã sẵn sàng.</p>
              <div className="export-controls">
                <label>
                  Tên file
                  <input
                    value={outputName}
                    disabled={locked}
                    onChange={(e) => setOutputName(e.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={
                    locked ||
                    !engine?.ready ||
                    !project?.frames.length ||
                    project.frames.some((frame) => frame.status !== 'valid') ||
                    project.audio?.status === 'missing'
                  }
                  onClick={() =>
                    void run(async () => {
                      if (!project) return;
                      await submitExport({
                        projectId: project.id,
                        expectedRevision: project.revision,
                        kind: 'video',
                        fileName: outputName,
                      });
                    })
                  }
                >
                  Xuất video ↗
                </button>
                {project && (
                  <CliExportButton
                    project={project}
                    fileName={outputName}
                    disabled={
                      locked ||
                      !project.frames.length ||
                      project.frames.some((frame) => frame.status !== 'valid') ||
                      project.audio?.status === 'missing'
                    }
                    onSubmit={submitExport}
                    onError={(message) => set({ error: message })}
                  />
                )}
              </div>
              {engine && !engine.ready && (
                <p className="notice error">{engine.error?.message ?? 'Engine chưa sẵn sàng.'}</p>
              )}
              {job && (
                <div className={`job-card ${job.status}`}>
                  <div className="job-heading">
                    <strong>
                      {job.kind === 'cli'
                        ? ((
                            {
                              validating: 'Kiểm tra nguồn',
                              preparing: 'Đang chuẩn bị PNG',
                              encoding: 'Đang tạo ZIP',
                              finalizing: 'Kiểm tra gói CLI',
                              completed: 'Gói CLI đã sẵn sàng',
                            } as Record<string, string>
                          )[job.status] ?? statusText[job.status])
                        : statusText[job.status]}
                    </strong>
                    <span>{job.percent}%</span>
                  </div>
                  <progress
                    max="100"
                    value={job.percent}
                    aria-label={
                      job.kind === 'cli' ? 'Tiến trình tạo gói CLI' : 'Tiến trình xuất video'
                    }
                  />
                  <div className="job-detail">
                    <span>
                      {job.kind === 'cli' ? job.processedFrames : job.encodedFrames}/
                      {job.totalFrames} {job.kind === 'cli' ? 'PNG' : 'frame'} ·{' '}
                      {Math.round(job.elapsedMs / 1000)} giây
                    </span>
                    {active && (
                      <button
                        className="quiet"
                        onClick={() =>
                          void run(async () =>
                            set({ job: await post(`/jobs/${job.id}/cancel`, {}) }),
                          )
                        }
                      >
                        Hủy xuất
                      </button>
                    )}
                  </div>
                  {job.error && (
                    <p role="alert" className="error-text">
                      {job.error.message}
                    </p>
                  )}
                  {job.status === 'completed' && job.result && (
                    <>
                      {job.kind === 'video' && (
                        <video
                          className="result-video"
                          controls
                          preload="metadata"
                          src={`/api/v1/jobs/${job.id}/result`}
                        />
                      )}
                      <div className="button-row">
                        <a className="button primary" href={`/api/v1/jobs/${job.id}/download`}>
                          ↓ Tải {job.kind === 'cli' ? 'ZIP' : 'MP4'} · {bytes(job.result.bytes)}
                        </a>
                        <button
                          onClick={() =>
                            void run(async () => {
                              await api(`/jobs/${job.id}/result`, { method: 'DELETE' });
                              set({ job: await api(`/jobs/${job.id}`) });
                            })
                          }
                        >
                          Xóa kết quả
                        </button>
                      </div>
                      <p className="helper">
                        Vị trí tải xuống do trình duyệt quyết định. Bản local vẫn được giữ đến khi
                        bạn xóa.
                      </p>
                    </>
                  )}
                </div>
              )}
            </section>
            <div className="local-note">
              <span aria-hidden="true">◉</span>
              <div>
                <strong>Media ở lại trên máy của bạn</strong>
                <p>Website kết nối backend localhost. Không tải ảnh hoặc nhạc lên Internet.</p>
              </div>
            </div>
          </div>
        </div>
      </main>
      <footer>
        FRAME TO VIDEO STUDIO <span>Local workspace · v0.1.0</span>
      </footer>
      <Dialog.Root
        open={!!storage}
        onOpenChange={(open) => {
          if (!open) setStorage(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>Dữ liệu ứng dụng</Dialog.Title>
            <Dialog.Description>
              Nguồn được copy vào workspace local. File gốc của bạn không bị sửa.
            </Dialog.Description>
            {storage && (
              <>
                <code>{storage.path}</code>
                <p>
                  {bytes(storage.usage)} / {bytes(storage.quota)}
                </p>
                <p className="helper">
                  Cache RAM: {bytes(storage.cache.memoryBytes)} / {bytes(storage.cache.memoryLimit)}
                  . Cache đĩa: {bytes(storage.cache.diskBytes)} / {bytes(storage.cache.diskLimit)}.
                </p>
                <button
                  onClick={() =>
                    void run(async () => {
                      await post('/storage/clear-cache', {});
                      setStorage(await api('/storage'));
                    })
                  }
                >
                  Xóa cache preview
                </button>
                <button
                  onClick={() =>
                    void run(async () => {
                      await post('/storage/collect-garbage', {});
                      setStorage(await api('/storage'));
                    })
                  }
                >
                  Dọn nguồn không còn được dùng
                </button>
                <p className="helper">
                  Giữ nguồn đang có trong dự án, bản backup, lịch sử xuất hoặc đang được xử lý.
                </p>
              </>
            )}
            <Dialog.Close className="quiet">Đóng</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={shutdownOpen} onOpenChange={setShutdownOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>Dừng ứng dụng?</Dialog.Title>
            <Dialog.Description>
              {active
                ? 'Tác vụ đang xuất sẽ bị hủy trước khi backend dừng.'
                : 'Project và video đã hoàn tất được giữ lại. Bấm Start.exe để mở lại.'}
            </Dialog.Description>
            <div className="button-row">
              <button
                className="primary"
                onClick={() =>
                  void run(async () => {
                    await post('/app/shutdown', {
                      cancelActiveJob: active,
                      ...(active ? { jobId: job!.id } : {}),
                    });
                    setShutdownOpen(false);
                    setStopped(true);
                    setPlaying(false);
                  })
                }
              >
                {active ? 'Hủy tác vụ và dừng' : 'Dừng ứng dụng'}
              </button>
              <Dialog.Close>Tiếp tục sử dụng</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
function FrameList({
  project,
  current,
  select,
  locked,
  remove,
}: {
  project: Project;
  current: number;
  select: (index: number) => void;
  locked: boolean;
  remove: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: project.frames.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 60,
    overscan: 5,
  });
  return (
    <div className="frame-list" ref={ref} aria-label="Danh sách frame">
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((row) => {
          const frame = project.frames[row.index]!;
          return (
            <div
              className={`frame-row ${current === row.index ? 'current' : ''}`}
              key={frame.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: row.size,
                transform: `translateY(${row.start}px)`,
              }}
            >
              <button className="frame-select" onClick={() => select(row.index)}>
                <span className="frame-number">{row.index + 1}</span>
                <img
                  loading="lazy"
                  src={
                    frame.status === 'valid'
                      ? `/api/v1/assets/${frame.assetId}/thumbnail`
                      : undefined
                  }
                  alt=""
                />
                <span className="frame-info">
                  <strong>{frame.originalName}</strong>
                  <small>
                    {frame.status === 'missing'
                      ? 'Thiếu nguồn'
                      : `${frame.width} × ${frame.height}`}
                  </small>
                </span>
              </button>
              <button
                disabled={locked}
                className="quiet"
                aria-label={`Bỏ ${frame.originalName}`}
                onClick={() => remove(frame.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
