# Handoff khi tạm dừng

Trạng thái: **PAUSED theo yêu cầu người dùng**. Không coi dự án đã hoàn tất. Mục tiêu giữ nguyên: triển khai toàn bộ [Implementation Plan](../../IMPLEMENTATION_PLAN.md), đủ P0/P1 và Windows portable release gates.

## Vị trí và yêu cầu đã chốt

- Repository: `/home/hoantv/Projects/other/frame-to-video-studio`.
- Thiết kế: `../BASIC_DESIGN.md` v1.3 và `../IMPLEMENTATION_DESIGN.md` v1.5.
- Bản đích: ZIP Windows x64, Start.exe/Stop.exe, website `127.0.0.1:3000`, bundled Node/Sharp/FFmpeg/FFprobe; offline, không bắt người dùng cài Node/npm/Docker/FFmpeg.
- Windows 11 chính; kiểm thử cùng artifact trên Windows 10 22H2. Thiếu máy test không phải bằng chứng để tự bỏ Win10.
- Toàn bộ source hiện untracked trong Git, chưa commit. Giữ nguyên; không `git reset`/`git clean` hoặc tạo lại skeleton.

## Checkpoint đã kiểm chứng

76 tests core/service đã pass, không skip, trên Linux với Node 24.11.0, TypeScript 5.9.3, Sharp 0.34.5 và FFmpeg 7.1.3 local. Có strict/noUncheckedIndexedAccess typecheck cho graph core/tests và các entry bổ sung. Evidence: `docs/verification/latest-core.json`, `linux-core.tap`, `linux-core-typecheck.txt`.

Đã có source và tests cho storage/atomic backup/manifest schemas, import/quota/GC, renderer, encode/audio, job/cancel/idempotency, cache LRU/Range/reader lease, scoped preview, project/config/relink và staged metadata publication/index recovery. Có source launcher/packager nhưng chưa build/chạy artifact Windows. Trạng thái từng milestone ở `IMPLEMENTATION_STATUS.md`; không dùng 76 tests để kết luận đủ AC-01…26.

## Phần sửa mới chưa kiểm chứng đầy đủ

Ba file chính:

- `apps/web/src/features/export/submission.ts` — mới: ExportSubmission giữ một frozen request/key mỗi tab, journal sessionStorage, deduplicate concurrent calls, giữ key khi network/5xx/response không hợp lệ, clear khi nhận job đúng hoặc rejection 4xx xác định. Trường hợp sessionStorage bị chặn fallback memory.
- `apps/web/src/main.tsx` — dùng chung submitExport cho MP4/CLI; khóa thao tác khi còn request chưa xác nhận, retry banner, replay journal sau bootstrap/reload; dùng mergeJobUpdate tránh response cũ ghi đè job mới.
- `apps/web/src/features/export/CliExportButton.tsx` — delegate submit về parent; Dialog.Trigger, bỏ estimate cũ khi đổi project/revision/đóng; chưa chạy browser.

Standalone strict typecheck của `submission.ts` đã pass. **Chưa viết/chạy tests cho submission; chưa chạy full suite/typecheck/build sau các thay đổi trên.** Evidence 76-pass và sourceDigest hiện vẫn thuộc checkpoint trước đó, cần giữ như bằng chứng lịch sử.

## Bắt đầu khi người dùng yêu cầu làm tiếp

1. Đọc lại ba file đang sửa và kiểm tra current worktree/process handles; không giả định còn command nền. Khi pause đã kiểm tra và không thấy test/build/install đang chạy.
2. Viết test hành vi cho ExportSubmission: duplicate call chỉ gửi một POST; mất phản hồi sau server commit rồi retry/reload dùng lại key và đúng job; request khác không thay frozen attempt; transient/auth/shutdown/malformed response giữ key; definitive rejection và valid response clear; request mới sau thành công có key mới; journal hỏng/storage disabled không crash.
3. Thêm service integration dùng Exports thật: server đã persist job nhưng sender làm mất phản hồi; restart/retry cùng journal phải trả cùng ID và không tạo job thứ hai. Không giả lập ZIP/Windows để lấy pass.
4. Rà soát UI bootstrap/retry: không mắc khóa, không áp job khác project, CLI dialog không giữ estimate cũ, không reset key do rerender; kiểm tra phân loại 4xx có đúng semantics không. Import-session creation vẫn tạo key mới mỗi lần chọn file; retry upload đang dùng file ID, không tự coi submission helper là đã xử lý toàn bộ import workflow.
5. Chạy strict core + test suite trực tiếp, cập nhật evidence/sourceDigest chỉ sau kết quả thực; tiếp tục full dependency/build/HTTP/browser/Windows gates theo plan.

## Command đã dùng

Chạy từ repository, không dùng tsx CLI vì IPC sandbox bị chặn:

```sh
node node_modules/typescript/bin/tsc --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2023 --esModuleInterop tests/*.test.ts apps/server/src/services/previews.ts apps/server/src/launcher-control.ts apps/server/src/config.ts apps/web/src/api.ts
FFMPEG_PATH="$PWD/.local-tools/ffmpeg" FFPROBE_PATH="$PWD/.local-tools/ffprobe" node --import tsx --test --experimental-test-isolation=none --test-reporter=tap tests/*.test.ts
```

Formatter có sẵn ngoài repo (chỉ dev tool):

```sh
node /home/hoantv/Projects/zinza-lms/node_modules/.pnpm/prettier@3.8.1/node_modules/prettier/bin/prettier.cjs --write <files>
```

Không chạy script verify-core để thay thế evidence trực tiếp trong sandbox này: spawnSync có thể trả status 0 kèm EPERM. Helper đã fail đúng và dùng file `script-core.*` riêng.

## Giới hạn môi trường và release còn mở

- Registry npm vẫn lỗi DNS ở lần kiểm tra gần nhất. Chưa full install/lockfile; Fastify/plugins, một số UI/build dependencies, Archiver/yauzl còn thiếu. Full typecheck trước submission có TS2307 và contextual TS7006; chưa pass full build/lint.
- Một số node_modules link tạm từ cache dự án zinza-lms, gitignored; không được ship vào ZIP. Packager cấm dependency symlink ra ngoài gói.
- Chưa tìm được Go compiler trong PATH/các vị trí dev/cache/Flatpak đã dò; chưa có go.sum hoặc launcher.exe được compile.
- Chưa pin/download/checksum Windows binaries; manifest thiếu thì packaging phải fail. Chưa có Windows 10/11 host/VM, không có portable ZIP được nghiệm thu.
- Real CLI ZIP integration chưa chạy được vì thiếu yauzl/Archiver. Prepared PNG/audio encode và ZIP64 envelope fixture không chứng minh ZIP generation/extraction/CRC/encode.cmd trên Windows.
- HTTP/socket/browser runtime, seek/audio drift, accessibility, benchmark lớn và actual process-kill/Windows sharing/power-loss vẫn còn mở.
- `.local-tools/ffmpeg`/ffprobe là wrapper Flatpak phục vụ Linux tests; không phải binary release Windows 8.x.

Chỉ tiếp tục triển khai khi người dùng yêu cầu resume. Không đánh dấu complete hay bỏ gate để khớp phần đã làm.
