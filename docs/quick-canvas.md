# Canvas trong Tạo nội dung đơn lẻ

## Sử dụng

- Trong Tạo nội dung đơn lẻ, chọn **Chuyển sang Canvas**. Nếu chưa có phiên, ứng dụng lưu phiên và bản nháp trước khi chuyển.
- Mỗi phiên có một bảng độc lập. Bộ chọn phiên phía trên đổi bảng; **Về tạo đơn lẻ** quay về form mà không thay prompt form bằng các chỉnh sửa độc lập trên canvas.
- **Đồng bộ phiên** đưa lịch sử mới và prompt đã lưu vào bảng, không gọi provider. Nguồn được nhận diện theo ID, không theo tên.
- Thêm node Prompt và node Tạo ảnh/Tạo video, nối cổng prompt. Gõ `@` để gọi nhân vật; gõ `#` để gọi sản phẩm/đạo cụ, bối cảnh hoặc logo. Chọn gợi ý có ảnh để gắn ID; bảng tự thêm node đối tượng và cạnh context tới các node nhận prompt.
- Bỏ lần nhắc cuối chỉ gỡ cạnh tự tạo; node dùng lại và cạnh nối thủ công được giữ. Chuỗi `@tên`/`#tên` chưa chọn gợi ý không được tự suy đoán là một đối tượng. Prompt cũ dùng `@` cho đồ vật vẫn hoạt động theo ID cũ.
- Chọn node hoặc bấm **Chi tiết** để sửa trong inspector: Prompt có ô nhập và bộ đếm; nhân vật/sản phẩm/bối cảnh có bộ chọn tìm kiếm kèm ảnh; upload có ảnh và nút thay; ghi chú có nội dung/màu; chỉ node tạo nội dung mới có chọn model. Thẻ chỉ là bản xem trước gọn, hiện tên, media, trạng thái và tối đa 160 ký tự Unicode trong ba dòng; văn bản đầy đủ vẫn giữ trong inspector có thể cuộn. Quy tắc này áp dụng cho cả Canvas phiên và Canvas Studio.
- Logo mới trên canvas phiên mặc định góc trên phải. Dropdown cung cấp AI tự bố trí và chín vị trí cố định. Vị trí cố định chèn logo gốc sau khi tạo, hỗ trợ cả ảnh/video, rộng mặc định 15%, lề 5%. Logo cũ không có vị trí giữ chế độ AI; overlay tọa độ cũ được giữ khi nhập từ form.
- Video chạy trực tiếp theo phiên, không cần dự án hoặc cảnh Studio. Nối cổng **Sau** của một node Video tới cổng **Trước** của node tiếp theo để tạo chuỗi A → B → C; mỗi node chỉ có một trước/một sau, không được nhánh, tự nối hoặc vòng lặp. Mũi tên, số thứ tự và nhãn Bắt đầu/Kết thúc cho biết thứ tự xuất, độc lập với vị trí thẻ. Nguồn ảnh video của graph là một ảnh đầu vào được chọn. Không tự nhập các URL bên ngoài hay tạo quyền media công khai mới. Khi chuyển từ form, ảnh khởi đầu nội bộ được giữ.
- Chọn **Xuất video** trên thanh công cụ để xem các chuỗi. Canvas tự lưu trước khi xem trước; hộp thoại hiển thị clip theo dây nối, phiên bản đã chọn và fallback bản thành công mới nhất của chính node. Chỉ **Tạo bản xuất video** mới xếp hàng worker. Sau khi hoàn tất, chọn **Tải video về**; thay đổi Canvas sau đó không ảnh hưởng bản đang chạy.
- Xem trước trước khi chạy để kiểm tra prompt, nguồn gửi provider và logo hậu kỳ. Mọi lần tạo kết quả vẫn thuộc phiên và xuất hiện trong Thư viện.

## Bảo toàn dữ liệu

Canvas tự lưu với revision, ngăn ghi đè giữa nhiều tab. Nếu xung đột/lưu lỗi, xử lý thông báo trước khi đổi phiên. Đóng tab khi còn sửa sẽ có cảnh báo trình duyệt.

Đồng bộ giữ tọa độ, nội dung đã sửa và node/cạnh đã xóa. Khi cùng một trường bị sửa ở nguồn và canvas, chỉnh sửa canvas được ưu tiên và khác biệt được ghi nhận. Khôi phục nhóm theo phiên là thao tác chủ động, có kiểm tra revision.

Nhân vật hoặc đối tượng thư viện đang được canvas tham chiếu không được xóa âm thầm. Gỡ node và mention liên quan trước khi xóa. Xóa phiên khi còn bản xuất đang chạy bị chặn; sau khi xóa phiên đã hoàn tất, bản xuất của phiên được đưa vào hàng đợi dọn dẹp nhưng video nguồn vẫn giữ trong Thư viện.

## Kỹ thuật

API có xác thực: `/api/quick-sessions/:id/canvas`, cùng các thao tác `runs`, `sync`, `nodes/:nodeId/preview`, `run`, `composite` và `/api/quick-sessions/:id/canvas/exports` (`GET`, `POST /preview`, `POST`). Canvas Studio dùng các đường dẫn tương ứng dưới `/api/projects/:id/canvas/exports`. Preview nhận `nodeId` và `baseRevision`; tạo bản xuất nhận thêm `stamp`, máy chủ kiểm tra lại rồi lưu danh sách generation/asset đã chốt. Server đọc lại graph đã lưu, kiểm tra quyền nguồn, tính stamp đầu vào và idempotency trước khi xếp hàng. Không có dự án/cảnh giả. Schema graph, ReactFlow node renderers, compiler và pipeline generation được dùng chung với Studio.

Migration `046_quick_canvas.sql` tạo bảng graph, runs và provenance theo phiên; migration `052_canvas_exports.sql` mở rộng lịch sử xuất để thuộc đúng một dự án hoặc phiên. Bộ chèn logo hỗ trợ anchor tùy chọn, giữ tương thích tọa độ x/y cũ. Worker ghép MP4 H.264 30 fps; tiếng được chuẩn hóa AAC stereo 48 kHz, bù/cắt theo từng clip và chèn im lặng khi cần.
