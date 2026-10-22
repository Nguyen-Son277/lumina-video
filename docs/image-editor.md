# Trình chỉnh sửa ảnh trực tiếp và xoá nền cục bộ

## Sử dụng trình sửa ảnh

1. Mở ảnh trong thư viện/kết quả tạo ảnh, Canvas hoặc storyboard và chọn **Chỉnh sửa ảnh**. Ảnh trong Thùng rác và màn hình chỉ đọc không cho sửa.
2. Chọn **Hình chữ nhật**, **Vùng tự do** hoặc **Cọ chọn vùng**, vẽ lên ảnh rồi ghi yêu cầu cho từng vùng. **Tẩy** chỉ trừ lớp đánh dấu của vùng đang chọn, không xoá nội dung ảnh gốc. Có hoàn tác/làm lại và xoá các đánh dấu.
3. Chọn model và **Xem trước từ máy chủ** để kiểm tra prompt gồm kích thước ảnh, gốc toạ độ góc trên trái, hộp giới hạn pixel và bình luận từng vùng. Chỉ nút xác nhận mới gửi tác vụ AI có thể tính phí.
4. Kết quả là bản mới: so sánh trước/sau, tải về, dùng làm nguồn sửa tiếp hoặc chọn **Dùng ảnh cho nhân vật**. Luồng nhân vật dùng ảnh ngay trên máy chủ, không tải xuống/tải lên lại; người dùng xác nhận lưu nhân vật và ảnh tham chiếu.

**Khả năng model:** trong **API & Models → Model catalog**, xác nhận riêng khả năng sửa mask và xuất nền trong suốt sau khi đã kiểm chứng provider. Model chưa xác nhận mask vẫn có chế độ **hướng dẫn bằng mô tả** với cảnh báo: ranh giới chỉ là gợi ý và toàn ảnh có thể thay đổi. Không coi nhận ảnh tham chiếu là bằng chứng hỗ trợ mask.

**Đổi khung:** chọn thêm khung cục bộ (không phí provider) hoặc AI vẽ phần mở rộng. Không crop hay kéo méo ảnh; nếu bật thu nhỏ vừa khung thì có nội suy đồng tỷ lệ. Khi AI vẽ mở rộng, server ghép lại vùng ảnh gốc (hoặc ảnh đã thu nhỏ theo lựa chọn) để bảo vệ nội dung.

**Giới hạn:** tối đa 8.192 pixel/cạnh, 25 triệu pixel, 20 vùng và 1.000 ký tự/bình luận; prompt tổng hợp tối đa 8.000 ký tự và còn chịu giới hạn cấu hình máy chủ. Nguồn được chuẩn hoá chiều EXIF thành PNG; ảnh động chỉ dùng khung đầu và có cảnh báo. Nguồn gốc không bị ghi đè. Bản nháp giữ trong lần mở hiện tại; tác vụ đã gửi lưu trong lịch sử.

## Hai phương thức xoá nền

Trình chỉnh sửa ảnh hỗ trợ hai lựa chọn xoá nền, **luôn hiển thị cả hai**:

1. **Provider** (mặc định) — gửi ảnh lên model nhận ảnh đầu vào đã được xác nhận xuất nền trong suốt. Có thể tính phí API và thay đổi chi tiết chủ thể; kết quả phải có pixel trong suốt thật, không phải nền trắng/caro vẽ vào ảnh.
2. **Cục bộ (local)** — chạy mô hình `u2net` trên CPU trong container nội bộ
   `background-removal`. Không gửi ảnh ra ngoài, không tốn phí API.

Lựa chọn cục bộ bị **vô hiệu hoá kèm lý do hiển thị rõ** khi sidecar chưa được
cấu hình (`BACKGROUND_REMOVAL_URL` rỗng) hoặc không healthy (`GET /health` trả
503). Người dùng vẫn dùng được lựa chọn provider.

> Dịch vụ cục bộ là **tuỳ chọn**. Không bật thì ứng dụng hoạt động y như cũ.

---

## 1. Kiến trúc

```text
Trình duyệt ──HTTPS──> Cloudflare ──Tunnel──> app:8787
                                                   │
                                 (mạng nội bộ)    │ POST /mask  (bytes PNG/JPEG)
                                                   ▼
                                    background-removal:7000  (u2net, CPU)
```

- Sidecar **không** publish cổng ra host. Nó chỉ nằm trên network `internal`
  của Compose (network `internal: true`), nên không có gateway ra Internet.
- Sidecar **không** nhận URL và **không** tải mô hình lúc chạy.
- Container `app` vẫn giữ network `default` (cần Internet để gọi provider),
  đồng thời được nối thêm vào network `internal` để gọi sidecar.

## 2. Cấu hình

### 2.1. Chạy ngoài Docker (dev)

```bash
# 1. Build image sidecar (cần Internet lúc build để tải trọng số mô hình)
docker build -t lumina-background-removal:local services/background-removal

# 2. Chạy, chỉ expose cho localhost để thử
docker run --rm -p 127.0.0.1:7000:7000 lumina-background-removal:local

# 3. Trỏ backend tới sidecar (trong .env)
BACKGROUND_REMOVAL_URL=http://127.0.0.1:7000
BACKGROUND_REMOVAL_TIMEOUT_MS=120000
```

### 2.2. Chạy với Docker Compose (khuyến nghị)

Bật profile `background-removal` và đặt URL trong `.env.docker`:

```bash
cp .env.docker.example .env.docker
chmod 600 .env.docker

# Sửa .env.docker:
#   BACKGROUND_REMOVAL_URL=http://background-removal:7000
#   BACKGROUND_REMOVAL_TIMEOUT_MS=120000
```

```bash
docker compose --env-file .env.docker --profile background-removal up -d --build
docker compose --env-file .env.docker --profile background-removal ps
```

Muốn tắt lại:

```bash
docker compose --env-file .env.docker --profile background-removal stop background-removal
# hoặc bỏ profile và đặt BACKGROUND_REMOVAL_URL rỗng
docker compose --env-file .env.docker up -d
```

### 2.3. Biến môi trường

| Biến | Nơi dùng | Mặc định | Ý nghĩa |
| --- | --- | --- | --- |
| `BACKGROUND_REMOVAL_URL` | Backend (`server/env.ts`) | rỗng | URL nội bộ của sidecar. **Rỗng = tắt** lựa chọn cục bộ. |
| `BACKGROUND_REMOVAL_TIMEOUT_MS` | Backend | `120000` | Thời gian chờ tối đa cho một lần gọi sidecar. |
| `BG_REMOVAL_MAX_BYTES` | Sidecar | `10485760` | Kích thước thân request tối đa (10 MiB). |
| `BG_REMOVAL_MAX_SIDE` | Sidecar | `8192` | Cạnh dài tối đa của ảnh vào. |
| `BG_REMOVAL_MAX_PIXELS` | Sidecar | `25000000` | Tổng số pixel tối đa của ảnh vào. |
| `BG_REMOVAL_TIMEOUT_SECONDS` | Sidecar | `110` | Timeout suy luận. **Phải nhỏ hơn** `BACKGROUND_REMOVAL_TIMEOUT_MS` để còn thời gian truyền ảnh về. |
| `BG_REMOVAL_READ_TIMEOUT_SECONDS` | Sidecar | `20` | Timeout đọc thân request. |
| `BG_REMOVAL_MAX_RESTARTS` | Sidecar | `3` | Số lần tự khởi động lại worker sau lỗi nặng. |
| `BG_REMOVAL_CPUS` | Sidecar | `1.0` | Giới hạn CPU của container. |
| `BG_REMOVAL_MEMORY_LIMIT` | Sidecar | `2g` | Giới hạn RAM của container. |

Giới hạn phía backend (`MAX_SOURCE_IMAGE_BYTES`, mặc định 10 MiB) và giới hạn
phía sidecar phải khớp nhau; sidecar từ chối (413) nếu vượt.

## 3. Cấp phát mô hình và checksum

- Mô hình: **`u2net`** (ONNX). Cố ý **không** dùng `bria_rmbg` vì đó là mô hình
  mặc định có thể thay đổi và không có giấy phép mở.
- Nguồn: `https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx`
- Checksum MD5: `60024c5c889badc19c04ad937298a77b`
  (giá trị lấy từ `rembg` v2.0.67, `rembg/sessions/u2net.py`).
- Kích thước quan sát được khi xác minh: `175997641` byte.

Quy trình:

1. `services/background-removal/provision.py` chạy **chỉ lúc build image**.
   Nó tải file về, kiểm tra MD5, và **fail build** nếu checksum sai.
2. `services/background-removal/model.py` kiểm tra lại MD5 **lúc khởi động
   tiến trình**. Dịch vụ chỉ báo `ready` khi checksum đúng và model đã nạp.
3. Lớp `OfflineU2netSession` ghi đè `download_models()` của upstream nên
   **không có đường tải mô hình nào chạm được mạng lúc runtime**.

```bash
# Xác minh thủ công checksum
curl -sL -o /tmp/u2net.onnx \
  https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx
md5sum /tmp/u2net.onnx
# 60024c5c889badc19c04ad937298a77b
```

## 4. Giấy phép

| Thành phần | Giấy phép | Bản sao đầy đủ |
| --- | --- | --- |
| [`rembg`](https://github.com/danielgatis/rembg) (tag v2.0.67) | MIT | `services/background-removal/licenses/rembg-MIT.txt` |
| [`U-2-Net`](https://github.com/xuebinqin/U-2-Net) (kiến trúc + trọng số `u2net`) | Apache License 2.0 | `services/background-removal/licenses/U-2-Net-Apache-2.0.txt` |

Ghi chú chi tiết: `services/background-removal/licenses/README.md`.
Cả hai bản sao được lấy nguyên văn từ upstream và đóng gói vào image.

## 5. Hợp đồng nội bộ

Dịch vụ không có xác thực vì chỉ nằm trong network nội bộ của Compose.

### `POST /mask`

| | |
| --- | --- |
| Request | Body thô là bytes **PNG hoặc JPEG** (`Content-Type: image/png` hoặc `image/jpeg`) |
| Response `200` | `Content-Type: image/png`, ảnh PNG **thang xám 8-bit** (`mode L`) |
| Kích thước | **Giống hệt** ảnh vào (cùng chiều rộng/cao theo lưới pixel đã mã hoá) |
| Ngữ nghĩa | **Trắng = tiền cảnh**, **đen = nền** |

Mã lỗi:

| Mã | Ý nghĩa |
| --- | --- |
| `400` | Body rỗng hoặc `Content-Length` sai |
| `404` | Sai path (kể cả khi có tham số `?url=`) |
| `408` | Timeout đọc body |
| `411` | Thiếu `Content-Length` |
| `413` | Body vượt `BG_REMOVAL_MAX_BYTES` |
| `415` | `Content-Type` không phải PNG/JPEG |
| `422` | Ảnh không đọc được, sai định dạng, ảnh động, hoặc vượt giới hạn kích thước |
| `429` | Đã có một suy luận đang chạy (concurrency = 1, **không xếp hàng**) |
| `503` | Model chưa nạp xong hoặc không healthy |
| `504` | Suy luận vượt `BG_REMOVAL_TIMEOUT_SECONDS` |

Không có endpoint nào nhận URL và không có đường tải mô hình lúc chạy.

### `GET /health`

```json
// 200 — model đã nạp và checksum đúng
{ "ok": true, "status": "ready", "model": "u2net" }

// 503 — model chưa sẵn sàng
{ "ok": false, "status": "unavailable", "model": "u2net" }
```

Backend coi capability `local.backgroundRemoval` là khả dụng **chỉ khi**
`BACKGROUND_REMOVAL_URL` được đặt **và** `GET /health` trả `200`.

## 6. Ví dụ kiểm thử

```bash
# Health
curl -i http://127.0.0.1:7000/health

# Mask (kết quả là PNG thang xám cùng kích thước)
curl -s -X POST http://127.0.0.1:7000/mask \
  -H 'Content-Type: image/png' \
  --data-binary @input.png -o mask.png -D -
```

Chạy test giao thức (không cần ONNX runtime, không tải mô hình):

```bash
python3 services/background-removal/test_service.py
```

## 7. Vận hành

- **Sức tải**: một lần suy luận mỗi lượt. Yêu cầu thứ hai trả `429` thay vì xếp
  hàng, để không dồn backlog. Mô hình chạy ở 320×320 bên trong rồi mask được
  phóng về đúng kích thước ảnh gốc.
- **Giới hạn tài nguyên**: `cpus: 1.0`, `memory: 2g` (đổi qua `BG_REMOVAL_CPUS`
  và `BG_REMOVAL_MEMORY_LIMIT`).
- **Timeout**: quá thời gian, tiến trình worker bị dừng để không chồng suy luận,
  service trả `504`, rồi **tự khởi động lại worker** (tối đa
  `BG_REMOVAL_MAX_RESTARTS` lần, mặc định 3, và ngân sách này được reset sau
  mỗi lần suy luận thành công). Không cần khởi động lại container thủ công.
  Đã kiểm chứng trên container thật: `504` sau 2 giây, `/health` trở lại `200`
  sau ~3 giây và yêu cầu kế tiếp thành công.
- **Không có outbound**: network `internal` của Compose chặn egress. Đã kiểm
  chứng: DNS và TCP ra ngoài đều thất bại.
- **Log**: dịch vụ không ghi nội dung ảnh, query string hay path do người dùng
  cung cấp.
