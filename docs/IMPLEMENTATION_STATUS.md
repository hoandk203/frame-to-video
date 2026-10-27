# Trạng thái triển khai

Ngày cập nhật: 27/10/2026. Goal PAUSED theo yêu cầu người dùng; chưa hoàn thành toàn bộ plan. Điểm tiếp tục chi tiết: [HANDOFF.md](./HANDOFF.md).

## Phần đang làm khi tạm dừng

- Đã thêm `apps/web/src/features/export/submission.ts`: giữ request/key khi lỗi mạng hoặc phản hồi không rõ, gộp submit trùng, journal trong sessionStorage và kiểm tra response bằng shared schema.
- Đã nối helper vào MP4/CLI trong `main.tsx` và `CliExportButton.tsx`; thêm retry banner và khôi phục request khi reload. CLI estimate có guard bỏ response cũ theo project/revision.
- Đây là source đang làm, **chưa có tests mới cho submission helper, chưa full typecheck/build/browser test sau thay đổi này**. Chỉ standalone strict typecheck của `submission.ts` đã chạy exit 0.
- **76 tests đạt thuộc checkpoint trước thay đổi submission**; `latest-core.json`/TAP giữ nguyên bằng chứng lịch sử đó, không chứng minh toàn bộ worktree hiện tại.
- Không có test/build/install process nền đang chạy được phát hiện khi ghi handoff. Source đang untracked trong repository, chưa có commit; không reset/clean khi tiếp tục.

## Đã có source

- pnpm workspace React/TypeScript, Fastify routes, shared Zod contracts và config.
- Project storage, serial writer, atomic JSON/backup, revision conflict, quota reservation; lỗi init/serialization không giữ lock hoặc file tạm thừa.
- Project/config P1: đổi tên/xóa, tải/nhập cấu hình, phát hiện nguồn thiếu, liên kết lại ảnh/nhạc theo hash, giữ thứ tự/settings. Có source API và UI; HTTP/browser chưa được nghiệm thu.
- Asset GC giữ nguồn trong project, backup, job snapshot, import mở và render lease; reader/deletion gate bảo vệ kết quả đang được đọc.
- Diagnostics xoay theo 10 MiB, tối đa 1.000 file/7 ngày, entry tối đa 64 KiB; lỗi ghi log không tạo diagnostic ID giả.
- Persisted schemas: runtime asset/import/index/job validation, folder identity and snapshot/revision checks, preflight before cleanup, dangling-index rejection; invalid backup with missing primary no longer becomes empty registry. Corrupt import preserves folder/source/partial bytes; older checkpoint recovery follows committed project marker. Private staging/creation-intent publication, missing-index repair and startup atomic-temp cleanup now have file-state tests; real process-kill/Windows sharing/power-loss fault validation remains unfinished.
- Streaming import ảnh/nhạc, SHA-256, validation, finalize/rollback/retry.
- Sharp renderer chung: orientation, matte, contain/cover, blur/brightness, raw RGBA và PNG preview.
- CLI P1 source: prepared PNG/audio/manifest/CMD, quota batching, streaming ZIP adapter, API/UI and shared jobs. Prepared-media tests encode independently after moving staging and deleting original managed sources. Real Archiver ZIP extraction and Windows CMD execution remain unverified.
- Shared native scheduler: one worker, bounded queue/admission, export priority, pending preview coalescing, terminal request metadata limit and shutdown draining. RAM/disk LRU cache now has byte/entry limits, quota reservations, owned-file cleanup and reader leases; scoped seek/prefetch replacement and independent audio lifecycle now have service evidence; browser/benchmark verification remains unfinished.
- Scoped previews: paired client/sequence/intent shared schemas, stale metadata rejection, per-tab cancellation/tombstones with limits/TTL, seek priority and full-queue replacement. Frame playback and audio proxy use independent channels; frontend source advances on manual seek/revision and cancels on cleanup. Browser timing/seek-resume remains unverified.
- FFmpeg/FFprobe process adapter, encode arguments, persisted video jobs, idempotency, cancel, verify và result reader lock.
- Cache/response source: thumbnails/frame PNG/audio share bounded tiers; warm hits bypass paused export queue, clear refuses readers and paused pending work, cache miss returns 410. Byte Range supports memory/file responses and releases leases on actual file source close. Browser owns/revokes PNG Blob URLs; browser behavior is not yet verified.
- Session/Origin/Host/CSRF, preview/audio services và browser UI nối API.
- Go launcher source: named mutex/pipe, Job Object, suspended spawn, readiness, Start/Stop logic. **Chưa compile hoặc chạy trên Windows.**
- Media setup/portable packaging scripts có kiểm tra manifest/checksum. **Chưa tạo artifact**, Windows binary manifest chưa được pin.

## Bằng chứng kiểm tra hiện có

76 test trong `tests/*.test.ts` đã chạy thực trên Linux với Node 24.11.0, Sharp 0.34.5 và FFmpeg 7.1.3 có libx264/AAC. FFmpeg local lấy từ runtime Flatpak hiện có qua wrapper chỉ dành cho test, không phải engine Windows 8.x của bản phát hành.

Lệnh:

```sh
FFMPEG_PATH="$PWD/.local-tools/ffmpeg" \
FFPROBE_PATH="$PWD/.local-tools/ffprobe" \
node --import tsx --test --experimental-test-isolation=none tests/*.test.ts
```

Đã kiểm tra các hành vi: natural sort số lớn, schema/traversal, concurrent revision, backup recovery, render geometry/raw–PNG parity, missing engine error, EXIF/alpha matte, encode video không nhạc/pad/loop đúng frame/duration, session/multi-tab/restart/CSRF, mixed import, retry xung đột, upload thiếu, quota, job idempotency/output reload/reader lock; config transport/relink/GC; audio setting preservation; import cancellation/TTL/restart/finalize recovery; log limits; atomic initialization failure; cancellation–commit ordering và bỏ response poll/SSE cũ. Bổ sung tests cho cache LRU/memory-only/disk-only/disabled/reader/concurrent publish/quota/cancel/restart; shared file/Buffer Range/stream-close lifecycle; real audio proxy RMS kiểm tra volume/pad/loop; và prepared CLI PNG/hash/CMD/relocation/pad-loop audio, ZIP64 envelope (không xác minh CRC/archive implementation), scheduler priority/bounds/cancel và preview shutdown/coalescing. Bổ sung delayed-metadata/reordered seek, cross-tab cancellation isolation, full 64-item prefetch replacement, registration burst cap, tombstone/TTL và audio channel isolation. Thêm 8 metadata fault/recovery tests cho schema/backup/identity/index/snapshot và old upload checkpoint. Thêm 10 creation tests cho staging publication/collision, known-file cleanup, unknown/indexed stage preservation, project init lock release, index repair/retry, tombstone interaction và atomic-update temp lifecycle. Kết quả mới nhất cần đối chiếu log ở `docs/verification/`; không dùng danh sách này làm bằng chứng Windows hoặc browser E2E.

TypeScript strict + noUncheckedIndexedAccess cho tests và graph core/services, previews/config/launcher-control và frontend API utility đã pass bằng compiler 5.9.3. Xem `docs/verification/latest-core.json` và `linux-core.tap`; 76 test này không đồng nghĩa đã nghiệm thu đủ 26 AC. **Full typecheck/build chưa pass** vì thiếu dependency Fastify và một số frontend/build dependencies.

## Điều kiện môi trường chưa đáp ứng

- Rechecked registry DNS: still fails. Real CLI ZIP integration exits 1 with `ERR_MODULE_NOT_FOUND` for `yauzl`; evidence in `docs/verification/cli-zip-integration-unavailable.tap`, not a passing ZIP gate.
- DNS tới `registry.npmjs.org` lỗi; `pnpm install --offline --lockfile-only` báo `ERR_PNPM_NO_OFFLINE_META` với `@types/archiver`. Không có full dependency installation/lockfile tái lập.
- Một số dependency test được liên kết tạm từ cache có sẵn của máy phát triển, chỉ trong `node_modules/` gitignored. Không được ship chúng như portable package; packager cấm external symlinks.
- Chưa có Go compiler/Go module download để tạo `go.sum` và compile launcher.
- Chưa có Node/FFmpeg/FFprobe Windows binary đã tải và xác minh checksum/license.
- Chưa có Windows 10/11 test host/VM trong môi trường hiện tại. Chưa có bằng chứng hỗ trợ OS.
- Sandbox hiện tại từ chối tạo socket IPC của tsx CLI; dùng Node loader `--import tsx`. HTTP/socket/browser E2E cũng cần môi trường cho phép listen localhost.
- Script `verify:core` báo fail rõ do `spawnSync` bị EPERM (ngay cả khi status có giá trị 0). Không dùng report đó làm bằng chứng pass. Các command compiler/test đã được chạy trực tiếp qua terminal với exit 0, có log riêng.

Đã tạm dừng theo yêu cầu người dùng. Không tiếp tục triển khai hoặc chạy kiểm thử nền cho tới khi người dùng yêu cầu làm tiếp.

## Tiến độ theo milestone

| Milestone | Trạng thái | Còn thiếu để đạt gate |
| --- | --- | --- |
| M0 Bootstrap | IN_PROGRESS | Full install/lockfile, full build/lint/API contract docs, CI thực |
| M1 Windows spike | IN_PROGRESS | Go compilation, pinned Windows binaries, ZIP và Win11/Win10 clean-machine tests |
| M2 Workspace/session | IN_PROGRESS | Core atomic/backup/init-failure và log rotation đã có tests; schema/backup/identity/index preflight now tested; creation publication and atomic temp recovery now tested; còn HTTP integration, legacy orphan repair policy, real process-kill/lock/recovery Windows và fault coverage rộng |
| M3 Import | IN_PROGRESS | Đã test persisted create idempotency, restart/finalize recovery, stream cancellation/slot cleanup, TTL/quota/GC; journal schemas/open-source reference checks now implemented; creation intent now restores missing index without duplicate session; còn HTTP/multipart integration, legacy orphan policy và real process/fault coverage rộng |
| M4 Renderer | IN_PROGRESS | Shared scheduler and bounded RAM/disk cache/leases tested; Scoped seek/prefetch integration has service tests; still color/animation fixtures, actual HTTP/browser resource lifetime and memory benchmark |
| M5 Export | IN_PROGRESS | Đã test cancel/progress/commit serialization, cleanup và xuất lại; creation/index recovery and no-auto-resume tested; còn disk-failure/process-crash stress, artifact engine, HTTP Range/E2E |
| M6 Playback | IN_PROGRESS | Real audio proxy policy/volume/cache/channel isolation and scoped frame replacement pass; browser seek-resume/buffering/drift, Blob lifetime and playback/prefetch runtime remain |
| M7 UI P0 | IN_PROGRESS | Full frontend build, browser accessibility/E2E, split feature modules và remaining form workflows |
| M8 Launcher production | IN_PROGRESS | Compile/test Windows ACL/Job Object/shutdown/repeated launch/port conflict |
| M9 Project/storage P1 | IN_PROGRESS | Đã có service/API/UI và tests cho config/relink/xóa/GC/shared refs; còn HTTP/browser, tombstone fault matrix, package move/update Windows |
| M10 CLI ZIP P1 | IN_PROGRESS | Prepared-media/quota/cancel/relocation/audio tests pass; real archive integration lacks yauzl/Archiver installation, Windows CMD/artifact execution pending |
| M11 Release | TODO | All 26 AC + additional tests, benchmarks, final portable artifact and clean-machine evidence |

## Việc tiếp theo

1. Hoàn thiện dependency resolution và full typecheck/build khi registry khả dụng; không thay Fastify/React bằng engine khác để né môi trường.
2. Trong lúc chờ, tăng coverage cho cancellation/recovery/limits, hoàn thiện persistence/import/cache logic và API schemas/docs.
3. Hoàn thiện P1 CLI ZIP, browser seek/playback/cache/resource verification, API contract integration và browser sau khi UI dependencies sẵn sàng.
4. Compile và kiểm thử launcher; tạo/kiểm tra package trên Windows. Giữ nguyên release gate máy sạch/offline và dual-OS.
