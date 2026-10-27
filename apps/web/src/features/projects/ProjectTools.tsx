import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Project } from '../../../../../packages/contracts/src/index.js';
import { api, post } from '../../api.js';

interface Props {
  project: Project;
  locked: boolean;
  onLoaded: (project: Project) => Promise<void>;
  onRemoved: () => Promise<void>;
  onError: (message: string) => void;
}
export function ProjectTools({ project, locked, onLoaded, onRemoved, onError }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false);
  const work = async (task: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    try {
      await task();
      setDialog(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="project-tools">
      <button
        disabled={locked || pending}
        onClick={() => {
          setName(project.name);
          setDialog('rename');
        }}
      >
        Đổi tên
      </button>
      <a className="button quiet" href={`/api/v1/projects/${project.id}/config`}>
        Tải cấu hình
      </a>
      <button disabled={locked || pending} onClick={() => fileInput.current?.click()}>
        Nhập cấu hình
      </button>
      <button disabled={locked || pending} onClick={() => setDialog('delete')}>
        Xóa dự án
      </button>
      <input
        ref={fileInput}
        hidden
        type="file"
        accept=".json,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          void work(async () => {
            if (file.size > 16 * 1024 * 1024) throw new Error('File cấu hình vượt 16 MiB.');
            const result = await post<Project>(
              '/projects/import-config',
              JSON.parse(await file.text()),
            );
            await onLoaded(result);
          });
        }}
      />
      <Dialog.Root
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open && !pending) setDialog(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>{dialog === 'rename' ? 'Đổi tên dự án' : 'Xóa dự án?'}</Dialog.Title>
            <Dialog.Description>
              {dialog === 'rename'
                ? 'Tên được lưu trong workspace local.'
                : 'Xóa dự án, lịch sử và kết quả xuất của dự án. Asset dùng chung được giữ lại. File gốc và các bản đã tải xuống do bạn quản lý.'}
            </Dialog.Description>
            {dialog === 'rename' && (
              <label>
                Tên dự án
                <input
                  value={name}
                  maxLength={120}
                  disabled={pending}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            <div className="button-row">
              <button
                className="primary"
                disabled={pending || (dialog === 'rename' && !name.trim())}
                onClick={() =>
                  void work(async () => {
                    if (dialog === 'rename') {
                      const next = await api<Project>(`/projects/${project.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ expectedRevision: project.revision, name }),
                      });
                      await onLoaded(next);
                    } else {
                      await api(`/projects/${project.id}`, {
                        method: 'DELETE',
                        body: JSON.stringify({ expectedRevision: project.revision, confirm: true }),
                      });
                      await onRemoved();
                    }
                  })
                }
              >
                {pending ? 'Đang xử lý…' : dialog === 'rename' ? 'Lưu tên' : 'Xóa dự án và kết quả'}
              </button>
              <Dialog.Close disabled={pending}>Hủy</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
