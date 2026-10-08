# Lumina Studio

Workspace tạo ảnh và video bằng API key riêng của người dùng. Nhiều tài khoản, mỗi người có
provider, model, thư viện và API key tách biệt.

## Trạng thái

Ứng dụng **đã có backend đầy đủ**. Người dùng đăng nhập, thêm provider bằng Base URL + API key,
phân loại model thành ảnh/video, rồi tạo nội dung thật qua provider tương thích OpenAI.

- API key được mã hóa **AES-256-GCM** trong database và không bao giờ trả về trình duyệt.
- Tác vụ tạo nội dung chạy nền; đóng tab vẫn tiếp tục, restart backend tự phục hồi.
- Media lưu ngoài thư mục public, chỉ phục vụ qua endpoint có xác thực.

> **Trước khi dùng key thật:** đọc mục [Bảo mật](#bảo-mật) và sao lưu `APP_ENCRYPTION_KEY`.
> Mất khóa này thì không giải mã được API key đã lưu.

## Project, nhân vật và giọng nói dùng chung

Studio mở **bảng dự án** dạng thẻ, có ô tìm kiếm, bộ lọc dự án lưu trữ và thẻ bìa lấy từ kết quả gần nhất. Bấm vào một dự án để vào không gian làm việc; nút **Danh sách dự án** đưa trở lại.

Thiết kế lấy cảm hứng từ cách các studio AI hiện đại tổ chức công cụ (tham khảo giao diện công khai của [Higgsfield](https://higgsfield.ai/)): **media là trung tâm, thao tác rõ ràng, thông số nâng cao được ẩn gọn**. Không sao chép thương hiệu hay bố cục nguyên bản của họ.

Trong dự án có ba tab:

- **Ảnh** — soạn bên trái (model, nhân vật tùy chọn, mô tả, kích thước, chất lượng), kết quả bên phải.
- **Nhân vật** — thẻ nhân vật kèm ảnh tham chiếu, ngoại hình và hồ sơ giọng nói (vùng giọng, cao độ, âm sắc, tốc độ, phát âm, thói quen nói).
- **Cảnh video** — dải cảnh theo thứ tự, mỗi cảnh có ảnh thu nhỏ, nhân vật nói và trạng thái phiên bản đã chọn.

Không gian soạn cảnh chia hai cột: **trình soạn bên trái, các phiên bản bên phải**. Ba bước được chỉ rõ: *Nội dung cảnh → Xem trước prompt → Tạo video*. Thông số nâng cao (JSON) nằm trong mục thu gọn, mặc định đóng.

Bấm **Lưu & xem trước prompt** trước khi tạo. Backend biên soạn mẫu `voice-consistency-v1` gồm quy tắc sản xuất, cấu hình dự án, hồ sơ nhân vật/giọng cố định, cảnh và lời thoại nguyên vẹn. Không gọi thêm model chat hay dịch vụ âm thanh. API video nhận chỉ dẫn trong trường `prompt`, **không nhận role system hoặc trường system riêng**.

Mỗi tác vụ lưu prompt gốc, prompt hoàn chỉnh và snapshot. Sửa giọng hoặc cảnh chỉ ảnh hưởng lần tạo tiếp theo. Có thể tạo lại, xem các phiên bản, chọn phiên bản đã hoàn tất làm kết quả chính và tải từng video riêng. Không ghép cảnh thành video dài. Dự án lưu trữ giữ nguyên lịch sử; dữ liệu cũ không thuộc dự án vẫn có trong Thư viện. Nút **Tạo nội dung đơn lẻ** giữ luồng Studio trước đây.

**Giới hạn:** mô tả giọng bằng prompt không khóa danh tính giọng và không bảo đảm lip-sync chính xác. Model phải hỗ trợ âm thanh/lời thoại. Mỗi cảnh chỉ có một người nói chính; không tích hợp TTS, voice cloning, lip-sync bên thứ ba. Test mock xác minh prompt/request/lịch sử, không chứng minh giọng thật giống nhau.

API thêm: `/api/projects`, `/api/projects/:id/characters`, `/api/projects/:id/characters/:characterId/reference` (tải lên/xóa ảnh tham chiếu), `/api/characters/:id/reference` (xem ảnh), `/api/projects/:id/scenes`, `/api/projects/:id/scenes/reorder`, `/api/scenes/:id/preview-prompt`, `/api/scenes/:id/generate`, `/api/scenes/:id/select-generation`. Lịch sử `/api/generations` hỗ trợ lọc `projectId` và `sceneId`.

## Cài đặt

```bash
pnpm install

# Sinh khóa mã hóa API key
pnpm run key:generate

# Tạo file cấu hình
cp .env.example .env
# rồi dán khóa vừa sinh vào APP_ENCRYPTION_KEY
```

## Chạy

```bash
pnpm run dev          # backend (8787) + Vite (5173) cùng lúc
```

Mở [http://127.0.0.1:5173](http://127.0.0.1:5173), đăng ký tài khoản, rồi vào
**API & Models** để thêm provider.

Chạy production (backend phục vụ luôn frontend đã build):

```bash
pnpm run build
pnpm start            # http://127.0.0.1:8787
```

Chạy riêng từng phần: `pnpm run dev:server`, `pnpm run dev:web`.

## Thêm provider thật

1. Vào **API & Models** → **Thêm provider**.
2. Nhập tên hiển thị, **Base URL** (ví dụ `https://api.openai.com/v1`) và **API key**.
3. Bấm **Kiểm tra** để gọi `GET /models` — thao tác này không tạo nội dung nên không tốn phí.
4. Bấm **Đồng bộ** để lấy danh sách model, hoặc **Thêm model** để nhập tay.
5. Vào **Model catalog**, đặt từng model thành **Tạo ảnh** hoặc **Tạo video**.
   Model **Chưa phân loại** sẽ không xuất hiện trong Studio.

Base URL được dùng đúng như bạn nhập, kể cả tiền tố `/v1`. Ứng dụng không tự thêm hay bỏ `/v1`.

## Kiểm thử

```bash
pnpm run typecheck    # TypeScript cho cả frontend và backend
pnpm run test:backend # 127 test: unit, xác thực, bảo mật, dự án, ảnh tham chiếu, ảnh nguồn
pnpm run test:e2e     # 44 test giao diện trên trình duyệt thật
pnpm run test         # chạy cả hai
pnpm run verify       # typecheck + backend + build + e2e
pnpm run test:shots   # chụp ảnh giao diện vào shots/
```

Test E2E tự khởi động backend mock ở cổng 8790 và Vite ở cổng 5180, với database/media tạm và khóa riêng cho từng lần chạy. Test từ chối dùng lại server đang chạy, không đụng dữ liệu thật và **không gọi provider nào**.

## Kiến trúc

```
server/
  index.ts                  khởi động, validate env, tắt an toàn
  env.ts                    schema biến môi trường (zod), fail-fast
  app.ts                    lắp ráp Express, phục vụ frontend ở production
  db/                       node:sqlite + migrations
  crypto/                   AES-256-GCM cho API key, scrypt cho mật khẩu
  auth/                     session, cookie, middleware, routes
  providers/                CRUD, chống SSRF, client gọi provider
  models/                   CRUD và phân loại model
  generations/              routes, worker, adapter ảnh/video/mock
  media/                    lưu trữ và phục vụ media có xác thực
src/
  api/                      client gọi backend, kiểu dữ liệu, API dự án
  components/               AuthPage, Sidebar, modal, thẻ kết quả
  pages/                    ProjectStudio, StudioPage, LibraryPage, SettingsPage
  App.tsx                   vỏ ứng dụng, điều hướng, quản lý trạng thái
tests/
  backend/                  Vitest: unit, xác thực, bảo mật, dự án, tạo nội dung
  helpers/auth.ts           fixture đăng ký tài khoản cho Playwright
  helpers/mockServer.ts     backend mock cổng riêng cho E2E
  projectStudio.spec.ts     luồng dự án, nhân vật, cảnh, phiên bản
  studioLayout.spec.ts      bố cục Studio: lưới dự án, hai cột, mobile
  *.spec.ts                 Playwright: giao diện, layout, cỡ chữ, luồng
```

## API

| Nhóm | Endpoint |
| --- | --- |
| Xác thực | `POST /api/auth/register`, `/login`, `/logout`, `/change-password`, `GET /api/auth/me` |
| Provider | `GET\|POST /api/providers`, `PATCH\|DELETE /api/providers/:id` |
| | `POST /api/providers/:id/test`, `POST /api/providers/:id/sync-models` |
| Model | `GET\|POST /api/models`, `PATCH\|DELETE /api/models/:id` |
| Tác vụ | `POST\|GET /api/generations`, `GET\|DELETE /api/generations/:id` |
| | `POST /api/generations/:id/retry-download` |
| Media | `GET /api/assets/:id` (hỗ trợ `Range`, thêm `?download=1` để tải về) |

`userId` luôn lấy từ session, không bao giờ tin giá trị client gửi.

## Cách gọi provider

Chuẩn OpenAI-compatible:

- **Ảnh:** `POST /images/generations` → đọc `data[].b64_json` hoặc `data[].url`.
- **Video:** `POST /videos` → `GET /videos/{id}` để theo dõi → `GET /videos/{id}/content` để tải.

Thông số bạn không đặt sẽ được bỏ khỏi request để provider dùng mặc định của họ.

**Chống tính phí hai lần:** nếu request tạo nội dung bị timeout hoặc mất kết nối sau khi đã gửi,
tác vụ được đánh dấu `unknown` và **không tự gửi lại**, vì provider có thể đã nhận và đang xử lý.
Hãy kiểm tra ở provider trước khi thử tạo mới. Riêng bước đọc trạng thái và tải kết quả thì được
thử lại với backoff.

## Bảo mật

- **API key:** mã hóa AES-256-GCM, mỗi key một IV riêng, khóa chủ 32 byte từ `APP_ENCRYPTION_KEY`.
  Backend **từ chối khởi động** nếu thiếu hoặc sai độ dài. Giao diện chỉ hiển thị 4 ký tự cuối.
- **Mật khẩu:** scrypt với salt riêng từng người, so sánh timing-safe, tối thiểu 10 ký tự.
- **Session:** token 32 byte, chỉ lưu SHA-256 trong database, cookie `HttpOnly` + `SameSite=Lax`,
  `Secure` khi `COOKIE_SECURE=true`. Đổi mật khẩu thu hồi mọi session cũ.
- **CSRF:** kiểm tra `Origin` cho mọi request thay đổi trạng thái.
- **SSRF:** chỉ `https` công khai; chặn loopback, private, link-local, CGNAT, metadata cloud và
  IPv6 tương ứng (kể cả IPv4-mapped). DNS được phân giải và **ghim địa chỉ** khi kết nối để chống
  DNS rebinding. Không theo redirect cho request mang API key.
- **Media:** lưu ngoài thư mục public, kiểm tra quyền sở hữu, nhận dạng định dạng bằng magic bytes
  (không tin header provider), không bao giờ phục vụ HTML hoặc SVG.
- **Giới hạn:** 2 tác vụ đồng thời/người, prompt 8.000 ký tự, 20 MB/ảnh, 200 MB/video,
  1 GB media/người — chỉnh được qua `.env`.

## Cấu hình

Xem [.env.example](.env.example). Các biến quan trọng:

| Biến | Ý nghĩa |
| --- | --- |
| `APP_ENCRYPTION_KEY` | **Bắt buộc.** Khóa mã hóa API key, base64 của 32 byte |
| `PORT` | Cổng backend, mặc định 8787 |
| `DATABASE_PATH`, `MEDIA_DIR` | Nơi lưu database và media |
| `APP_ORIGIN` | Origin được phép, dùng cho kiểm tra CSRF |
| `PROVIDER_MODE` | `live` gọi provider thật, `mock` chỉ dùng cho test |
| `ALLOW_PRIVATE_PROVIDER_URLS` | `true` cho phép Base URL nội bộ/LAN (chỉ khi phát triển) |
| `COOKIE_SECURE` | Bật khi chạy sau HTTPS |
| `MAX_REFERENCE_BYTES` | Giới hạn ảnh tham chiếu nhân vật, mặc định 5 MB |
| `MAX_IMAGE_BYTES`, `MAX_VIDEO_BYTES`, `MAX_USER_MEDIA_BYTES` | Giới hạn dung lượng media |
| `MAX_CONCURRENT_JOBS_PER_USER`, `MAX_PROMPT_LENGTH` | Giới hạn tác vụ và độ dài prompt |

## Ảnh tham chiếu nhân vật

Khi thêm hoặc sửa nhân vật, bạn có thể chọn **ảnh tham chiếu** (PNG, JPEG, WebP, GIF; mặc định tối đa 5 MB).

- Ảnh lưu trong kho media riêng tư của chính bạn, không có URL công khai, chỉ phục vụ qua `/api/characters/:id/reference` sau khi kiểm tra quyền sở hữu.
- Định dạng được nhận dạng bằng **magic bytes**, không tin `Content-Type` do trình duyệt khai báo, nên không thể tải lên nội dung khác đội lốt ảnh.
- Thay ảnh mới sẽ xóa ảnh cũ; xóa nhân vật cũng dọn ảnh.
- Khi tạo video, ảnh được gửi kèm trong trường `input_reference` dạng data URL để model bám đúng ngoại hình. Prompt cũng nêu rõ điều này.
- Trong trình soạn cảnh có ô **Gửi ảnh tham chiếu của … kèm video** để tắt khi provider không hỗ trợ.

**Giới hạn:** việc gửi `input_reference` phụ thuộc provider. Provider không hỗ trợ sẽ báo lỗi — hãy tắt tùy chọn đó hoặc xóa ảnh.

## Tạo ảnh từ ảnh tải lên (image-to-image)

Trong tab **Ảnh** của dự án, mục **Ảnh nguồn (tạo ảnh từ ảnh)** cho phép tải lên tối đa 4 ảnh PNG, JPEG, WebP hoặc GIF (mặc định 10 MB mỗi ảnh). Ảnh được tải lên ngay khi chọn, xem trước được, và có thể xóa khỏi danh sách.

- Có ảnh nguồn → tùy **kiểu API ảnh** của provider:
  - `Chuẩn OpenAI`: gọi `POST /images/edits` dạng **multipart/form-data**, nhiều ảnh dưới cùng khóa `image`.
  - `extra_body`: gọi `POST /images/generations` với ảnh nguồn trong `extra_body.image` dạng Data URI.
- Không có ảnh nguồn → vẫn gọi `POST /images/generations` với JSON như trước.
- Đường dẫn ảnh nguồn được lưu thành **snapshot** trong tác vụ, nên xóa ảnh nguồn sau đó không làm hỏng tác vụ đang chạy.
- Ảnh nguồn thuộc sở hữu riêng của từng tài khoản; chỉ phục vụ qua `/api/uploads/:id` sau khi kiểm tra quyền.
- Định dạng bắt buộc nhận dạng bằng magic bytes, không tin `Content-Type`.

**Giới hạn:** model phải hỗ trợ kiểu API đã chọn. Provider không hỗ trợ sẽ trả lỗi kèm hướng dẫn; khi đó hãy đổi kiểu API ảnh hoặc bỏ ảnh nguồn. Ảnh nguồn chưa dùng được cho model video (video dùng ảnh tham chiếu của nhân vật).

## Kiểu API tạo ảnh theo provider

Mỗi provider có thiết lập **API ảnh**, đổi được ngay trong danh sách provider ở trang API & Models:

| Kiểu | Cách gọi | Dùng cho |
| --- | --- | --- |
| `Chuẩn OpenAI` (mặc định) | `POST /images/generations` (JSON); có ảnh nguồn thì `POST /images/edits` (multipart) | OpenAI, Azure, phần lớn gateway |
| `extra_body` | `POST /images/generations` (JSON), ảnh nguồn và `response_format` nằm trong `extra_body` | Agnes Image 2.0 Flash và gateway tương tự |

Với kiểu `extra_body`, ứng dụng gửi đúng hợp đồng:

```json
{
  "model": "agnes-image-2.0-flash",
  "prompt": "...",
  "size": "1024x768",
  "extra_body": { "response_format": "url", "image": ["data:image/png;base64,..."] }
}
```

`response_format` **bắt buộc nằm trong `extra_body`** — đặt ở top-level có thể gây lỗi 400. Trường `quality` (đặc thù GPT Image) không được gửi ở kiểu này. Thời gian chờ đặt 360 giây.

Kiểu API được **lưu snapshot vào từng tác vụ**, nên đổi cấu hình provider sau đó không làm thay đổi cách xử lý của tác vụ đang chạy.

## Sao lưu

Cần sao lưu **cả ba** thứ sau, và giữ chúng đi cùng nhau:

1. `data/app.db` — tài khoản, provider, model, lịch sử
2. `data/media/` — ảnh và video đã tạo
3. `APP_ENCRYPTION_KEY` — **mất khóa này thì API key đã lưu không giải mã được**

## Giới hạn

- Chưa có thanh toán, trang quản trị, đăng nhập mạng xã hội, xác minh email hay khôi phục mật khẩu
  qua email.
- Chưa hỗ trợ chỉnh sửa ảnh, ảnh → video, hay upload ảnh tham chiếu.
- Chỉ hỗ trợ provider tương thích OpenAI. Provider có schema riêng cần thêm adapter.
- Chạy một tiến trình backend trên một máy. Hàng đợi nằm trong database của tiến trình đó, nên
  chưa hỗ trợ nhiều replica.
- `node:sqlite` là tính năng thực nghiệm của Node 22. Đã kiểm chứng hoạt động; nếu cần đổi sang
  `better-sqlite3` thì chỉ phải sửa `server/db/index.ts`.

## Xử lý sự cố

**Backend báo "Cấu hình môi trường không hợp lệ"** — thiếu hoặc sai `APP_ENCRYPTION_KEY`.
Chạy `pnpm run key:generate` và dán vào `.env`.

**Provider báo lỗi 401/403** — API key sai hoặc hết hạn. Vào **API & Models**, sửa provider và
nhập key mới. Key cũ không đọc lại được.

**"Provider này không hỗ trợ endpoint /models"** — một số provider không có API liệt kê model.
Bấm **Thêm model** để nhập model ID thủ công.

**Không tạo được nội dung dù đã có model** — kiểm tra model đã được phân loại thành **Tạo ảnh**
hoặc **Tạo video** chưa. Model **Chưa phân loại** bị ẩn khỏi Studio.

**Tác vụ ở trạng thái "Chưa xác định"** — request có thể đã tới provider nhưng không nhận được
phản hồi. Kiểm tra ở provider trước khi tạo mới, để tránh bị tính phí hai lần.
