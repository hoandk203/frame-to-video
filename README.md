# Frame to Video Studio

Website localhost tạo MP4 từ chuỗi ảnh, có nhạc nền và nền mờ. Mục tiêu phát hành là ZIP portable Windows x64, không yêu cầu người dùng cài Node/FFmpeg/Docker.

**Trạng thái:** tạm dừng theo yêu cầu người dùng, đang triển khai dở. Điểm tiếp tục ở [HANDOFF.md](docs/HANDOFF.md). Chưa có artifact portable được xác minh; Fastify/frontend dependencies, lockfile, Go launcher và Windows release gates còn cần hoàn tất. Xem [tiến độ thực tế](docs/IMPLEMENTATION_STATUS.md). Không xem source hiện tại là bản phát hành hoàn chỉnh.

## Development

Máy lập trình viên cần Node 24, pnpm 10 và Go 1.26 cho launcher. Đây không phải yêu cầu của người dùng bản portable.

```sh
pnpm install
pnpm setup:media
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`setup:media` chỉ tải artifact có version/URL/SHA-256/license đã pin trong `release-manifest.json`. Manifest hiện chưa có Windows binaries được xác minh nên lệnh phải báo thiếu, không lấy latest. Có thể cấu hình `FFMPEG_PATH` và `FFPROBE_PATH` để chạy test developer bằng engine local; kết quả đó không chứng nhận Windows package.

Server dùng `127.0.0.1:3000`. Đặt `DATA_DIR=.local-data` cho source development; `config.json` mặc định `data/` cho portable. Dùng `APP_ROOT` để chỉ định package root nếu entrypoint khác layout. Không public port ra mạng.

Chạy integration test engine thật:

```sh
FFMPEG_PATH=/absolute/path/ffmpeg FFPROBE_PATH=/absolute/path/ffprobe pnpm test
```

Full build cần dependency được cài đầy đủ. Local offline tests có thể dùng cache của máy phát triển, nhưng packager cấm symlink dependency ra ngoài thư mục gói.

## Tài liệu nguồn

- [Basic Design](../BASIC_DESIGN.md)
- [Implementation Design](../IMPLEMENTATION_DESIGN.md)
- [Implementation Plan](../IMPLEMENTATION_PLAN.md)

Không commit media người dùng, workspace, session token hoặc binary chưa kiểm tra nguồn/license. Bản phát hành phải test bằng cùng ZIP trên Windows 11 và Windows 10 22H2 nếu công bố hỗ trợ cả hai.

## Verification scope

Checkpoint trước thay đổi submission UI có 76 core/service tests pass với engine Linux local; xem [evidence](docs/verification/latest-core.json). Đây chưa phải Windows release hoặc toàn bộ AC. `pnpm verify:core --media` yêu cầu engine paths rõ ràng và fail nếu thiếu case; sandbox hiện tại chặn spawnSync nên bằng chứng được ghi từ command chạy trực tiếp, không dùng report helper thất bại để nhận pass.
