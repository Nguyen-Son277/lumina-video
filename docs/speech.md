# Giọng thuyết minh TTS

Studio và Quick/Canvas có thể dùng một giọng đọc cố định cho toàn bộ video. TTS là âm thanh riêng, được ghép sau khi các video cảnh đã tạo xong; hồ sơ giọng của nhân vật vẫn phục vụ việc biên soạn prompt như trước.

## Cấu hình local

1. Trong **API & Models**, thêm provider với Base URL `http://localhost:20128/v1` và API key của dịch vụ TTS. Nhập Base URL, không nhập cả hậu tố `/audio/speech`. Key được mã hóa và dùng chung cơ chế pool key của provider.
2. Bấm **Đồng bộ giọng**, chọn **Edge TTS · 9router** hoặc **Danh sách model của provider**. Catalog chung chỉ nhận các mục có khả năng âm thanh hoặc tên/metadata TTS; những model khác vẫn có thể đồng bộ và phân loại bằng chức năng Model catalog thông thường.
3. Khi endpoint danh sách chưa hoạt động, thêm model thủ công và chọn **Giọng nói / TTS**. Ví dụ:
   - `edge-tts/vi-VN-NamMinhNeural`
   - `edge-tts/vi-VN-HoaiMyNeural`
4. Backend cần `ALLOW_PRIVATE_PROVIDER_URLS=true` trong `.env` local để gọi HTTP/localhost. Cấu hình mẫu vẫn tắt quyền truy cập địa chỉ nội bộ theo mặc định.
5. Cần có `ffmpeg` và `ffprobe` trong PATH, hoặc đặt `FFMPEG_PATH` tới `ffmpeg` cùng thư mục với `ffprobe`. Docker image đã cài hai công cụ. `localhost` trong container là chính container, vì vậy hãy dùng địa chỉ host/dịch vụ mà container truy cập được khi chuyển sang Docker.

9router có thể tạo tiếng thành công trong khi `/audio/voices?provider=edge-tts` trả `401` do endpoint danh sách cần phiên dashboard. Lumina hiển thị lỗi và cho nhập tay; lỗi discovery này không vô hiệu hóa key đang tạo tiếng bình thường.

## Sử dụng

Mở **Xuất video**, bật **Thêm giọng thuyết minh xuyên suốt**, chọn giọng và nhập chính xác toàn bộ lời đọc. **Tạo giọng và nghe thử** tạo MP3 có thể phát, tua và tải về. Đổi giọng hoặc nội dung sẽ yêu cầu bản đọc mới; bản cũ vẫn ở lịch sử.

**Tạo giọng và xuất video** xếp hàng toàn bộ công việc trên backend. Nếu đã có bản đọc khớp kịch bản và model thì dùng lại bản đó, kể cả khi nó còn đang tạo. Đóng hộp thoại hoặc tab không ngắt tác vụ. Thiết lập được nhớ riêng theo dự án/phiên Quick.

- Lời đọc bắt đầu ở giây 0. Video giữ thời lượng và thứ tự cảnh, dùng đúng các asset đã chốt, bao gồm video có logo.
- Bản đọc ngắn hơn video được thêm khoảng lặng. Bản đọc dài hơn làm bản xuất thất bại với `NARRATION_TOO_LONG`, kèm `audioSeconds` và `videoSeconds`; MP3 đầy đủ vẫn tải được. Không tự cắt lời hoặc tăng tốc giọng.
- Mặc định tắt tiếng gốc. **Trộn** giữ toàn bộ âm thanh gốc ở mức mặc định 15%, có thể chỉnh từ 0–100%; giọng TTS giữ nguyên mức âm lượng. Chưa tách giọng gốc khỏi nhạc nền.
- Timeout mặc định 180 giây (`TTS_REQUEST_TIMEOUT_MS`), MP3 tối đa 25 MiB (`MAX_AUDIO_BYTES`), tối đa 20 tác vụ đang chờ/chạy mỗi tài khoản và một tác vụ TTS thực thi cùng lúc trong tiến trình. MP3 tính vào quota media.
- Bản đầu dùng đúng `{model,input}` gửi tới `/audio/speech`, model chứa định danh giọng. Chưa bổ sung các chuẩn yêu cầu trường `voice` riêng, lip-sync, voice cloning, MCP hoặc đăng mạng xã hội.

## API cho tự động hóa

Các API Lumina dùng cookie phiên của tài khoản đã được duyệt. API key TTS thuộc provider và chỉ được backend gửi tới provider; không dùng key đó để xác thực vào Lumina. Ví dụ dưới đây giả định đã đăng nhập và lưu cookie vào `lumina.cookies`.

`modelId` là ID trong Model catalog của Lumina, không phải chuỗi `edge-tts/...`. Chỉ model `tts` đang bật và thuộc tài khoản mới tạo được tiếng.

```bash
curl -b lumina.cookies http://127.0.0.1:5173/api/models?kind=tts

curl -b lumina.cookies -X POST \
  http://127.0.0.1:5173/api/speech-jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: campaign-123-narration-v1' \
  -d '{"modelId":"LUMINA_TTS_MODEL_ID","input":"Lời đọc quảng cáo.","projectId":"PROJECT_ID"}'
```

Kết quả `202 {job}` có ID và trạng thái. Theo dõi bằng `GET /api/speech-jobs/:id`. Các trạng thái gồm `queued`, `running`, `succeeded`, `failed`, `unknown`. Khi thành công có `durationSeconds`, `url`, `downloadUrl` và `mimeType=audio/mpeg`. Endpoint file yêu cầu phiên, hỗ trợ Range và `?download=1`.

Tạo bản xuất và TTS bằng một yêu cầu:

```bash
curl -b lumina.cookies -X POST \
  http://127.0.0.1:5173/api/projects/PROJECT_ID/exports \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: campaign-123-export-v1' \
  -d '{"narration":{"modelId":"LUMINA_TTS_MODEL_ID","input":"Lời đọc quảng cáo.","mode":"replace"}}'
```

Để dùng bản đọc đã có, thay `modelId` và `input` bằng `speechJobId`. Hai dạng là loại trừ nhau. Chế độ trộn dùng `"mode":"mix","originalVolume":0.15`. Bỏ `narration` để giữ hành vi xuất video thông thường.

Canvas dùng tùy chọn `narration` tương tự trên `POST /api/projects/:id/canvas/exports` hoặc `POST /api/quick-sessions/:id/canvas/exports`, cùng các trường `nodeId`, `baseRevision`, `stamp` từ preview hiện có. TTS không thay thế bước kiểm tra revision/stamp của chuỗi video.

Theo dõi `GET /api/exports/:id`: `speechJobId` và `stage` cho biết các bước `speech`, `stitching`, `succeeded`, `failed`. Trong lúc đợi TTS, bản xuất ở trạng thái `queued`, giai đoạn `speech`. Lỗi thời lượng nằm trong `errorMessageParams`.

Các endpoint khác:

| API | Mục đích |
| --- | --- |
| `POST /api/providers/:id/sync-speech-models` | Body `{catalog:"edge-tts"}` hoặc `{catalog:"models"}`; trả `{added,skipped,total}` |
| `GET /api/speech-jobs?projectId=...` | Lịch sử dự án; thay bằng `quickSessionId` cho Quick; phân trang `limit` (1–100), `offset` |
| `DELETE /api/speech-jobs/:id` | Xóa bản đọc hoặc hủy bản chưa gửi; chặn khi đang chạy/được bản xuất đang chạy sử dụng |
| `GET /api/speech-jobs/preferences?projectId=...` | Đọc thiết lập của phạm vi; có thể dùng `quickSessionId` hoặc bỏ cả hai |
| `PUT /api/speech-jobs/preferences` | Body `{scope:{projectId},preferences:{enabled,modelId,input,mode,originalVolume}}` |

`Idempotency-Key` có phạm vi tài khoản và thao tác. Gửi lại cùng key/nội dung trả cùng tài nguyên, kể cả khi đang chạy; đổi nội dung với cùng key trả `409`. Khi chủ động tạo phiên bản mới, dùng key mới. Một bản đọc có phạm vi dự án/Quick chỉ dùng trong phạm vi đó; bản không có phạm vi có thể dùng trong các bản xuất của cùng tài khoản.

Backend không tự gửi lại POST khi kết quả chưa rõ: timeout, đứt kết nối hoặc khởi động lại trong lúc gửi chuyển tác vụ sang `unknown`. Agent cần kiểm tra provider trước khi chủ động tạo yêu cầu mới. Việc đổi key trong pool chỉ diễn ra sau phản hồi từ chối rõ ràng `401/403/429`; không gửi lại sau `5xx`. Tệp đang được bản xuất sử dụng và key đang gắn với tác vụ chưa rõ kết quả được bảo vệ khỏi xóa/thay bí mật.

## Kiểm chứng

`speech.test.ts` kiểm tra API/worker với provider HTTP giả lập và MP3 thật. `speechExports.test.ts` giải mã âm thanh MP4 thật để đo giọng TTS và tiếng gốc, kiểm tra khoảng lặng, thời lượng và chuỗi Quick. `speechMigration.test.ts` xác nhận nâng cấp giữ cột/index và khóa ngoại cũ. `speech.spec.ts` kiểm tra giao diện Studio/Quick trên desktop/mobile, phát âm thanh, lưu thiết lập và tiếp tục sau khi đóng hộp thoại.
