# Thư viện đối tượng: nhân vật, đồ vật và logo

[Quay lại README](<../README.md#thư-viện-đối-tượng-và-mention-theo-id>).

## Phạm vi và handle

Thư viện gom catalog `character`, `item` và `logo` của **tài khoản đang đăng nhập**. Đồ vật
(`item`) và logo (`logo`) là tài sản cấp tài khoản, không thuộc riêng một dự án. Nhân vật
vẫn giữ phạm vi cũ: dùng chung hoặc chỉ dự án; catalog có `projectId` chỉ cho phép nhân vật
thuộc phạm vi dự án đó và nhân vật dùng chung. Vật phẩm Canvas cục bộ (`product`/`prop`)
vẫn là dữ liệu riêng của dự án, không tự chuyển thành đồ vật thư viện.

- Handle lưu không có `@`: bỏ khoảng trắng đầu/cuối, bỏ dấu Unicode (NFKD), `đ` → `d`,
  chuyển chữ thường, thay chuỗi ký tự không phải chữ/số ASCII bằng `-`, tối đa 64 ký tự.
  Ví dụ `Đèn Bàn` → `den-ban`; `ĐÈN BÀN` và `den-ban` xung đột.
- Handle **đang hoạt động** duy nhất trong một tài khoản **giữa cả ba loại**. Đồ vật không
  được dùng handle của một nhân vật/logo đang hoạt động của cùng chủ; tài khoản khác có
  thể dùng cùng handle. Không có tra cứu tên toàn cục xuyên người dùng.
- Tên hiển thị và handle là hai trường khác nhau. Đổi tên không tự đổi handle; đổi handle
  qua endpoint riêng. Các bản ghi cũ chưa có handle được đăng ký với hậu tố theo ID khi
  gặp trùng, không dùng thứ tự danh sách làm danh tính.
- Có thể tạo/sửa mô tả, ghi chú liên tục, tải PNG/JPEG/WebP/GIF làm ảnh tham chiếu, gỡ ảnh
  hoặc gắn từ kết quả ảnh **thành công, còn hoạt động, thuộc chính tài khoản**. Upload
  tham chiếu chịu `MAX_REFERENCE_BYTES`, nhận dạng bằng magic bytes; không nhận SVG.

## Chọn mention theo ID, không phải chữ trùng tên

Gõ `@` rồi **chọn đối tượng từ picker**. Chỉ gõ/dán chữ `@den-ban` không tự gắn đối tượng.
Mỗi lần chọn lưu một binding gồm ID occurrence, khoảng UTF-16, nhãn hiển thị đóng băng,
và `{ kind, id }` của đối tượng trong `PromptDocument` phiên bản 1.

- Đổi tên/handle không viết lại chữ mention cũ và **không đổi đích**. Binding vẫn trỏ ID đã
  chọn; thông tin mô tả/tham chiếu hiện tại được giải quyết và snapshot khi tạo tác vụ mới.
- Sửa trực tiếp phần chữ của một mention có thể làm mất binding; hãy chọn lại từ picker.
  Xoá rồi gõ lại cùng chữ không tự phục hồi binding. `\@` và `@` trong địa chỉ email là chữ thường.
- ID bị xoá/không còn khả dụng làm mention **unresolved** và chặn chạy. Tạo một đối tượng mới
  cùng tên/handle không thay thế ID cũ. Xoá cứng để lại dấu vết danh tính, không tái gắn theo tên.
- Khôi phục giữ ID nhưng không tự gắn lại các liên kết đã bị tháo khỏi cảnh/Canvas/phiên.
  Binding còn giữ đúng ID có thể giải quyết lại khi đối tượng hợp lệ; không hứa khôi phục
  mọi liên kết hoặc rewrite tất cả tài liệu.
- Canvas cũ chỉ lưu chữ `@` phải **chọn lại rõ ràng**. Không suy diễn theo alias cũ, tên đang
  sống hay tìm kiếm toàn catalog để tự gắn. Node bối cảnh/vật phẩm cục bộ vẫn dùng dây nối
  cho ngữ cảnh; chọn đối tượng thư viện theo ID không cần tạo dây nối giả.

## Những nơi dùng được

| Bề mặt | Dữ liệu mention |
| --- | --- |
| Tạo nội dung đơn lẻ (quick), cả ảnh/video | Composer `promptDocument`, lưu theo phiên; sửa từ kết quả giữ binding còn hợp lệ |
| Studio — ảnh | Prompt ảnh theo ID, preview đầu vào trước khi tạo |
| Studio — cảnh video | Prompt cảnh theo ID; lời thoại/người nói/cast vẫn do cảnh quản lý |
| Canvas | Prompt node lưu `data.promptDocument`; node Thư viện chọn đồ vật/logo theo ID |
| Kịch bản nháp | Text kịch bản lưu `promptDocument`; trường cảnh dùng `mentionDocuments` |
| Timeline | `action`, `context`, `beats`, `shotNotes`, `backgroundPrompt` có tài liệu mention riêng |

Không phải mọi ô chữ đều là picker: lời thoại Timeline vẫn là văn bản, nhân vật/người nói
được chọn qua ID cast. Bản nháp có thể giữ mention chưa giải quyết để sửa tiếp; sinh ảnh
đơn/batch và chốt dữ liệu cần giải quyết các mention đầu vào, không bỏ qua im lặng.

**Planner dùng lại nhân vật:** phải chọn rõ `reuseCharacterId` trong phạm vi cho phép, không
chỉ vì tên giống thư viện. Chốt dự án giữ ID và chân dung của nhân vật được dùng lại;
chân dung sinh/tải trong phiên chỉ được gắn cho nhân vật mới, không ghi đè thư viện.

## Ảnh tham chiếu và giới hạn provider

Preview server báo prompt hiệu lực, `referenceCount`, `maxReferenceCount`, từng đối tượng
`sent` / `description-only` / `overlay` và cảnh báo. Thumbnail trong thư viện **không có nghĩa**
ảnh đó đã được gửi. `POST /api/generations/preview` không tạo tác vụ và không gọi provider.

- **Ảnh:** tổng ảnh nguồn tải lên/kết quả dùng lại, bối cảnh và tham chiếu nhân vật/đồ vật/logo
  ở chế độ AI phải nằm trong `MAX_SOURCE_IMAGES` (mặc định 4). Đối tượng mention vượt giới
  hạn bị báo lỗi trước khi gửi, không âm thầm mất ảnh tham chiếu. Tham chiếu trùng được xử
  lý theo manifest; không cộng logo ở chế độ overlay như một ảnh AI.
- **Video OpenAI-compatible:** hiện chỉ gửi một ảnh nhân vật chính trong `input_reference`.
  Các nhân vật khác và đồ vật/logo ở chế độ AI chỉ có mô tả; preview cảnh báo rõ. Không giả
  định provider này hỗ trợ nhiều ảnh đồ vật chỉ vì chúng có trong catalog.
- **Agnes:** ảnh thư viện riêng tư không gửi dạng data URL. Khi không bật chia sẻ tạm,
  đối tượng mention chỉ được mô tả và có cảnh báo; `allowTemporaryMedia: false` không tạo
  tham chiếu giả. Bạn vẫn có thể tự nhập URL công khai hợp lệ theo hợp đồng Agnes.
  Bật `useCharacterReference` kiểu riêng tư mà không có URL tạm phù hợp có thể bị từ chối.
- Opt-in URL tạm chỉ dùng cho mode `reference`, không trộn với `text`/`keyframe`. Agnes
  Flash tối đa 5 ảnh (kể cả URL đã nhập tay); model khác theo giới hạn được kiểm tra. Vượt
  giới hạn trả lỗi, không cắt danh sách mention âm thầm. Model/provider quyết định mức độ
  bám ngoại hình, không có cam kết nhận diện hoàn hảo.

## Logo: AI tham chiếu và chèn nguyên bản

Sau khi chọn mention logo, có hai lựa chọn cho mỗi logo:

1. **AI tham chiếu:** gửi ảnh khi hợp đồng provider cho phép và mô tả logo trong prompt.
   Đây là *best-effort*: AI có thể thay chữ, màu hoặc nét; không bảo đảm logo đúng nguyên bản.
2. **Chèn logo nguyên bản (overlay):** không nhờ AI vẽ lại logo. Backend lấy đúng ảnh logo
   đã snapshot, resize/composite bằng `sharp` cho ảnh hoặc `ffmpeg` cho video, tạo asset dẫn
   xuất `logo_overlay` liên kết `sourceAssetId`. **Asset `original` từ provider luôn được giữ.**
   “Nguyên bản” là dùng chính ảnh nguồn, không phải byte-identical với file logo sau resize,
   opacity hay mã hoá video; không phải tracking logo theo bề mặt/vật thể chuyển động.

Tối đa 8 overlay. `x`/`y` là góc trên-trái chuẩn hoá theo khung, `width` theo chiều rộng
khung, `opacity` 0–1; API nhận thêm `startSeconds`/`endSeconds` cho video. Logo phải đã được
chọn bằng ID trong tài liệu mention và có ảnh hợp lệ. Video overlay cần `ffmpeg` và chịu
các giới hạn thời gian/dung lượng xuất.

Trạng thái hậu xử lý độc lập với thành công provider. Nếu ghép lỗi, bản gốc vẫn dùng được;
kiểm tra logo, ffmpeg và quota rồi **Thử ghép lại** (`retry-overlay`). Đây chỉ là retry
**cục bộ**, dùng snapshot cũ, không tạo generation mới và **không resubmit provider**.
Đổi logo thư viện sau đó không đổi logo đã snapshot của tác vụ cũ. Bản dẫn xuất cũng tính quota.

## Chia sẻ media tạm cho Agnes

Mặc định `allowTemporaryMedia` tắt; đồng ý áp dụng **cho từng generation**, không cho cả thư
viện suốt đời. Khi bật, backend chỉ cấp URL cho **đúng ảnh raster trong manifest snapshot
đầu vào của generation đó**, gắn chủ sở hữu/generation và nội dung đã chọn; không nhận đường
dẫn do client tự đưa để cấp quyền tùy ý.

- `APP_ORIGIN` phải là **origin HTTPS công khai** không có đường dẫn/query/thông tin đăng
  nhập. HTTP, localhost, IP private và tên miền nội bộ không được cấp grant, kể cả khi bật
  `ALLOW_PRIVATE_PROVIDER_URLS`. Máy localhost không tự trở thành máy chủ ảnh công khai.
- Quản trị triển khai phải bảo đảm DNS/TLS, origin truy cập được từ provider và endpoint
  `/api/provider-media/:token` đi tới đúng backend. Kiểm tra cấu trúc origin không chứng minh
  domain thực sự có DNS công khai hoặc đang reachable; không chỉ đổi chuỗi cấu hình là đủ.
- URL dùng token quyền đọc ngẫu nhiên, DB lưu hash token; token chỉ có quyền **GET đúng ảnh**,
  không quyền sửa, liệt kê thư viện hay đọc tệp khác. Ai có URL có thể đọc ảnh trong cửa sổ
  cấp quyền: không đăng URL vào log/chat công khai. DTO thông thường không trả token provider.
  Grant do luồng tạo tác vụ cấp có SHA-256 nội dung ảnh; đổi bytes tại cùng đường dẫn làm URL bị từ chối.
- TTL tối thiểu mặc định **2 giờ**, tăng lên theo `VIDEO_POLL_TIMEOUT_MS + 15 phút`, trần **24 giờ**; cấu hình chờ vượt trần bị từ chối trước khi tạo tác vụ. Hết hạn/thu hồi được kiểm tra mỗi lần đọc, không
  cache sống vô hạn. Không có public lifetime và không tự gia hạn cho provider chạy quá lâu.
  Tác vụ không còn hợp lệ cũng không phục vụ grant; khả năng đọc trước đó không thể thu hồi
  các bản sao provider đã tải xuống.
- `POST /api/generations/:id/revoke-media` thu hồi các URL tạm của tác vụ thuộc tài khoản.
  Thu hồi trước khi provider đọc có thể làm tác vụ thất bại. Không có API công khai cấp
  grant theo đường dẫn tuỳ ý; preview chưa phát hành token thật.

## Thùng rác, khôi phục và đổi handle

Xoá đồ vật/logo là soft delete 30 × 24 giờ, giữ ID/metadata/media; kind thùng rác là
`library_asset`. Handle trở thành inactive để mục khác có thể dùng lại. Xoá lặp lại không
gia hạn; xoá khi đang được Canvas/cảnh còn sửa được hoặc snapshot tác vụ chưa xong sử dụng
có thể bị chặn. Hãy gỡ liên kết hợp lệ trước, không dùng đổi tên để tránh kiểm tra danh tính.

Nếu mục mới đã chiếm handle của mục đang trong thùng rác, restore trả **409** và không đổi
ID hay tự thêm hậu tố. Restore hiện **không nhận tên/handle mới**. Endpoint đổi handle yêu
cầu đối tượng đang hoạt động, nên không có đường đổi handle trực tiếp cho mục còn ở trash:

1. Đổi handle **mục đang hoạt động đang chiếm handle** sang một handle còn trống (hoặc giải
   phóng handle bằng thao tác vòng đời hợp lệ).
2. Khôi phục mục cũ trước hạn; nó giữ ID và handle cũ.
3. Nếu cần, đổi tên/handle mục đã khôi phục sau đó. Không tự nối lại liên kết đã tháo.

Mục đã purge không thể khôi phục. Media được dọn có kiểm tra các chủ/tham chiếu, snapshot,
URL tạm còn sống và job nền; không cam kết xoá mọi tệp ngay hoặc thu hồi mọi dung lượng
ngay khi xoá metadata.

## Nâng cấp, đường dẫn bất biến và quota

**Sao lưu database + toàn bộ media + `APP_ENCRYPTION_KEY` trước khi migration**, rồi khởi
động lại backend để áp dụng các migration còn thiếu:

| Migration | Nội dung |
| --- | --- |
| 026 | Library assets và registry handle |
| 027 | Tài liệu prompt/mention và snapshot entity |
| 028 | Liên kết thư viện trong Canvas |
| 029 | Grant URL media tạm |
| 030 | Trạng thái hậu xử lý/logo asset variant |
| 031 | Theo dõi phiên bản media bất biến |

Thay ảnh tạo đường dẫn phiên bản mới, không ghi đè file snapshot đang dùng. Upload tham
chiếu bị thay/gỡ có thể vẫn được giữ vì snapshot hoặc chủ khác. Quota `MAX_USER_MEDIA_BYTES`
tính cả ảnh/video, uploads, export, **media trong trash và phiên bản giữ lại**, gồm bản overlay;
đổi pointer hoặc soft delete không tự giải phóng dung lượng. Cleanup an toàn là có điều kiện
và có retry, không phải bảo đảm không bao giờ có tệp mồ côi hay giải phóng hoàn hảo.

## API

Mọi API quản lý dưới đây cần session; chủ sở hữu lấy từ session, không tin `userId` client.
DTO trả metadata/ID/URL endpoint xác thực, **không trả đường dẫn kho media nội bộ**.

| Endpoint | Chức năng |
| --- | --- |
| `GET /api/entity-library/` | Catalog; query `projectId` tuỳ chọn |
| `GET /api/entity-library/assets` | Danh sách item/logo; `kind`, `search`, `limit` (1–100), `offset` |
| `POST /api/entity-library/assets` | Tạo `{ kind: "item" \| "logo", name, description?, continuityNotes?, handle? }` |
| `PATCH /api/entity-library/assets/:id` | Sửa tên/mô tả/ghi chú; `revision` tuỳ chọn chống ghi đè |
| `DELETE /api/entity-library/assets/:id` | Chuyển vào thùng rác |
| `GET\|POST\|DELETE /api/entity-library/assets/:id/reference` | Xem/upload raw raster/gỡ ảnh tham chiếu |
| `POST /api/entity-library/assets/:id/reference/from-generation` | Gắn `{ generationId, assetId? }` ảnh thành công của chủ |
| `PATCH /api/entity-library/:kind/:id/handle` | Đổi `{ handle }` của đối tượng active; kind `character`, `item`, `logo` |
| `POST /api/generations/preview` | Kiểm tra và trả preview không gọi provider |
| `POST /api/generations` | Tạo; dữ liệu yêu cầu `data.promptDocument`, `data.allowTemporaryMedia`, `data.logoOverlays` (JSON body dùng trực tiếp các khóa đó) |
| `POST /api/generations/:id/retry-overlay` | Retry hậu xử lý cục bộ, không resubmit provider |
| `POST /api/generations/:id/revoke-media` | Thu hồi media grant của tác vụ |
| `POST /api/trash/library_asset/:id/restore` | Restore giữ ID/handle; lỗi nếu handle bị chiếm |
| `DELETE /api/trash/library_asset/:id` | Purge vĩnh viễn trước hạn |

Ví dụ phần dữ liệu tạo (ID là placeholder cần thay bằng ID thực đã chọn):

```json
{
  "modelId": "model-pk",
  "prompt": "Ảnh sản phẩm @den-ban",
  "promptDocument": {
    "version": 1,
    "text": "Ảnh sản phẩm @den-ban",
    "mentions": [
      { "id": "occurrence-id", "start": 13, "end": 21, "label": "den-ban",
        "entity": { "kind": "item", "id": "owned-item-id" } }
    ]
  },
  "allowTemporaryMedia": false,
  "logoOverlays": [],
  "params": {}
}
```

`promptDocument.text` phải khớp `prompt`; span là UTF-16 và khớp chính xác `@label`.
Không gửi `reference.path`, đường dẫn filesystem hoặc URL token tự tạo. Logo overlay dùng
`entityId` của logo đã được mention, kèm `x`, `y`, `width`, `opacity` và thời điểm tuỳ chọn.

## Phạm vi kiểm thử

Các test của tính năng bao phủ chuẩn hoá/collision/cách ly chủ sở hữu; binding theo ID,
rename/recreate/unresolved; lưu quick/cảnh/Canvas/planner; preview và overflow; TTL/thu hồi/
origin grant; overlay giữ original/retry không gọi lại provider; quota/phiên bản và restore
conflict. Test mock kiểm tra hợp đồng/luồng dữ liệu, **không chứng minh** AI giữ logo/khuôn
mặt hoàn hảo hoặc provider bên ngoài đọc được hạ tầng HTTPS của bạn. Tổng test thay đổi theo
bản phát triển: dùng runner để xem số hiện tại, không suy ra toàn bộ suite đã pass chỉ từ
việc có tài liệu này.
