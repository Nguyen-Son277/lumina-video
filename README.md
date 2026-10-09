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

## Hai chế độ tạo nội dung

Sidebar có các mục riêng biệt:

1. **Tạo nội dung đơn lẻ** — chọn model, nhập mô tả, tạo ngay một ảnh hoặc video. Không cần dự án; có thể gắn **nhân vật dùng chung** kèm ảnh tham chiếu.
2. **Studio** — không gian làm việc theo dự án, dùng cho chuỗi cảnh và giọng nói đồng nhất.
3. **Nhân vật** — thư viện nhân vật dùng chung của tài khoản.
4. **Thư viện** — toàn bộ ảnh và video đã tạo.

Các mục độc lập: mở mục nào cũng vào đúng chế độ đó, không còn nút gạt qua lại.

## Thư viện nhân vật dùng chung

Mục **Nhân vật** trên sidebar quản lý nhân vật ở cấp tài khoản, **không buộc thuộc một dự án**:

- Mỗi nhân vật có tên, mô tả ngoại hình, hồ sơ giọng nói và **ảnh tham chiếu** (PNG, JPEG, WebP, GIF; tối đa 5 MB).
- Bấm ảnh trong thẻ nhân vật để mở trình xem phóng to.
- Ảnh tham chiếu lưu trong kho media riêng tư, chỉ phục vụ qua `/api/characters/:id/reference` sau khi kiểm tra quyền sở hữu; định dạng nhận dạng bằng **magic bytes**, không tin `Content-Type`.
- Nhân vật dùng chung dùng được ở **Tạo nội dung đơn lẻ** và trong **mọi dự án Studio**.
- Khi thêm nhân vật trong Studio, ô **Phạm vi sử dụng** cho chọn *Dùng chung (Thư viện)* — mặc định — hoặc *Chỉ dự án này*.
- Nhân vật tạo trực tiếp trong một dự án vẫn thuộc dự án đó; danh sách nhân vật của dự án bao gồm cả nhân vật thư viện, mỗi thẻ ghi rõ **Thư viện dùng chung** hay **Trong dự án**. Sửa hoặc xóa nhân vật thư viện ngay trong Studio vẫn gọi đúng endpoint dùng chung.
- Xóa nhân vật đang được cảnh sử dụng sẽ bị chặn — gỡ nhân vật khỏi cảnh trước.

## AI tạo nhân vật từ mô tả

Trong trang **Nhân vật**, nút **AI tạo nhân vật** dùng kết nối LLM đã lưu để gợi ý nhân vật mẫu:

1. Nhập **mô tả** (ví dụ *"một phi hành gia trẻ, điềm tĩnh, người Việt"*) và chọn số lượng 1–6.
2. AI trả về các **nhân vật mẫu** gồm tên, ngoại hình và hồ sơ giọng nói (7 trường).
3. Mỗi nhân vật mẫu có thể **tạo ảnh minh hoạ** bằng model tạo ảnh bạn chọn — bạn thấy cả mô tả lẫn ảnh trước khi quyết định.
4. Bấm **Thêm vào danh sách** — nhân vật được lưu, kèm ảnh minh hoạ làm **ảnh tham chiếu** nếu bạn đã tạo.

- Ứng viên **chưa được lưu** cho tới khi bạn bấm thêm; bấm **Tạo lại** để xin gợi ý khác (ảnh minh hoạ cũ bị xoá theo).
- Prompt yêu cầu AI trả JSON thuần và tự tránh trùng tên với nhân vật đã có; dữ liệu trả về được kiểm tra bằng đúng schema của API tạo nhân vật.
- **Không gửi `response_format`** để tương thích nhiều gateway; JSON được bóc cả khi model bọc trong rào markdown.
- Chưa có kết nối LLM thì hộp thoại hướng dẫn mở **API & Models**; chưa có model ảnh thì vùng minh hoạ cũng hướng dẫn tương tự.
- Mỗi lần sinh tiêu tốn token trong key của bạn, nên có giới hạn `RATE_LIMIT_LLM_CHAT_PER_MIN` (mặc định 10 lần/phút).

### Ảnh minh hoạ và ảnh tham chiếu

Mỗi thẻ nhân vật đã lưu có hai tiện ích:

- **Minh hoạ** — chọn model tạo ảnh hiện có để sinh ảnh chân dung; khi xong, ảnh **tự động trở thành ảnh tham chiếu** của nhân vật (thay ảnh cũ nếu có).
- **Prompt** — mở prompt hoàn chỉnh của nhân vật (tên + ngoại hình + giọng nói + câu chốt giữ nhất quán) để **sao chép** và dán vào công cụ tạo ảnh/video khác.

Ảnh minh hoạ là **tác vụ tạo ảnh thật**: dùng model và API key của bạn, có thể phát sinh chi phí và **xuất hiện trong Thư viện**. Prompt chân dung hướng tới ảnh chụp chân thực, rõ khuôn mặt, nền trung tính; kích thước mặc định `1024x1024`. Ảnh được sao chép ngay trên server từ kho media của tác vụ sang thư mục ảnh tham chiếu, không tải vòng qua trình duyệt.

**Giới hạn:** chất lượng phụ thuộc model; model không trả JSON hợp lệ sẽ báo lỗi để bạn thử lại. Ảnh minh hoạ không tự sinh cho mọi ứng viên — bạn chủ động từng nhân vật để kiểm soát chi phí.

## Trợ lý AI: từ ý tưởng đến video hoàn chỉnh

Mục **Trợ lý AI** trên sidebar biến một cuộc trò chuyện thành dự án Studio có kịch bản và timeline. Luồng gồm ba bước, mỗi bước đều có cổng kiểm soát:

1. **Trao đổi.** Chat với kết nối LLM đã lưu để mô tả video mong muốn; AI hỏi lại chỗ còn mơ hồ. Lịch sử lưu trong database nên mở lại vẫn còn.
2. **Tổng hợp ý kiến.** Bấm **Tổng hợp ý kiến** — AI đọc lại toàn bộ hội thoại và chốt một đề xuất thống nhất (thông điệp, đối tượng, tông, thời lượng, khung hình, nhân vật dự kiến, rủi ro). Đề xuất **chưa** được dùng cho tới khi bạn bấm **Duyệt ý kiến**.
3. **Kịch bản và timeline.** Sau khi duyệt, bấm **Lên kịch bản & timeline** — AI viết kịch bản chi tiết, chốt danh sách nhân vật (kèm hồ sơ giọng) và timeline từng cảnh: **bối cảnh, hành động, nhân vật, người nói, lời thoại, thời lượng, gợi ý khung hình**.
4. **Chốt vào Studio.** Chọn model video và bấm **Chốt & tạo dự án**. Hệ thống tạo dự án mới với nhân vật + cảnh ở trạng thái **chưa duyệt**, nên **chưa phát sinh chi phí**.

Điểm quan trọng về an toàn chi phí: cảnh mới luôn ở trạng thái chưa duyệt. Chỉ khi bạn duyệt một cảnh trong Studio thì cảnh đó mới được xếp hàng tạo nội dung. Bật **tự động xếp hàng khi duyệt** để hệ thống tự tạo lần lượt; vì giới hạn `MAX_CONCURRENT_JOBS_PER_USER`, các cảnh được tạo theo hàng đợi và tiếp tục chạy kể cả khi bạn đóng tab.

Cổng duyệt được ép ở **server**: không thể sinh kịch bản khi ý kiến chưa duyệt, và không thể áp dụng khi chưa có kịch bản — trạng thái do client gửi lên không được tin.

**Gợi ý nhân vật "để không bị lỗi":** AI bắt buộc nêu cảnh báo cho các rủi ro làm video lệch — quá nhiều nhân vật cho một video ngắn, nhân vật thiếu mô tả ngoại hình, cảnh có lời thoại mà thiếu người nói, cảnh cần nhiều hơn một người nói (phải tách cảnh), hoặc bỏ phí nhân vật đã có trong thư viện. Nhân vật trùng tên với thư viện được **dùng lại** thay vì tạo bản sao.

**Chế độ trong dự án (copilot):** cùng mục Trợ lý AI nhưng gắn với một dự án đang mở, dùng để bổ sung cảnh/nhân vật cho dự án đó thay vì tạo dự án mới.

**Giới hạn:** chất lượng phụ thuộc model — model không trả JSON hợp lệ sẽ báo lỗi để thử lại. Mỗi lần chat/tổng hợp/sinh kịch bản đều tiêu tốn token trong key của bạn (giới hạn `RATE_LIMIT_LLM_CHAT_PER_MIN`).

## Nhiều nhân vật trong một cảnh

Mỗi cảnh có **một người nói chính** (sở hữu lời thoại và hồ sơ giọng) cùng **danh sách nhân vật xuất hiện** trong cảnh:

- Người nói chính luôn đứng đầu danh sách, nên ảnh tham chiếu gửi cho provider theo thứ tự ổn định.
- Khi tạo **ảnh**, mọi ảnh tham chiếu của nhân vật trong cảnh đều được gửi kèm (trong giới hạn ảnh đầu vào).
- Khi tạo **video**, API video chỉ nhận **một** ảnh tham chiếu, nên chỉ ảnh của người nói chính được gửi; các nhân vật khác được mô tả bằng văn bản trong prompt.
- Xóa nhân vật đang nằm trong bất kỳ cảnh nào sẽ bị chặn — gỡ khỏi cảnh trước.

## Xuất video hoàn chỉnh

Trong dự án, chức năng **Xuất video** ghép các cảnh đã tạo thành **một tệp duy nhất** theo đúng thứ tự timeline:

- Mặc định lấy mọi cảnh của dự án, mỗi cảnh dùng bản bạn đã chọn hoặc bản thành công mới nhất; cũng có thể chỉ định danh sách cảnh.
- Tác vụ chạy **nền trong worker**: đóng tab vẫn tiếp tục, không giữ kết nối HTTP trong nhiều phút.
- Ảnh động được **chuẩn hoá** về cùng khung hình và fps trước khi nối, nên các cảnh khác độ phân giải/codec vẫn ghép được.
- Âm thanh chỉ được giữ khi **mọi** cảnh đều có tiếng; nếu chỉ một phần có tiếng thì xuất video không tiếng (tránh lệch tiếng so với hình).
- Mỗi người chỉ chạy **một** bản xuất đồng thời để không nghẽn CPU.

**Yêu cầu:** cần **ffmpeg** trên máy chạy backend (`apt install ffmpeg`), hoặc đặt `FFMPEG_PATH`. Thiếu ffmpeg thì bản xuất báo lỗi kèm hướng dẫn cài và không có tệp nào được tạo.

## Đồng bộ nhân vật khi tạo ảnh

Khi tạo ảnh (đơn lẻ hoặc trong dự án) và chọn một nhân vật có ảnh tham chiếu, ứng dụng gửi ảnh đó kèm yêu cầu để model bám đúng ngoại hình:

- Kiểu `Chuẩn OpenAI`: gọi `POST /images/edits` dạng multipart, ảnh nhân vật nằm sau ảnh nguồn.
- Kiểu `extra_body`: ảnh nhân vật nằm trong `extra_body.image` dạng Data URI.
- Prompt nêu rõ ảnh tham chiếu là căn cứ ngoại hình; mô tả ngoại hình vẫn được giữ trong prompt.
- Tắt được bằng tùy chọn **Gửi ảnh tham chiếu** khi provider không hỗ trợ chỉnh sửa ảnh.
- Ảnh tham chiếu tính vào giới hạn ảnh đầu vào mỗi lần tạo (mặc định 4).
- Đường dẫn ảnh được **lưu snapshot vào tác vụ**, nên đổi hoặc xóa ảnh của nhân vật sau đó không làm thay đổi tác vụ đang chạy.

**Giới hạn:** việc gửi ảnh tham chiếu phụ thuộc provider. Provider không hỗ trợ sẽ báo lỗi kèm hướng dẫn tắt tùy chọn.

## Key LLM cho chat và tạo kịch bản

Tab **LLM & Chat** trong *API & Models* lưu kết nối LLM riêng cho từng tài khoản.

**Thêm kết nối — chỉ ba ô nhập:**

1. Nhập **Base URL**, **API key** và **Tên hiển thị** (tùy chọn — để trống tự lấy theo tên miền).
2. Bấm **Kiểm tra kết nối**: ứng dụng gọi `GET {baseUrl}/models` bằng credential vừa nhập (không ghi database).
3. Chỉ khi kiểm tra thành công nút **Lưu kết nối** mới bật. Sửa Base URL hoặc API key sẽ buộc kiểm tra lại.
4. **Chưa cần chọn model** — kết nối lưu ở trạng thái *Chưa chọn model*.

**Chọn model sau, ngay tại danh sách kết nối:**

- Bấm **Tải model** để nạp danh sách model vào **dropdown**, rồi chọn model. Model **không tự chọn sẵn** vì ảnh hưởng tới chi phí và chất lượng.
- Nút **Kiểm tra** xác nhận key hoạt động — không sinh văn bản nên không tốn phí.
- Kết nối **chưa chọn model** vẫn dùng được cho phần quản lý, nhưng tính năng AI sẽ báo lỗi rõ ràng yêu cầu chọn model.

**Bảo mật:** key mã hóa **AES-256-GCM** bằng cùng khóa chủ với provider ảnh/video; giao diện chỉ hiển thị 4 ký tự cuối và không bao giờ trả key về trình duyệt. Endpoint dò model dùng credential chưa lưu và có giới hạn tần suất riêng.

**Fallback:** provider không có `GET /models` (trả mã lỗi `MODELS_UNSUPPORTED`) vẫn **lưu được** kèm cảnh báo; khi đó ô chọn model ở danh sách chuyển thành **ô nhập model thủ công**.

> Kết nối này hiện đã được dùng cho **AI tạo nhân vật** (xem mục phía trên). Tính năng chat và tạo kịch bản sẽ dùng tiếp cùng kết nối.

## Project, nhân vật và giọng nói trong Studio

Studio mở **bảng dự án** dạng thẻ, có ô tìm kiếm, bộ lọc dự án lưu trữ và thẻ bìa lấy từ kết quả gần nhất. Bấm vào một dự án để vào không gian làm việc; nút **Danh sách dự án** đưa trở lại.

Thiết kế lấy cảm hứng từ cách các studio AI hiện đại tổ chức công cụ (tham khảo giao diện công khai của [Higgsfield](https://higgsfield.ai/)): **media là trung tâm, thao tác rõ ràng, thông số nâng cao được ẩn gọn**. Không sao chép thương hiệu hay bố cục nguyên bản của họ.

Trong Studio, **bấm vào ảnh để mở trình xem phóng to**: lăn chuột hoặc nút +/− để thu phóng (50%–800%), kéo để di chuyển khi đã phóng to, nháy đúp để phóng 2×, `Esc` để đóng. Có nút tải xuống ngay trong trình xem. Ảnh xem được cả ở Studio lẫn Thư viện.

Mỗi thẻ kết quả có nút **Xóa kết quả** ngay trong Studio, không cần sang Thư viện. Xóa phiên bản đang được một cảnh chọn sẽ tự bỏ chọn ở cảnh đó (khóa ngoại `ON DELETE SET NULL`), và ảnh bìa của dự án được tính lại.

Trong dự án có ba tab:

- **Ảnh** — soạn bên trái (model, nhân vật tùy chọn, mô tả, kích thước, chất lượng), kết quả bên phải.
- **Nhân vật** — thẻ nhân vật kèm ảnh tham chiếu, ngoại hình và hồ sơ giọng nói (vùng giọng, cao độ, âm sắc, tốc độ, phát âm, thói quen nói).
- **Cảnh video** — dải cảnh theo thứ tự, mỗi cảnh có ảnh thu nhỏ, nhân vật nói và trạng thái phiên bản đã chọn.

Không gian soạn cảnh chia hai cột: **trình soạn bên trái, các phiên bản bên phải**. Ba bước được chỉ rõ: *Nội dung cảnh → Xem trước prompt → Tạo video*. Thông số nâng cao (JSON) nằm trong mục thu gọn, mặc định đóng.

Bấm **Lưu & xem trước prompt** trước khi tạo. Backend biên soạn mẫu `voice-consistency-v2` gồm quy tắc sản xuất, cấu hình dự án, hồ sơ nhân vật/giọng cố định, cảnh và lời thoại nguyên vẹn. Không gọi thêm model chat hay dịch vụ âm thanh. API video nhận chỉ dẫn trong trường `prompt`, **không nhận role system hoặc trường system riêng**.

Mỗi tác vụ lưu prompt gốc, prompt hoàn chỉnh và snapshot. Sửa giọng hoặc cảnh chỉ ảnh hưởng lần tạo tiếp theo. Có thể tạo lại, xem các phiên bản, chọn phiên bản đã hoàn tất làm kết quả chính và tải từng video riêng. Không ghép cảnh thành video dài. Dự án lưu trữ giữ nguyên lịch sử; dữ liệu cũ không thuộc dự án vẫn có trong Thư viện.

**Giới hạn:** mô tả giọng bằng prompt không khóa danh tính giọng và không bảo đảm lip-sync chính xác. Model phải hỗ trợ âm thanh/lời thoại. Mỗi cảnh chỉ có một người nói chính; không tích hợp TTS, voice cloning, lip-sync bên thứ ba. Test mock xác minh prompt/request/lịch sử, không chứng minh giọng thật giống nhau.

API thêm: `/api/shared-characters` (CRUD nhân vật dùng chung, `/reference` để tải lên/xóa/xem ảnh tham chiếu, `/generate` để AI sinh nhân vật mẫu, `/:id/prompt` để xuất prompt, `/:id/reference/from-generation` để gắn ảnh đã tạo làm ảnh tham chiếu), `/api/llm` (CRUD kết nối LLM, `/test`, `/models`), `/api/projects`, `/api/projects/:id/characters`, `/api/projects/:id/characters/:characterId/reference` (tải lên/xóa ảnh tham chiếu), `/api/characters/:id/reference` (xem ảnh), `/api/projects/:id/scenes`, `/api/projects/:id/scenes/reorder`, `/api/scenes/:id/preview-prompt`, `/api/scenes/:id/generate`, `/api/scenes/:id/select-generation`. Lịch sử `/api/generations` hỗ trợ lọc `projectId` và `sceneId`.

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
pnpm run test:backend # 229 test: unit, xác thực, bảo mật, dự án, nhân vật, AI tạo nhân vật, prompt, LLM, Trợ lý AI, nhiều nhân vật mỗi cảnh, xuất video
pnpm run test:e2e     # 61 test giao diện trên trình duyệt thật
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
  characters/               CRUD nhân vật, ảnh tham chiếu, AI sinh nhân vật và xuất prompt
  llm/                      kết nối LLM, gọi chat completion cho tính năng văn bản
  planner/                  Trợ lý AI: prompt, chuẩn hoá, phiên chat, áp dụng thành dự án
  exports/                  xuất video: dò ffmpeg, ghép cảnh, hàng đợi trong worker
  generations/              routes, worker, adapter ảnh/video/mock
  media/                    lưu trữ và phục vụ media có xác thực
src/
  api/                      client gọi backend, kiểu dữ liệu, API dự án
  components/               AuthPage, Sidebar, CharacterForm, CharacterAiModal, CharacterIllustrate,
                            CharacterPromptModal, CharacterIllustrateModal, Lightbox, thẻ kết quả
  pages/                    ProjectStudio, StudioPage, CharactersPage, LibraryPage, SettingsPage
  App.tsx                   vỏ ứng dụng, điều hướng, quản lý trạng thái
tests/
  backend/                  Vitest: unit, xác thực, bảo mật, dự án, nhân vật, LLM, tạo nội dung
  helpers/auth.ts           fixture đăng ký tài khoản cho Playwright
  helpers/mockServer.ts     backend mock cổng riêng cho E2E
  characters.spec.ts        thư viện nhân vật, AI tạo nhân vật, minh hoạ, prompt và tab LLM
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
| Nhân vật dùng chung | `GET\|POST /api/shared-characters`, `GET\|PATCH\|DELETE /api/shared-characters/:id` |
| | `POST\|DELETE /api/shared-characters/:id/reference`, `GET /api/characters/:id/reference` |
| | `POST /api/shared-characters/generate` (AI sinh nhân vật mẫu, không lưu) |
| | `GET /api/shared-characters/:id/prompt` (xuất prompt để dùng nơi khác) |
| | `POST /api/shared-characters/:id/reference/from-generation` (gắn ảnh đã tạo làm ảnh tham chiếu) |
| LLM | `GET\|POST /api/llm`, `PATCH\|DELETE /api/llm/:id` |
| | `POST /api/llm/models` (dò model bằng credential chưa lưu), `POST /api/llm/:id/test`, `POST /api/llm/:id/models` |
| Tác vụ | `POST\|GET /api/generations`, `GET\|DELETE /api/generations/:id` |
| | `POST /api/generations/:id/retry-download` |
| Trợ lý AI | `GET\|POST /api/plans`, `GET\|PATCH\|DELETE /api/plans/:id` |
| | `POST /api/plans/:id/messages`, `/ideas`, `/ideas/approve`, `/plan`, `/apply` |
| Xuất video | `GET\|POST /api/projects/:id/exports`, `GET\|DELETE /api/exports/:id` |
| | `GET /api/exports/:id/file` (thêm `?download=1` để tải về) |
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
- **Nhân vật dùng chung:** thuộc `user_id`; mọi truy vấn đều scope theo chủ sở hữu nên tài khoản
  khác nhận 404. Ảnh tham chiếu lưu trong thư mục riêng `media/<userId>/characters/<characterId>/`.
- **Key LLM:** dùng chung cơ chế AES-256-GCM với provider ảnh/video; `POST /api/llm` kiểm tra SSRF
  ngay khi lưu và chỉ trả về `keyHint` 4 ký tự cuối. `POST /api/llm/models` cũng kiểm tra SSRF,
  **không lưu key** và có giới hạn tần suất riêng theo tài khoản.
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
| `RATE_LIMIT_LLM_MODELS_PER_MIN` | Số lần dò danh sách model LLM mỗi phút, mặc định 30 |
| `RATE_LIMIT_LLM_CHAT_PER_MIN` | Số lần gọi LLM sinh văn bản mỗi phút (tạo nhân vật, kịch bản), mặc định 10 |
| `FFMPEG_PATH` | Đường dẫn tới ffmpeg; để trống thì tìm trong `PATH`. Cần cho chức năng xuất video |
| `EXPORT_TIMEOUT_MS` | Thời gian tối đa cho một lần ghép video, mặc định 10 phút |
| `EXPORT_MAX_SCENES` | Số cảnh tối đa cho một lần xuất video, mặc định 30 |

## Ảnh tham chiếu nhân vật

Khi thêm hoặc sửa nhân vật (ở **Nhân vật** hoặc trong **Studio**), bạn có thể chọn **ảnh tham chiếu** (PNG, JPEG, WebP, GIF; mặc định tối đa 5 MB).

- Ảnh lưu trong kho media riêng tư của chính bạn, không có URL công khai, chỉ phục vụ qua `/api/characters/:id/reference` sau khi kiểm tra quyền sở hữu.
- Định dạng được nhận dạng bằng **magic bytes**, không tin `Content-Type` do trình duyệt khai báo, nên không thể tải lên nội dung khác đội lốt ảnh.
- Thay ảnh mới sẽ xóa ảnh cũ; xóa nhân vật cũng dọn ảnh.
- Khi tạo **video**, ảnh được gửi kèm trong trường `input_reference` dạng data URL để model bám đúng ngoại hình. Prompt cũng nêu rõ điều này.
- Khi tạo **ảnh**, ảnh tham chiếu là một trong các ảnh đầu vào (xem mục *Đồng bộ nhân vật khi tạo ảnh*).
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

`response_format` **bắt buộc nằm trong `extra_body`** — đặt ở top-level có thể gây lỗi 400. Thời gian chờ đặt 360 giây.

**Trường `quality`:** mặc định **không được gửi**. Đây là trường đặc thù GPT Image; nhiều gateway tương thích OpenAI từ chối và trả lỗi dạng `quality is not supported`. Chỉ khi bạn chủ động chọn mức chất lượng trong mục **Chất lượng** thì trường này mới được gửi. Ở kiểu `extra_body`, `quality` không bao giờ được gửi.

Kiểu API được **lưu snapshot vào từng tác vụ**, nên đổi cấu hình provider sau đó không làm thay đổi cách xử lý của tác vụ đang chạy.

## Sao lưu

Cần sao lưu **cả ba** thứ sau, và giữ chúng đi cùng nhau:

1. `data/app.db` — tài khoản, provider, model, nhân vật, kết nối LLM, lịch sử
2. `data/media/` — ảnh và video đã tạo, ảnh tham chiếu nhân vật, ảnh nguồn
3. `APP_ENCRYPTION_KEY` — **mất khóa này thì API key đã lưu (cả provider lẫn LLM) không giải mã được**

## Giới hạn

- Chưa có thanh toán, trang quản trị, đăng nhập mạng xã hội, xác minh email hay khôi phục mật khẩu
  qua email.
- **Xuất video cần ffmpeg** trên máy chạy backend. Thiếu ffmpeg thì chức năng xuất báo lỗi kèm
  hướng dẫn cài, không làm hỏng dữ liệu.
- Xuất video là **ghép và chuẩn hoá** các cảnh đã tạo, không phải trình dựng phim: chưa cắt/trim
  từng clip, chưa thay âm thanh. Âm thanh chỉ được giữ khi **mọi** cảnh đều có tiếng.
- Chưa hỗ trợ ảnh → video; ảnh nguồn chỉ dùng cho model tạo ảnh.
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

**Tạo ảnh báo lỗi liên quan ảnh tham chiếu** — provider không hỗ trợ chỉnh sửa ảnh hoặc ảnh
tham chiếu. Bỏ chọn nhân vật, hoặc tắt ô **Gửi ảnh tham chiếu** rồi thử lại.

**Xóa nhân vật báo "đang được cảnh sử dụng"** — gỡ nhân vật khỏi cảnh trong tab **Cảnh video**
trước, rồi xóa lại.

**Kiểm tra kết nối LLM báo 401/403** — key sai hoặc hết hạn. Sửa kết nối và nhập key mới;
key cũ không đọc lại được.

**"Tải danh sách model" báo provider không hỗ trợ `/models`** — một số gateway không có endpoint
liệt kê model. Bấm **Nhập model thủ công** trong modal rồi gõ đúng model ID provider yêu cầu.

**Tác vụ ở trạng thái "Chưa xác định"** — request có thể đã tới provider nhưng không nhận được
phản hồi. Kiểm tra ở provider trước khi tạo mới, để tránh bị tính phí hai lần.
