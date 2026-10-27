import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Project } from '../../../../../packages/contracts/src/index.js';
import { api } from '../../api.js';
import type { ExportRequest } from './submission.js';

interface Props {
  project: Project;
  disabled: boolean;
  fileName: string;
  onSubmit: (request: ExportRequest) => Promise<void>;
  onError: (message: string) => void;
}
export function CliExportButton({ project, disabled, fileName, onSubmit, onError }: Props) {
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false);
  const generation = useRef(0);
  const [estimate, setEstimate] = useState<{ rawSequenceBytes: number; frameCount: number } | null>(
    null,
  );
  useEffect(() => {
    setOpen(false);
    setEstimate(null);
    return () => {
      generation.current++;
    };
  }, [project.id, project.revision]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        const token = ++generation.current;
        if (next) {
          setEstimate(null);
          void api<{ rawSequenceBytes: number; frameCount: number }>(
            `/projects/${project.id}/cli-estimate`,
          )
            .then((value) => {
              if (generation.current === token) setEstimate(value);
            })
            .catch((error) => {
              if (generation.current === token) onError(String(error));
            });
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button disabled={disabled || pending}>Xuất gói CLI</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>Chuẩn bị gói CLI</Dialog.Title>
          <Dialog.Description>
            Tạo PNG đã render, nhạc, manifest và encode.cmd trong ZIP. Gói dùng được độc lập với
            đường dẫn nguồn; máy chạy encode.cmd cần FFmpeg có libx264/AAC trên PATH.
          </Dialog.Description>
          {estimate && (
            <p>
              {estimate.frameCount} frame · dung lượng thô tham chiếu{' '}
              {(estimate.rawSequenceBytes / 1073741824).toFixed(2)} GiB trước nén. PNG/ZIP thực tế
              tùy nội dung; cần chỗ cho cả bản trung gian và ZIP.
            </p>
          )}
          <p className="helper">
            Bạn có thể hủy tác vụ sau khi được tạo. ZIP chỉ tải được sau khi hoàn tất.
          </p>
          <div className="button-row">
            <button
              className="primary"
              disabled={pending || disabled || !estimate}
              onClick={() => {
                if (pending) return;
                setPending(true);
                void onSubmit({
                  projectId: project.id,
                  expectedRevision: project.revision,
                  kind: 'cli',
                  fileName: `${fileName.replace(/\.(mp4|zip)$/i, '')}.zip`,
                })
                  .then(() => setOpen(false))
                  .catch((error) => onError(error instanceof Error ? error.message : String(error)))
                  .finally(() => setPending(false));
              }}
            >
              {pending ? 'Đang tạo tác vụ…' : 'Tạo gói ZIP'}
            </button>
            <Dialog.Close disabled={pending}>Đóng</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
