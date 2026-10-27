FRAME TO VIDEO STUDIO

HƯỚNG DẪN CHO GÓI PORTABLE ĐÃ ĐƯỢC KIỂM THỬ
Source hiện tại chưa phải bản phát hành đã nghiệm thu.

1. Giải nén toàn bộ thư mục vào ổ đĩa local có quyền ghi.
2. Bấm Start.exe. Đợi trình duyệt mở http://127.0.0.1:3000.
3. Chọn ảnh và nhạc, cấu hình, xem trước rồi xuất video.
4. Bấm Tải MP4. Nơi lưu bản tải xuống do trình duyệt quyết định.
5. Dừng bằng nút Dừng ứng dụng trên website hoặc Stop.exe.

Gói hoàn chỉnh có sẵn Node.js, FFmpeg và các thư viện. Không cần cài npm,
Go, Python, .NET hoặc Docker. Không cần Internet khi dùng, kể cả lần đầu.

Dữ liệu local nằm trong data/ cạnh Start.exe. Ảnh/nhạc được copy vào đó;
file gốc không bị sửa. Video backend giữ trong data/outputs/ tới khi xóa.
Không xóa data/ khi cập nhật. Dừng app và backup data/ trước cập nhật.

Port mặc định 3000. Nếu port đang bị app khác dùng, dừng ứng dụng này rồi
sửa port trong config.json; không tắt ngẫu nhiên app khác. Không chạy từ ZIP
hoặc ổ mạng. Nếu lỗi khởi động, xem thông báo launcher và data/logs/.

Đóng tab không dừng backend hoặc hủy export. Video đã tải xuống vẫn còn
khi backend dừng. Dung lượng trống phải đủ cho bản copy nguồn và kết quả.
