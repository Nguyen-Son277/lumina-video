# Timeline → Canvas

## Sử dụng

1. Tại Timeline, chọn **Chốt & tạo dự án**. Dự án vừa tạo mở thẳng tab Canvas.
2. Mỗi frame có một group gồm prompt, nhân vật/bối cảnh, ảnh storyboard nếu có và node video đã nối đầu vào.
3. Lưu thay đổi Timeline để đồng bộ một chiều sang dự án. Canvas đang mở tự tải revision mới khi không có thay đổi chưa lưu; nếu đang sửa, giao diện yêu cầu tải lại để tránh ghi đè.
4. Chỉnh riêng prompt, model, bố trí hoặc dây nối trên Canvas sẽ được giữ lại. Group có khác biệt hiển thị trạng thái tương ứng; **Dùng lại dữ liệu timeline** khôi phục các trường nguồn của group sau xác nhận.
5. Tại node video chọn model, xem trước đầu vào rồi xác nhận chạy. Có nhiều ảnh nối vào phải chọn rõ ảnh đầu vào. Agnes cần đồng ý dùng URL media tạm trước khi gửi ảnh.

Tạo và đồng bộ graph không tự gọi model. Thay đổi nội dung cảnh đã duyệt sẽ hủy duyệt và tắt cờ tự tạo của cảnh đó; tác vụ đã chạy giữ snapshot cũ.

## Quy tắc bảo toàn

- Frame mới tạo scene/group mới với ID ổn định. Chốt lại không tạo trùng dự án.
- Xóa frame khỏi Timeline giữ group/scene cũ và đánh dấu đã tách, không xóa video đã tạo.
- Node/cạnh tự thêm, vị trí, output được chọn và lịch sử chạy không bị reset bởi đồng bộ.
- Node/cạnh nguồn bị xóa trên Canvas không tự tái xuất hiện ở lần đồng bộ sau. Đặt lại group xóa các tombstone của group.
- Không cập nhật graph khi dự án lưu trữ hoặc trong thùng rác.
- Không tự sửa tài sản thư viện dùng chung khi thiết kế Timeline đổi; cần bản thiết kế riêng thì tạo bản trong dự án.
- Dự án cũ không được ghép frame theo tên/thứ tự. Nút **Liên kết Canvas dự án cũ** yêu cầu xác nhận, bổ sung các scene/group có provenance mới và giữ nguyên nội dung cũ. Vì không đoán liên kết, thao tác này có thể tạo cảnh mới tương tự cảnh cũ.

## Dữ liệu và triển khai

Migration `038_timeline_canvas_sync.sql` bổ sung ánh xạ phiên/dự án, frame/scene/group, tài sản nguồn/đích và snapshot/tombstone. Migration chạy qua cơ chế khởi động server hiện có. Không cần reset database.

Graph schema v1 tương thích dữ liệu cũ, bổ sung `groups` và `groupId` tùy chọn. Tọa độ lưu trên server là tuyệt đối; giao diện React Flow chuyển đổi sang tọa độ tương đối khi render parent group. Giới hạn 2.000 node, 5.000 cạnh; PUT canvas có giới hạn body riêng 8 MB. Prompt ghép vượt 8.000 ký tự bị từ chối thay vì cắt hỏng mention.

Đồng bộ chạy cùng savepoint với các thao tác ghi artifact và gắn ảnh nền, dùng merge ba chiều để giữ override. Revision graph chỉ tăng khi graph thực sự thay đổi. Preview/run video dùng cùng bộ phân giải ảnh và stamp; khóa idempotency được scope theo project/node/stamp để retry không tạo run trùng.

## Kiểm chứng

- Backend: `timelineCanvasSync`, `canvasGroups`, `canvasRunKeys`, `canvasVideoInputs`, planner/canvas/sceneIllustration/entityMigration.
- Trình duyệt: `tests/timelineCanvas.spec.ts` kiểm tra điều hướng dự án mới, group theo cảnh, đồng bộ nhiều lần giữ prompt riêng và preview/chạy video bằng provider giả lập; `tests/canvas.spec.ts` kiểm tra thao tác Canvas cũ.
