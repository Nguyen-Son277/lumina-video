# Canvas trong Tạo nội dung đơn lẻ

## Sử dụng

- Trong Tạo nội dung đơn lẻ, chọn **Chuyển sang Canvas**. Nếu chưa có phiên, ứng dụng lưu phiên và bản nháp trước khi chuyển.
- Mỗi phiên có một bảng độc lập. Bộ chọn phiên phía trên đổi bảng; **Về tạo đơn lẻ** quay về form mà không thay prompt form bằng các chỉnh sửa độc lập trên canvas.
- **Đồng bộ phiên** đưa lịch sử mới và prompt đã lưu vào bảng, không gọi provider. Nguồn được nhận diện theo ID, không theo tên.
- Thêm node Prompt và node Tạo ảnh/Tạo video, nối cổng prompt. Khi chọn nhân vật/bối cảnh/vật phẩm/logo từ gợi ý `@`, bảng tự thêm node đối tượng và cạnh context tới các node nhận prompt.
- Bỏ mention chỉ gỡ cạnh tự tạo; node dùng lại và cạnh nối thủ công được giữ. Chuỗi `@tên` chưa chọn gợi ý không được tự suy đoán là một đối tượng.
- Logo mới trên canvas phiên mặc định góc trên phải. Dropdown cung cấp AI tự bố trí và chín vị trí cố định. Vị trí cố định chèn logo gốc sau khi tạo, hỗ trợ cả ảnh/video, rộng mặc định 15%, lề 5%. Logo cũ không có vị trí giữ chế độ AI; overlay tọa độ cũ được giữ khi nhập từ form.
- Video chạy trực tiếp theo phiên, không cần dự án hoặc cảnh Studio. Nguồn ảnh video của graph là một ảnh đầu vào được chọn; chưa có cổng khung kết thúc riêng. Không tự nhập các URL bên ngoài hay tạo quyền media công khai mới. Khi chuyển từ form, ảnh khởi đầu nội bộ được giữ; URL bên ngoài và khung kết thúc không được tự nhập thành node.
- Xem trước trước khi chạy để kiểm tra prompt, nguồn gửi provider và logo hậu kỳ. Mọi lần tạo kết quả vẫn thuộc phiên và xuất hiện trong Thư viện.

## Bảo toàn dữ liệu

Canvas tự lưu với revision, ngăn ghi đè giữa nhiều tab. Nếu xung đột/lưu lỗi, xử lý thông báo trước khi đổi phiên. Đóng tab khi còn sửa sẽ có cảnh báo trình duyệt.

Đồng bộ giữ tọa độ, nội dung đã sửa và node/cạnh đã xóa. Khi cùng một trường bị sửa ở nguồn và canvas, chỉnh sửa canvas được ưu tiên và khác biệt được ghi nhận. Khôi phục nhóm theo phiên là thao tác chủ động, có kiểm tra revision.

Nhân vật hoặc đối tượng thư viện đang được canvas tham chiếu không được xóa âm thầm. Gỡ node và mention liên quan trước khi xóa. Xóa phiên xóa bảng của phiên nhưng giữ các kết quả đã tạo trong Thư viện.

## Kỹ thuật

API có xác thực: `/api/quick-sessions/:id/canvas`, cùng các thao tác `runs`, `sync`, `nodes/:nodeId/preview`, `run`, `composite`. Server đọc lại graph đã lưu, kiểm tra quyền nguồn, tính stamp đầu vào và idempotency trước khi xếp hàng. Không có dự án/cảnh giả. Schema graph, ReactFlow node renderers, compiler và pipeline generation được dùng chung với Studio.

Migration `046_quick_canvas.sql` tạo bảng graph, runs và provenance theo phiên. Bộ chèn logo hỗ trợ anchor tùy chọn, giữ tương thích tọa độ x/y cũ.
