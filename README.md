# Lumina Studio

Workspace tạo ảnh và video bằng API key riêng của người dùng. Nhiều tài khoản, mỗi người có
provider, model, thư viện và API key tách biệt.

## Trạng thái

Ứng dụng **đã có backend đầy đủ**. Người dùng đăng nhập, thêm provider bằng Base URL + API key,
phân loại model thành ảnh/video, rồi tạo nội dung thật qua provider tương thích OpenAI.

- API key được mã hóa **AES-256-GCM** trong database và không bao giờ trả về trình duyệt.
- Tác vụ tạo nội dung chạy nền; đóng tab vẫn tiếp tục, restart backend tự phục hồi.
- Media mặc định lưu riêng tư, phục vụ qua endpoint có xác thực; chỉ khi người dùng bật
  chia sẻ tạm cho từng tác vụ mới cấp URL đọc ảnh giới hạn thời gian cho provider.

> **Trước khi dùng key thật:** đọc mục [Bảo mật](#bảo-mật) và sao lưu `APP_ENCRYPTION_KEY`.
> Mất khóa này thì không giải mã được API key đã lưu.

## Thư viện đối tượng và mention theo ID

**Đồ vật (`item`) và logo (`logo`) dùng chung ở cấp tài khoản**, bên cạnh nhân vật; thêm ảnh
tham chiếu rồi gõ `@` và **chọn từ danh sách** trong Tạo nội dung đơn lẻ, Studio ảnh/video,
Canvas, kịch bản nháp và các trường Timeline. Handle là slug chữ thường bỏ dấu, duy nhất
trong cùng tài khoản **giữa cả nhân vật/đồ vật/logo**, không phải tên toàn cục giữa người dùng.

- Mention lưu **kind + ID**, không tra cứu lại bằng chữ `@tên`: đổi tên/handle không đổi nhãn
  đã lưu và không đổi đích. Xoá rồi tạo lại cùng handle không cứu mention cũ; Canvas legacy
  chỉ có chữ `@` phải chọn lại rõ ràng. Khôi phục không tự gắn lại các liên kết đã bị gỡ.
- Preview cho biết ảnh thật sự gửi, đối tượng chỉ có mô tả và cảnh báo giới hạn. Tạo ảnh tính
  tổng ảnh nguồn + tham chiếu theo `MAX_SOURCE_IMAGES`, không âm thầm bỏ ảnh của mention.
- Logo có **AI tham chiếu (best-effort)** hoặc **chèn logo nguyên bản** sau khi sinh ảnh/video;
  giữ bản provider gốc, thử lại lỗi ghép chỉ chạy cục bộ, không gửi lại provider.
- Agnes chỉ nhận ảnh thư viện qua **URL tạm opt-in** khi `APP_ORIGIN` là HTTPS công khai;
  tắt tuỳ chọn thì chỉ gửi mô tả, không giả vờ đã gửi ảnh. URL theo snapshot từng generation,
  tối thiểu mặc định 2 giờ (tăng theo timeout video + 15 phút), tối đa 24 giờ, chỉ đọc và có thể thu hồi — không phải công khai vĩnh viễn.

**Nâng cấp:** sao lưu database, media và khóa mã hóa **trước migration 026–031**, rồi khởi
động lại backend. Tham chiếu dùng đường dẫn phiên bản bất biến; thùng rác và phiên bản giữ
lại vẫn tính quota, không bảo đảm mọi tệp được dọn ngay. Hướng dẫn phạm vi, khôi phục khi
trùng handle, API và giới hạn: [Thư viện đối tượng](<docs/entity-library.md>).

## Hai chế độ tạo nội dung

Sidebar có các mục riêng biệt:

1. **Tạo nội dung đơn lẻ** — làm việc theo **phiên**: một phiên tạo được **nhiều ảnh/video**, giữ **nhiều nhân vật dùng chung** cho cả phiên, và **chỉnh sửa lại nội dung cũ** (nạp lại mô tả hoặc lấy ảnh cũ làm ảnh nguồn). Không cần dự án.
2. **Studio** — không gian làm việc theo dự án, dùng cho chuỗi cảnh và giọng nói đồng nhất.
3. **Nhân vật** — thư viện nhân vật dùng chung của tài khoản.
4. **Thư viện** — toàn bộ ảnh và video đã tạo.

Các mục độc lập: mở mục nào cũng vào đúng chế độ đó, không còn nút gạt qua lại.

## Phiên tạo nội dung (Tạo nội dung đơn lẻ)

Mục này không còn là một lần tạo duy nhất: mỗi lần mở là một **phiên** lưu trên server,
mở lại URL `?page=quick&session=<id>` hoặc tải lại trang vẫn còn nguyên.

- **Nhiều nội dung trong một phiên** — mỗi lần bấm Tạo sinh thêm một ảnh/video. Danh sách
  nằm tại **Kết quả gần đây**, cạnh composer trên desktop; tab Tạo ảnh chỉ hiện ảnh,
  tab Tạo video chỉ hiện video. Tác vụ mới nhất luôn ở đầu (theo lúc gửi yêu cầu, không
  theo lúc hoàn tất), ban đầu hiện 6 và có **Xem thêm** trong tối đa 100 tác vụ đã tải.
  Tablet/mobile có lối tắt **Xem kết quả**; mọi thẻ đã mở đều xem được, không ẩn thẻ thứ hai.
  Xoá kết quả trong phiên chỉ xoá kết quả đó.
- **Tiến trình video rõ ràng** — dưới nút Tạo video luôn có trạng thái Đang gửi / Đang tạo,
  số tác vụ đang chạy, prompt và nút **Xem tiến trình**. Thẻ video đang chờ/xử lý/tải có
  vòng xoay lớn và thanh tiến trình; chỉ hiện % thật do provider báo, dùng thanh chạy khi
  chưa có tiến độ. Tải lại trang vẫn theo dõi; thành công/thất bại/chưa xác định dừng animation.
- **Nhiều nhân vật, đồng nhất nhận diện** — ô *Nhân vật* trong phiên cho thêm/bớt nhân vật
  (tối đa **6**); chọn một nhân vật trong danh sách là **thêm** vào phiên, chip hiển thị
  đủ danh sách và nút bỏ. Phiên lưu danh sách này nên mọi lần tạo sau (kể cả sau khi tải
  lại) đều dùng đúng bộ nhân vật đó; nhân vật đầu tiên là nhân vật chính.
- **Sửa lại nội dung cũ** — mỗi thẻ kết quả có hai hành động:
  - **Sửa mô tả**: nạp lại mô tả, kích thước/chất lượng/số ảnh/thời lượng và model của kết
    quả cũ vào composer, kèm banner *Đang sửa từ…*. Bấm Tạo sẽ sinh **một nội dung mới**
    trong cùng phiên; bản cũ **vẫn được giữ** (dạng các phiên bản nối tiếp).
  - **Dùng làm ảnh nguồn**: thêm chính ảnh đã tạo vào **Ảnh nguồn**, để model tạo ảnh mới
    từ ảnh đó (`/images/edits`). Ảnh nguồn vẫn có thể lấy từ tệp tải lên như trước.
- **Xoá phiên** không xoá kết quả: các tác vụ chỉ mất liên kết phiên và vẫn nằm trong
  **Thư viện**. Xoá nhân vật khỏi thư viện thì phiên tự bỏ nhân vật đó.
- **Giới hạn**: 6 nhân vật mỗi phiên; tổng ảnh nguồn + tham chiếu nhân vật/đồ vật/logo cho ảnh
  theo `MAX_SOURCE_IMAGES` (mặc định 4). Video **OpenAI-compatible** chỉ gửi một ảnh nhân vật
  chính; Agnes dùng hợp đồng URL riêng. Preview báo ảnh đã gửi/description-only, không cắt
  ảnh mention vượt giới hạn âm thầm; xem [giới hạn provider](<docs/entity-library.md#ảnh-tham-chiếu-và-giới-hạn-provider>).
- **API**: xem bảng [API](#api) — nhóm *Phiên tạo nội dung* và các trường thêm của
  `POST /api/generations`.

## Canvas trong Studio: node, sản phẩm/đạo cụ và @đối tượng

Mỗi dự án có thêm tab **Canvas**: một bảng nền tối có lưới chấm, node kéo thả và dây nối
màu theo loại dữ liệu. Đây là nơi dựng cảnh từ nhân vật, bối cảnh và sản phẩm/đạo cụ rồi
chạy ảnh/video ngay trên node.

- **Node**: Prompt, Ảnh đầu vào, Nhân vật, Bối cảnh, Sản phẩm/đạo cụ, Thư viện (đồ vật/logo),
  Character sheet, Tạo ảnh, Tạo video và Ghi chú (ghi chú không bao giờ được gửi cho provider).
- **Cổng và dây nối**: text (xanh dương), ảnh (xanh lá), đối tượng (tím), video (cam).
  Chỉ nối được cổng tương thích; server kiểm tra lại cấu trúc, kiểu cổng và chu trình khi lưu.
- **@đối tượng**: gõ `@` rồi chọn nhân vật/đồ vật/logo từ picker để lưu mention theo **ID**;
  không cần tạo dây nối giả cho mention thư viện. `\@` là ký tự thường. Mention thiếu binding
  hoặc trỏ tới ID đã xoá sẽ **chặn chạy**; chữ `@` trong Canvas legacy phải được chọn lại,
  không tra tên toàn cục. Bối cảnh và vật phẩm cục bộ vẫn dùng node/dây nối cho ngữ cảnh.
- **Sản phẩm / đạo cụ**: vật phẩm cục bộ dự án vẫn tạo qua Canvas/API (`kind`: `product` |
  `prop`); đồ vật/logo dùng chung tài khoản chọn từ thư viện (node Thư viện hoặc picker).
  Mỗi mục có mô tả, ghi chú liên tục và ảnh tham chiếu. Xoá đối tượng/cảnh còn được bảng đang
  sửa sử dụng có thể bị chặn cho tới khi gỡ liên kết; xem [vòng đời đối tượng](<docs/entity-library.md#thùng-rác-khôi-phục-và-đổi-handle>).
- **Bố trí cảnh**: node Tạo ảnh/Tạo video có nút *Bố trí cảnh* — kéo đặt đối tượng lên nền,
  chỉnh rộng/cao/xoay/lật/lớp, có ô số cho bàn phím. Toạ độ lưu chuẩn hoá nên không phụ thuộc
  màn hình; đây là chỉ dẫn *best-effort* cho model, không bảo đảm từng pixel.
- **Xem trước rồi mới chạy**: mỗi node sinh nội dung có **Run** riêng. Lần đầu (hoặc khi đầu
  vào đổi) hiện bảng *Nội dung sẽ gửi*: prompt hiệu lực, ảnh thật sự gửi, ảnh bị bỏ vì quá
  giới hạn và cảnh báo chi phí; chỉ sau khi xác nhận mới gửi yêu cầu. Không có Run all, không
  tự chạy node phía trước và đổi dây nối không tạo generation.
- **Ghép bản bố trí (chỉ node tạo ảnh)**: nút *Dùng bản bố trí làm ảnh nguồn* render nền và
  các lớp bằng `sharp`, lưu thành một upload PNG riêng rồi đặt làm ảnh nguồn của node. Server
  chỉ đọc tệp trong kho media của chính tài khoản, không tải URL do client cung cấp; ảnh ghép
  là đầu vào tham chiếu, không phải cam kết model giữ nguyên từng pixel.
- **Giới hạn vào**: ảnh của vật phẩm/đầu ra node trước đi qua `sourceUploadIds`, ảnh nhân vật
  đi qua danh sách nhân vật; vượt `MAX_SOURCE_IMAGES` thì preview báo rõ và lúc chạy trả lỗi
  thay vì cắt bớt âm thầm.
- **Video**: node video gắn một cảnh Studio — cảnh vẫn là nguồn sự thật cho lời thoại, người
  nói, model và phiên bản. Agnes nhận URL công khai do bạn nhập hoặc ảnh thư viện qua URL tạm
  khi bật opt-in và đủ điều kiện HTTPS; mặc định không công khai ảnh nội bộ. OpenAI-compatible
  hiện chỉ gửi một ảnh nhân vật chính; đồ vật/logo ở chế độ AI chỉ được mô tả, có cảnh báo.
- **Lưu**: tự lưu sau khi ngừng sửa, kèm `revision` chống ghi đè giữa hai tab (lệch revision
  trả 409 và giao diện yêu cầu tải lại). Undo/Redo chỉ áp cho thao tác bảng trong phiên trình
  duyệt, không hoàn tác request đã gửi.
- **API**: `GET|POST /api/projects/:id/items`, `PATCH|DELETE /api/projects/:id/items/:itemId`,
  `POST|DELETE /api/projects/:id/items/:itemId/reference`,
  `POST /api/projects/:id/items/:itemId/reference/from-generation|generate`,
  `GET|PUT /api/projects/:id/canvas`, `GET /api/projects/:id/canvas/runs`,
  `POST /api/projects/:id/canvas/nodes/:nodeId/preview|run`. `run` yêu cầu `stamp` khớp preview
  đã xác nhận. Snapshot của tác vụ ghi lại node, mention, ảnh đã gửi và bố trí nên tác vụ cũ
  không đổi khi sửa nguồn.

**Chưa có trong bản này**: Run all/auto-run theo dây chuyền, cộng tác realtime, tách nền bằng
AI và editor animation.

## Thùng rác chung (30 ngày)

Mở **Thùng rác** trên sidebar (URL `?page=trash`). Dữ liệu bị xoá khỏi nơi làm việc
nhưng được giữ nguyên ID, nội dung và media trong **30 × 24 giờ** từ lần xoá:

- **Dự án Studio**: giữ cấu trúc cảnh, Canvas, vật phẩm và các dữ liệu con như trước.
- **Nhân vật**: giữ hồ sơ và ảnh tham chiếu. Các liên kết cảnh/Canvas/phiên đã gỡ
  không tự gắn lại khi khôi phục. Nhân vật thuộc dự án đang trong thùng rác cần khôi
  phục dự án trước; nếu dự án đã dọn thì nhân vật trở thành nhân vật thư viện.
- **Đồ vật/logo thư viện**: giữ ID, metadata và ảnh tham chiếu trong 30 ngày (`library_asset`).
  Handle được giải phóng khi xoá; khôi phục bị chặn nếu handle cũ đã được mục khác chiếm.
  Đổi handle mục **đang hoạt động** đó để giải phóng rồi khôi phục; API restore không nhận tên
  mới, và endpoint đổi handle không sửa mục đang trong thùng rác. Không tự gắn lại liên kết đã gỡ.
- **Ảnh/video trong Thư viện**: giữ generation, snapshot và asset. Kết quả đã xoá
  không dùng được làm nguồn cho tác vụ mới. Khôi phục không gọi lại provider.
- **Kịch bản / Timeline**: là một mục duy nhất, giữ cả hội thoại, kịch bản, dàn nhân
  vật, bối cảnh, timeline và dữ liệu con của phiên. Khôi phục không tự chạy lại batch.

Trang chung có bộ lọc, số lượng, thumbnail, ngày xoá/hết hạn, **Khôi phục**, **Xoá
vĩnh viễn** và **Dọn sạch thùng rác** (hai thao tác vĩnh viễn đều phải xác nhận).
Hết 30 ngày không thể khôi phục; worker tự dọn khi backend hoạt động, hoặc sau khi
backend khởi động lại. Gửi lại lệnh xoá không gia hạn. Dung lượng media trong thùng
rác vẫn tính vào quota; file chỉ được dọn khi hết hạn hoặc xoá vĩnh viễn và không còn
tham chiếu dùng chung. Lỗi dọn file được lưu thành job để thử lại.

Mục đang có tác vụ chờ/chạy/chưa xác định, batch hoặc export liên quan sẽ bị chặn
xoá gây mất dữ liệu. Thùng rác và thao tác khôi phục/dọn đều cách ly theo tài khoản.
Dọn dự án không rút ngắn hạn của nhân vật/kết quả đã xoá riêng và còn hạn độc lập.
Dữ liệu đã xoá cứng trước bản cập nhật này không thể cứu lại.

Phạm vi là **xoá nguyên mục** trên: xoá riêng cảnh/khung timeline/biến thể, gỡ ảnh,
provider/model, log, uploads, phiên tạo nhanh và bản xuất riêng vẫn giữ hành vi cũ.
Ảnh đã sinh của phiên kịch bản vẫn ở Thư viện khi xoá phiên.

API: `GET /api/trash?kind=&limit=&offset=`,
`POST /api/trash/:kind/:id/restore`, `DELETE /api/trash/:kind/:id`, `DELETE /api/trash`.
Kind: `project`, `character`, `generation`, `plan_session`, `library_asset`. Khởi động lại backend
để áp dụng các migration còn thiếu (025 cho thùng rác chung; 026–031 cho thư viện đối tượng,
mention, URL tạm và phiên bản media); sao lưu trước khi nâng cấp.

## Thùng rác dự án Studio

- Nút **Xóa** có trên thẻ dự án và trong màn hình chi tiết. Hộp thoại xác nhận cho phép **Hủy**; tùy chọn **Xóa cả tệp kết quả sau 30 ngày** mặc định **tắt**.
- Dự án chuyển vào **Thùng rác** trong **30 ngày** (không phải xóa ngay). Mở bộ lọc Thùng rác và bấm **Khôi phục** trước hạn; trạng thái lưu trữ được giữ nguyên, nhưng cảnh không tự động chạy lại tác vụ sinh nội dung.
- Không thể chuyển vào thùng rác khi dự án còn tác vụ tạo nội dung hoặc xuất video đang chờ/chạy/chưa xác định kết quả. Dự án trong thùng rác không cho tạo thêm tác vụ.
- Sau hạn, tác vụ bảo trì nền xóa cấu trúc dự án. Mặc định kết quả đã tạo vẫn còn trong **Thư viện**; chỉ khi bật tùy chọn trên thì kết quả độc quyền của dự án mới được xóa cùng tệp của chúng.
- Nhân vật thư viện dùng chung, ảnh tải lên cấp tài khoản, kết quả/tệp còn được dự án khác sử dụng không bị xóa dây chuyền. Nhân vật riêng đang được cảnh khác dùng được giữ lại an toàn. Xóa tệp thất bại được ghi nhận để thử lại, không xóa nguyên thư mục người dùng.
- API: `GET /api/projects` bỏ qua dự án đã xóa; `GET /api/projects?trash=true` trả dự án còn trong hạn khôi phục; `POST /api/projects/:id/trash` nhận `{ "deleteResults": false }` (mặc định); `POST /api/projects/:id/restore` khôi phục. Gửi lại lệnh chuyển thùng rác không gia hạn hay thay đổi tùy chọn đã chốt; hết hạn không thể khôi phục.

## Thư viện nhân vật dùng chung

Mục **Nhân vật** trên sidebar quản lý nhân vật ở cấp tài khoản, **không buộc thuộc một dự án**:

- Mỗi nhân vật có tên, mô tả ngoại hình, hồ sơ giọng nói và **ảnh tham chiếu** (PNG, JPEG, WebP, GIF; tối đa 5 MB).
- Bấm ảnh trong thẻ nhân vật để mở trình xem phóng to.
- Ảnh tham chiếu lưu trong kho media riêng tư, chỉ phục vụ qua `/api/characters/:id/reference` sau khi kiểm tra quyền sở hữu; định dạng nhận dạng bằng **magic bytes**, không tin `Content-Type`.
- Nhân vật dùng chung dùng được ở **Tạo nội dung đơn lẻ** và trong **mọi dự án Studio**.
- Khi thêm nhân vật trong Studio, ô **Phạm vi sử dụng** cho chọn *Dùng chung (Thư viện)* — mặc định — hoặc *Chỉ dự án này*.
- Nhân vật tạo trực tiếp trong một dự án vẫn thuộc dự án đó; danh sách nhân vật của dự án bao gồm cả nhân vật thư viện, mỗi thẻ ghi rõ **Thư viện dùng chung** hay **Trong dự án**. Sửa hoặc xóa nhân vật thư viện ngay trong Studio vẫn gọi đúng endpoint dùng chung.
- **Xóa nhân vật đang được dùng**: nếu nhân vật còn nằm trong cảnh/Canvas của dự án
  **còn sửa được**, việc xóa bị chặn và hộp thoại nêu rõ tên dự án, số cảnh/node Canvas
  cùng trạng thái dự án; bấm **Gỡ khỏi các cảnh/Canvas và xoá** (`DELETE .../?detach=1`)
  để gỡ rồi xóa. Cảnh giữ nguyên lời thoại, chỉ mất người nói.
- Nhân vật chỉ còn trong dự án **đã lưu trữ** hoặc **đang ở Thùng rác** thì xóa được ngay:
  hai trạng thái đó không sửa được nên server tự gỡ tham chiếu, tránh việc nhân vật bị
  giữ tới lúc dự án hết hạn purge.

## AI tạo nhân vật từ mô tả

Trong trang **Nhân vật**, nút **AI tạo nhân vật** dùng model **LLM & Chat** đã phân loại trong Model catalog để gợi ý nhân vật mẫu:

1. Nhập **mô tả** (ví dụ *"một phi hành gia trẻ, điềm tĩnh, người Việt"*), chọn số lượng 1–6, **model tạo ảnh** và tick **Lưu nhân vật vào thư viện ngay** (mặc định bật).
2. Bấm **một nút**: `Tạo N nhân vật + ảnh`. AI viết hồ sơ (tên, ngoại hình, 7 trường giọng nói), rồi **tự tạo ảnh tham chiếu cho từng nhân vật** và — nếu tick lưu ngay — **ghi thẳng vào thư viện kèm ảnh**, không phải bấm từng thẻ.
3. Ảnh chạy theo **pool 2 tác vụ song song** (khớp trần `MAX_CONCURRENT_JOBS_PER_USER`); mỗi thẻ hiện `Chờ → Đang tạo ảnh… x% → Đã lưu`, có **Thử lại ảnh**, **Thêm kèm ảnh**, **Thêm không kèm ảnh** và nút **Huỷ** giữa chừng (nhân vật đã lưu vẫn giữ).
4. Bấm **Tạo lại** để xin bộ gợi ý khác. Tắt tick “Lưu ngay” nếu chỉ muốn xem trước rồi tự bấm **Thêm vào danh sách**.

**Ảnh tham chiếu là một "phiếu thiết kế" (character sheet)** gồm **cận mặt chính diện + toàn thân nhìn trước, sau, nghiêng trái, nghiêng phải** trong cùng một ảnh, cùng khuôn mặt/trang phục/tóc, nền trung tính, không chữ. Prompt do **server** dựng (`server/characters/portrait.ts`) nên mọi lối vào — AI tạo nhân vật ở trang Nhân vật, **Minh hoạ** cho nhân vật đã lưu, và ảnh chân dung nhân vật trong **Tạo kịch bản AI** — dùng đúng một chuẩn, kích thước `1024x1024`.

**Phóng to ảnh:** bấm ảnh (ảnh trong lúc tạo, ảnh chân dung trong Tạo kịch bản AI, ảnh nền frame, hoặc ảnh tham chiếu của nhân vật đã lưu) để mở trình xem: lăn chuột hoặc nút `+`/`−` để thu phóng 50–800%, kéo để di chuyển, `Esc` để đóng, có nút tải xuống.
- Prompt yêu cầu AI trả JSON thuần và tự tránh trùng tên với nhân vật đã có; dữ liệu trả về được kiểm tra bằng đúng schema của API tạo nhân vật.
- **Không gửi `response_format`** để tương thích nhiều gateway; JSON được bóc cả khi model bọc trong rào markdown.
- Chưa có model **LLM & Chat** thì hộp thoại hướng dẫn mở **API & Models**; chưa có model ảnh thì vùng minh hoạ cũng hướng dẫn tương tự.
- Mỗi lần sinh tiêu tốn token trong key của bạn, nên có giới hạn `RATE_LIMIT_LLM_CHAT_PER_MIN` (mặc định 10 lần/phút).

### Ảnh minh hoạ và ảnh tham chiếu

Mỗi thẻ nhân vật đã lưu có hai tiện ích:

- **Minh hoạ** — chọn model tạo ảnh hiện có để sinh ảnh chân dung; khi xong, ảnh **tự động trở thành ảnh tham chiếu** của nhân vật (thay ảnh cũ nếu có).
- **Prompt** — mở prompt hoàn chỉnh của nhân vật (tên + ngoại hình + giọng nói + câu chốt giữ nhất quán) để **sao chép** và dán vào công cụ tạo ảnh/video khác.

Ảnh là **tác vụ tạo ảnh thật**: dùng model và API key của bạn, có thể phát sinh chi phí và **xuất hiện trong Thư viện**. Hộp thoại AI tạo nhân vật hiện rõ **số ảnh tối đa sẽ dùng** trước khi chạy, và có nút **Huỷ**. Ảnh được sao chép ngay trên server từ kho media của tác vụ sang thư mục ảnh tham chiếu, không tải vòng qua trình duyệt.

**Giới hạn:** chất lượng phụ thuộc model; model không trả JSON hợp lệ sẽ báo lỗi để bạn thử lại. Nếu tài khoản đang chạy tác vụ ảnh khác, hàng đợi tự chờ rồi thử lại thay vì báo lỗi cứng.

## Tạo kịch bản AI: từ ý tưởng đến video hoàn chỉnh

Mục **Tạo kịch bản AI** trên sidebar biến một ý tưởng thành dự án Studio có kịch bản, nhân vật và
timeline. Luồng gồm **bước chọn model** rồi **ba tab**, mỗi thao tác gọi AI đều hiện rõ trạng thái
đang chờ.

**Bước 0 — chọn model.** Bấm icon **Cấu hình model** ở thanh trên cùng để chọn:

- **Model chat AI** (phân loại *LLM & Chat*) — bắt buộc, dùng để trò chuyện và viết kịch bản;
- **Model AI hình ảnh** (phân loại *Tạo ảnh*) — dùng để sinh ảnh chân dung nhân vật và ảnh nền frame;
- **Model video** (phân loại *Tạo video*) — dùng khi các cảnh được tạo trong Studio.

Chưa chọn model chat thì ba tab chưa mở; đổi model bất cứ lúc nào ở thanh cấu hình phía trên.

**Ô nhập tin nhắn tự giãn** theo nội dung, tối đa **30% chiều cao màn hình** (`max-height: 30dvh`)
rồi cuộn bên trong ô — gõ đoạn dài vẫn đọc lại được toàn bộ; xoá text thì ô co về một dòng và khung
chat không bị trôi.

**Bước 1 — bắt buộc chọn model chat.** Phiên mới **không** tự gán model: trang hiện **cổng cấu hình
model** và ô nhắn bị khoá cho tới khi bạn chọn model chat (chọn ngay trong cổng). Model ảnh và video
là tuỳ chọn — chọn khi cần tạo ảnh/video, còn lại hệ thống chỉ cảnh báo. Nhờ vậy bạn luôn biết mình
đang tiêu token bằng model nào.

**Chat là bề mặt chính.** Trang mở thẳng vào khung chat lớn; **panel kịch bản nháp / nhân vật /
timeline đóng mặc định** và chỉ mở khi bạn bấm nút tương ứng (drawer trượt từ phải). Danh sách phiên
và cấu hình model cũng nằm sau icon để không chiếm chỗ. Nút **Kịch bản nháp** được làm nổi bật (và có
thẻ CTA ngay trên khung chat): chưa có kịch bản thì bấm để AI viết, đã có thì bấm để mở panel xem/sửa
kèm số cảnh. Nhắn trực tiếp cho AI như một agent: AI vừa
trả lời, vừa cập nhật phần đang chọn, và có thể **tự chạy một bước** khi bạn yêu cầu rõ (ví dụ “lên
timeline cho tôi”) — tối đa một bước mỗi tin nhắn, có thông báo lại. Ngoài ra có **chip hành động
nhanh** *Viết kịch bản · Đề xuất nhân vật · Lên timeline* để chạy đúng bước mà không phụ thuộc vào
việc AI đoán ý.

**Panel 1 — Kịch bản nháp.** Mở bằng icon *Kịch bản nháp*:

- Bấm **AI viết kịch bản** — AI đọc hội thoại và trả về bản kịch bản đầy đủ: phần **text** ở trên để
  sửa trực tiếp, phần **danh sách cảnh** ở dưới (tiêu đề, bối cảnh, hành động, lời thoại, nhân vật,
  người nói, số giây, ghi chú góc máy).
- Sửa tay rồi bấm **Lưu nháp**, hoặc **nhắn tiếp cho AI** để nó viết lại — câu trả lời và artifact
  cập nhật về trong cùng một lần gọi, nên hai cách sửa luôn ghi vào một chỗ.
- Bấm **Tạo ý tưởng nhân vật** để sang tab kế tiếp.

**Chat sửa timeline và bối cảnh & tính liên tục — có bước chốt.** Khu **Bối cảnh & tính liên tục** có
nút **Chat với AI** mở cửa sổ chat từ mép phải (cùng giao diện với chat ở trang Timeline), và cửa sổ
đó có hai bề mặt: *Timeline* và *Bối cảnh & liên tục*. Mạch hội thoại dùng chung với phiên nên AI luôn
có ngữ cảnh đã trao đổi trước đó, kèm toàn bộ dữ liệu: kịch bản, nhân vật, khung, danh sách bối cảnh
(mô tả + ghi chú liên tục + prompt ảnh) và cảnh nào đang gắn bối cảnh nào.

Khi bạn ra lệnh sửa, AI **không ghi ngay**: hệ thống trả về **thẻ đề xuất** gồm tóm tắt và **danh sách
thay đổi cụ thể** (thêm / sửa / xoá / gắn bối cảnh / đổi thứ tự, kèm giá trị trước → sau). Bạn bấm
**Áp dụng thay đổi** thì mới ghi, hoặc **Bỏ đề xuất** để không đổi gì. Danh sách thay đổi do server tự
so sánh hiện tại với đề xuất, không phải lời AI tự khai. Nếu dữ liệu đã bị đổi trong lúc AI đang đề
xuất, lần áp dụng bị từ chối (409) để không ghi đè thay đổi mới — hãy yêu cầu lại. Các nút chạy bước rõ
ràng (*Viết kịch bản*, *Đề xuất nhân vật*, *Lên timeline*, *AI đề xuất bối cảnh*) vẫn ghi trực tiếp như trước.

**Panel 2 — Nhân vật.** Mở bằng icon *Nhân vật*: AI đề xuất danh sách nhân vật (tên, ngoại hình, vai, hồ sơ giọng) từ kịch bản.
Mỗi nhân vật sửa trực tiếp, có **ảnh chân dung** sinh bằng model ảnh hoặc tải ảnh lên — ảnh này trở
thành **ảnh tham chiếu** của nhân vật mới khi chốt; nhân vật được dùng lại theo ID giữ ảnh đã có.
Chọn **Nơi lưu** cho từng nhân vật mới: *Thư viện
dùng chung* hoặc *Chỉ dự án này*. Vẫn có khung chat để nhờ AI sửa, và nút **Lên timeline**.

**Trang Timeline (storyboard ngang).** Timeline là **một trang riêng** (mục *Timeline* trên sidebar,
hoặc nút *Timeline* / bước “Lên timeline” trong Tạo kịch bản AI). Các frame xếp **theo chiều ngang**
như một video brief nên nhìn được nhiều frame cùng lúc; cuộn ngang trong dải storyboard, không cuộn cả trang.

Timeline hiển thị **kiểu node**: mỗi frame là một node có cổng vào/ra và **mũi tên nối** sang node kế
tiếp, nên nhìn là biết ngay thứ tự phát. **Kéo một node** thả vào vị trí khác để nối lại chuỗi; thứ tự
node chính là thứ tự ghép video khi xuất. Vẫn có nút *Sang trái/Sang phải* trong khung sửa để đổi thứ
tự bằng bàn phím.

Khi mở trang Timeline mà **chưa gắn phiên nào** (`?page=timeline` không có `session`), trang hiện **danh
sách timeline dạng thẻ** giống dashboard dự án ở Studio: mỗi thẻ có **ảnh bìa storyboard** (frame đầu
tiên đã có ảnh), **trạng thái phiên**, **số frame**, **tổng thời lượng**, **số nhân vật** và **lần cập
nhật gần nhất**; bấm một thẻ để mở storyboard của timeline đó, và nút *Danh sách timeline* ở đầu trang
storyboard đưa quay lại danh sách. Phiên chưa có ảnh storyboard hiện khung bìa giữ chỗ.

Mỗi thẻ frame cho biết **khoảng thời gian (0:00–0:08) · thời lượng · ảnh storyboard · số người** và
**từng người làm gì, đứng đâu**. Thời điểm bắt đầu/kết thúc được tính cộng dồn từ thời lượng nên đổi
thứ tự frame là thời gian tự cập nhật.

- Chọn một thẻ để sửa ở khung dưới: tiêu đề, thời lượng, bối cảnh, hành động chung, **nhịp hành động
  theo thời gian**, lời thoại, người nói, góc máy; kèm **danh sách nhân vật trong frame** với *hành
  động riêng*, *biểu cảm khuôn mặt & ánh mắt* và *vị trí* (bên trái · chính giữa · bên phải · phía
  sau). Số người lấy trực tiếp từ danh sách này nên không bị lệch.
- Nút **Thêm/Xoá nhân vật**, **Sang trái/Sang phải** (đổi thứ tự), **Nhân bản**, **Xoá frame**, và
  **AI sắp xếp frame** — AI chỉ sửa đúng frame đang chọn, giữ nguyên frame khác và ảnh đã gắn; biểu
  cảm bạn đã gõ không bị xoá nếu model không trả về trường này.
- **Biểu cảm và hành động càng chi tiết thì video càng chân thực:** AI được yêu cầu mô tả cụ thể ánh
  mắt, lông mày, khoé miệng, cường độ cảm xúc cho **từng người** trong frame, và nhịp hành động
  2–4 nhịp (mở đầu → diễn biến → kết thúc) trong đúng số giây của frame; cấm từ chung chung như
  “vui vẻ”, “đứng”, “nói”. Những mô tả này đi thẳng vào **prompt ảnh storyboard** và **prompt video**
  khi chốt dự án.
- **Sinh ảnh storyboard** cho từng frame: ảnh là **cảnh hoàn chỉnh có nhân vật**, prompt do server dựng
  từ bối cảnh, góc máy, vị trí và hành động riêng của từng người; **ảnh chân dung của những nhân vật có
  mặt được gửi kèm làm ảnh tham chiếu** để giữ nhận diện. Bấm ảnh để xem phóng to.
- **Sinh tất cả ảnh**: hỏi xác nhận (số frame + model + cảnh báo chi phí), mặc định **chỉ tạo frame chưa
  có ảnh**, có tuỳ chọn *Tạo lại cả ảnh đã có*. Batch chạy **tuần tự từng frame** theo trần tác vụ của
  tài khoản, hiện tiến trình và trạng thái từng thẻ (*Đang chờ tới lượt · Đang tạo ảnh… · Lỗi ảnh · Đã
  dừng*), có nút **Dừng** và **Thử lại frame lỗi**. Trạng thái nằm ở server nên tải lại trang vẫn theo
  dõi tiếp và không gửi trùng tác vụ; nếu một frame bị sửa/xoá giữa chừng, kết quả không bị gắn nhầm
  (ảnh vẫn nằm trong Thư viện). Nhân vật chưa có chân dung sẽ được cảnh báo trước khi chạy.
- **Chat với AI** ngay trong trang Timeline (mở/ẩn) để nhờ AI sửa timeline.
- Cuối cùng chọn **tên dự án**, **model video**, tuỳ chọn tự động xếp hàng khi duyệt rồi bấm
  **Chốt & tạo dự án**.

**Phản hồi khi đang chờ:** mọi thao tác gọi AI đều đổi nhãn nút thành trạng thái đang chạy (**Đang
viết kịch bản…**, **Đang tạo nhân vật…**, **Đang lên timeline…**, **Đang tạo dự án…**, **Đang sinh
ảnh…**) kèm spinner và một khung thông báo nói rõ AI đang làm gì cùng số giây đã chờ. Khung chat hiện
bong bóng *đang soạn*, ảnh đang sinh hiện khung chờ — bạn không phải đoán ứng dụng còn chạy hay đứng.

**Chốt vào Studio.** Nút chốt tạo dự án mới với nhân vật + cảnh (mang theo **thời gian**, **bối cảnh**
và **ảnh nền** của từng frame) ở trạng thái **chưa duyệt**, nên **chưa phát sinh chi phí**. Ảnh nền
được sao chép thành ảnh nguồn của cảnh, tài liệu mention giữ ID, và chân dung chỉ gắn cho nhân vật
mới; không ghi đè chân dung nhân vật thư viện được dùng lại.

Điểm quan trọng về an toàn chi phí: cảnh mới luôn ở trạng thái chưa duyệt. Chỉ khi bạn duyệt một cảnh
trong Studio thì cảnh đó mới được xếp hàng tạo nội dung. Bật **tự động xếp hàng khi duyệt** để hệ
thống tự tạo lần lượt; vì giới hạn `MAX_CONCURRENT_JOBS_PER_USER`, các cảnh được tạo theo hàng đợi và
tiếp tục chạy kể cả khi bạn đóng tab.

Cổng được ép ở **server**: không thể sinh kịch bản khi chưa chọn model chat, không thể sinh ảnh khi
chưa chọn model ảnh, và không thể chốt khi timeline chưa có frame.

**Gợi ý nhân vật "để không bị lỗi":** AI bắt buộc nêu cảnh báo cho các rủi ro làm video lệch — quá
nhiều nhân vật cho một video ngắn, nhân vật thiếu mô tả ngoại hình, cảnh có lời thoại mà thiếu người
nói, cảnh cần nhiều hơn một người nói (phải tách cảnh), hoặc bỏ phí nhân vật đã có trong thư viện.
Dùng lại nhân vật thư viện phải chọn rõ **ID** (`reuseCharacterId`) trong phạm vi cho phép;
không tự dùng lại chỉ vì trùng tên. Khi chốt, nhân vật được dùng lại giữ nguyên chân dung đã có,
không bị ảnh chân dung của phiên ghi đè; ảnh phiên chỉ gắn cho nhân vật mới.

**Chế độ trong dự án (copilot):** cùng mục Tạo kịch bản AI nhưng gắn với một dự án đang mở, dùng để
bổ sung cảnh/nhân vật cho dự án đó thay vì tạo dự án mới.

**Phiên cũ:** phiên tạo trước khi có bản này vẫn mở được — máy chủ suy ra kịch bản/nhân vật/timeline
từ dữ liệu `ideas_json`/`plan_json` đã lưu; chỉ cần chọn lại model ảnh/video trong thanh cấu hình.

**Giới hạn:** chất lượng phụ thuộc model — model không trả JSON hợp lệ sẽ được giữ nguyên artifact cũ
và báo lỗi để thử lại. Mỗi lần chat/viết kịch bản/sinh timeline tốn token, mỗi lần sinh ảnh tốn phí
theo model ảnh của bạn (giới hạn `RATE_LIMIT_LLM_CHAT_PER_MIN`).

## Nhiều nhân vật trong một cảnh

Mỗi cảnh có **một người nói chính** (sở hữu lời thoại và hồ sơ giọng) cùng **danh sách nhân vật xuất hiện** trong cảnh:

- Người nói chính luôn đứng đầu danh sách, nên ảnh tham chiếu gửi cho provider theo thứ tự ổn định.
- Khi tạo **ảnh**, mọi ảnh tham chiếu của nhân vật trong cảnh đều được gửi kèm (trong giới hạn ảnh đầu vào).
- Khi tạo **video OpenAI-compatible**, chỉ ảnh của người nói chính được gửi; nhân vật phụ và đồ vật được mô tả bằng văn bản, preview có cảnh báo. Agnes có hợp đồng URL tham chiếu riêng và tuỳ chọn chia sẻ tạm, xem [giới hạn theo provider](<docs/entity-library.md#ảnh-tham-chiếu-và-giới-hạn-provider>).
- Xóa nhân vật đang nằm trong bất kỳ cảnh nào sẽ bị chặn — gỡ khỏi cảnh trước.

## Xuất video hoàn chỉnh

Trong dự án, chức năng **Xuất video** ghép các cảnh đã tạo thành **một tệp duy nhất** theo đúng thứ tự timeline:

- Trong Studio, mở dự án rồi bấm **Xuất video** ở header: hộp thoại hiện yêu cầu, nút **Bắt đầu xuất**, tiến trình và danh sách các bản xuất gần đây kèm nút **Tải về** / **Xóa**. Danh sách tự làm mới khi còn bản đang chạy, và dừng làm mới khi đóng hộp thoại.
- Mặc định lấy mọi cảnh của dự án, mỗi cảnh dùng bản bạn đã chọn hoặc bản thành công mới nhất; cũng có thể chỉ định danh sách cảnh.
- **Thứ tự ghép chính là thứ tự node trên timeline** — kéo node để đổi thứ tự trước khi chốt dự án.
- Mỗi cảnh phải có **video thành công**; chỉ một cảnh chưa có video là server từ chối và nêu rõ tên cảnh. Ảnh storyboard không dùng để ghép.
- Tác vụ chạy **nền trong worker**: đóng tab vẫn tiếp tục, không giữ kết nối HTTP trong nhiều phút.
- Ảnh động được **chuẩn hoá** về cùng khung hình và fps trước khi nối, nên các cảnh khác độ phân giải/codec vẫn ghép được.
- Âm thanh chỉ được giữ khi **mọi** cảnh đều có tiếng; nếu chỉ một phần có tiếng thì xuất video không tiếng (tránh lệch tiếng so với hình).
- Mỗi người chỉ chạy **một** bản xuất đồng thời để không nghẽn CPU.

**Yêu cầu:** cần **ffmpeg** trên máy chạy backend (`apt install ffmpeg`), hoặc đặt `FFMPEG_PATH`. Thiếu ffmpeg thì bản xuất báo lỗi kèm hướng dẫn cài và không có tệp nào được tạo.

**Giới hạn:** hiện chỉ ghép **clip video** của cảnh; chưa có chế độ dựng video trực tiếp từ ảnh (ảnh tĩnh, pan/zoom, crossfade) và chưa có timeline rẽ nhánh kiểu graph.

## Nhật ký sử dụng và ước tính chi phí

Mục **Sử dụng** trên sidebar ghi lại mọi thứ đã dùng API key của bạn để bạn đối chiếu hoá đơn và cắt phần lãng phí.

**Được ghi:**
- **Ảnh và video**: đọc trực tiếp từ các tác vụ tạo nội dung (prompt, model, provider, dự án/cảnh, trạng thái, thời gian, số lần thử, dung lượng tệp).
- **Mọi lần gọi model chữ**: chat, viết kịch bản, tạo nhân vật, lên timeline, sắp xếp frame, đề xuất bối cảnh, đề xuất biến thể, điền hồ sơ, tạo nhân vật AI — kèm **token vào/ra** provider trả về và thời gian phản hồi.
- **Tin nhắn**: nội dung chat đã dùng (tab *Tin nhắn*), kèm số lần gọi và chi phí của lần gọi mà tin nhắn đó tạo ra.
- Log chỉ giữ **preview 500 ký tự**; toàn văn vẫn nằm ở nơi gốc (tác vụ tạo nội dung và tin nhắn phiên), nên không nhân đôi dung lượng.

**Chi phí:** provider **không** trả giá trong API, nên bạn tự nhập **đơn giá** cho từng model ngay tại nơi khai báo model — *API & Models* → tab **Model catalog**, bấm **Đơn giá** trên hàng model: ảnh/video theo lượt, LLM theo 1K token vào/ra, kèm đơn vị tiền. Hàng model luôn hiện đơn giá đã nhập hoặc **“Chưa đặt đơn giá”**. Trang *Sử dụng* chỉ nhắc và có nút mở thẳng sang đó, tránh nhập giá ở hai nơi. Hệ thống chỉ ước tính từ đơn giá bạn nhập:
- lượt **lỗi/không xác định** vẫn được tính (provider có thể đã tính phí) và hiện riêng để thấy phần lãng phí;
- thiếu đơn giá hoặc provider không trả token thì chi phí ghi là **chưa xác định**, hệ thống không đoán;
- đặt **ngân sách tháng** để thấy tiến độ và cảnh báo khi vượt.

**Gợi ý tiết kiệm:** lượt lỗi/không xác định, lượt có thể đã gọi provider nhiều lần, số lần tạo trùng cùng một cảnh trong 24 giờ, và model tốn nhiều nhất.

**Lưu trữ:** log LLM tự xoá sau **90 ngày** (dọn trong worker, có thể xoá tay ngay). **Ảnh và video không bị xoá** vì đó là nội dung thật của bạn. Xuất video bằng ffmpeg trên máy chủ không phát sinh chi phí provider nên không tính vào đây.

**Quản trị:** super admin có tab **Nhật ký sử dụng** trong vỏ quản trị, xem được log của mọi tài khoản kèm email (API `GET /api/admin/usage`).

**Giới hạn:** token chỉ có với model chữ; model ảnh/video không trả token nên chỉ tính theo lượt. Số tiền là **ước tính** theo đơn giá bạn nhập, không phải hoá đơn của provider.

## Đồng bộ nhân vật khi tạo ảnh

Khi tạo ảnh (đơn lẻ hoặc trong dự án) và chọn một nhân vật có ảnh tham chiếu, ứng dụng gửi ảnh đó kèm yêu cầu để model bám đúng ngoại hình. Phiên **Tạo nội dung đơn lẻ** gửi ảnh của **mọi nhân vật trong phiên** (nhân vật chính trước), tối đa theo giới hạn ảnh đầu vào:

- Kiểu `Chuẩn OpenAI`: gọi `POST /images/edits` dạng multipart, ảnh nhân vật nằm sau ảnh nguồn.
- Kiểu `extra_body`: ảnh nhân vật nằm trong `extra_body.image` dạng Data URI.
- Prompt nêu rõ ảnh tham chiếu là căn cứ ngoại hình; mô tả ngoại hình vẫn được giữ trong prompt.
- Tắt được bằng tùy chọn **Gửi ảnh tham chiếu** khi provider không hỗ trợ chỉnh sửa ảnh.
- Ảnh tham chiếu tính vào giới hạn ảnh đầu vào mỗi lần tạo (mặc định 4).
- Đường dẫn ảnh được **lưu snapshot vào tác vụ**, nên đổi hoặc xóa ảnh của nhân vật sau đó không làm thay đổi tác vụ đang chạy.

**Giới hạn:** việc gửi ảnh tham chiếu phụ thuộc provider. Provider không hỗ trợ sẽ báo lỗi kèm hướng dẫn tắt tùy chọn.

## Model LLM & Chat cho chat và tạo kịch bản

Model văn bản là **một phân loại trong Model catalog**, không có tab quản lý key riêng. Key và
Base URL dùng chung provider với ảnh/video, nên chỉ có **một nơi nhập key** và **một nơi phân loại
model**.

**Thêm provider (nếu chưa có):**

1. Vào *API & Models* → tab **Providers** → **Thêm provider**: nhập **Tên hiển thị**, **Base URL**
   và **API key**.
2. Bấm **Kiểm tra** để gọi `GET {baseUrl}/models` — không tạo nội dung nên không tốn phí.
3. Bấm **Đồng bộ** để nạp danh sách model, hoặc **Thêm model** để nhập tay model ID.

**Phân loại model chat:**

1. Vào tab **Model catalog**.
2. Ở dòng model chat, đổi ô phân loại thành **LLM & Chat** (các lựa chọn khác: *Tạo ảnh*,
   *Tạo video*, *Chưa phân loại*). Model **Chưa phân loại** sẽ không xuất hiện trong Studio hay
   Tạo kịch bản AI.
3. (Tuỳ chọn, để ước tính chi phí) Bấm **Đơn giá** trên hàng model rồi nhập giá: model chat
   theo 1K token vào/ra, model ảnh/video theo lượt, kèm đơn vị tiền. Để trống rồi **Lưu đơn giá** là
   xoá giá. Số này chỉ dùng để ước tính trong *Nhật ký sử dụng*, không gửi cho provider.
4. Xong. **Tạo kịch bản AI** và **AI tạo nhân vật** dùng ngay model vừa phân loại.

- **Tạo kịch bản AI** tự dùng model LLM đang bật đầu tiên và ghi lại model đó vào phiên chat; **AI tạo
  nhân vật** cho chọn model khi tài khoản có nhiều hơn một model LLM.
- Tắt một model (cột `enabled`) thì mọi tính năng văn bản bỏ qua model đó và báo lỗi rõ ràng nếu
  không còn model LLM nào.
- Model **không** được phân loại là *LLM & Chat* sẽ bị từ chối khi dùng cho tính năng văn bản, kèm
  hướng dẫn phân loại lại.

**Bảo mật:** key mã hóa **AES-256-GCM** bằng cùng khóa chủ với provider ảnh/video; giao diện chỉ
hiển thị 4 ký tự cuối và không bao giờ trả key về trình duyệt. Mọi tính năng văn bản đều có giới
hạn tần suất riêng qua `RATE_LIMIT_LLM_CHAT_PER_MIN` (mặc định 10 lần/phút).

**Fallback:** provider không có `GET /models` vẫn dùng được — bấm **Thêm model** và nhập model ID
thủ công rồi phân loại thành *LLM & Chat*.

## Project, nhân vật và giọng nói trong Studio

**Sidebar thu gọn:** trên desktop, bấm nút ở góc phải khối thương hiệu để thu sidebar thành rail chỉ
còn icon (~72px), rê chuột thấy tên mục, bấm lại để mở rộng. Trạng thái được nhớ cho lần tải sau;
trên điện thoại vẫn dùng nút mở menu như trước.

Studio mở **bảng dự án** dạng thẻ, có ô tìm kiếm, bộ lọc dự án lưu trữ và thẻ bìa lấy từ kết quả gần nhất. Bấm vào một dự án để vào không gian làm việc; nút **Danh sách dự án** đưa trở lại.

Thiết kế lấy cảm hứng từ cách các studio AI hiện đại tổ chức công cụ (tham khảo giao diện công khai của [Higgsfield](https://higgsfield.ai/)): **media là trung tâm, thao tác rõ ràng, thông số nâng cao được ẩn gọn**. Không sao chép thương hiệu hay bố cục nguyên bản của họ.

Trong Studio, **bấm vào ảnh để mở trình xem phóng to**: lăn chuột hoặc nút +/− để thu phóng (50%–800%), kéo để di chuyển khi đã phóng to, nháy đúp để phóng 2×, `Esc` để đóng. Có nút tải xuống ngay trong trình xem. Ảnh xem được cả ở Studio lẫn Thư viện.

Mỗi thẻ kết quả có nút **Xóa kết quả** ngay trong Studio, không cần sang Thư viện. Xóa phiên bản đang được một cảnh chọn sẽ tự bỏ chọn ở cảnh đó (khóa ngoại `ON DELETE SET NULL`), và ảnh bìa của dự án được tính lại.

Trong dự án có ba tab:

- **Ảnh** — soạn bên trái (model, nhân vật tùy chọn, mô tả, kích thước, chất lượng), kết quả bên phải.
- **Nhân vật** — thẻ nhân vật kèm ảnh tham chiếu, ngoại hình và hồ sơ giọng nói (vùng giọng, cao độ, âm sắc, tốc độ, phát âm, thói quen nói).
- **Cảnh video** — dải cảnh theo thứ tự, mỗi cảnh có ảnh thu nhỏ, nhân vật nói và trạng thái phiên bản đã chọn. Trình soạn cảnh có ô **Bối cảnh** (do Tạo kịch bản AI sinh ra) và giữ ảnh nền của cảnh làm ảnh nguồn khi tạo ảnh.

Không gian soạn cảnh chia hai cột: **trình soạn bên trái, các phiên bản bên phải**. Ba bước được chỉ rõ: *Nội dung cảnh → Xem trước prompt → Tạo video*. Thông số nâng cao (JSON) nằm trong mục thu gọn, mặc định đóng.

Bấm **Lưu & xem trước prompt** trước khi tạo. Backend biên soạn mẫu `voice-consistency-v2` gồm quy tắc sản xuất, cấu hình dự án, hồ sơ nhân vật/giọng cố định, cảnh và lời thoại nguyên vẹn. Không gọi thêm model chat hay dịch vụ âm thanh. API video nhận chỉ dẫn trong trường `prompt`, **không nhận role system hoặc trường system riêng**.

Mỗi tác vụ lưu prompt gốc, prompt hoàn chỉnh và snapshot. Sửa giọng hoặc cảnh chỉ ảnh hưởng lần tạo tiếp theo. Có thể tạo lại, xem các phiên bản, chọn phiên bản đã hoàn tất làm kết quả chính và tải từng video riêng. Không ghép cảnh thành video dài. Dự án lưu trữ giữ nguyên lịch sử; dữ liệu cũ không thuộc dự án vẫn có trong Thư viện.

**Giới hạn:** mô tả giọng bằng prompt không khóa danh tính giọng và không bảo đảm lip-sync chính xác. Model phải hỗ trợ âm thanh/lời thoại. Mỗi cảnh chỉ có một người nói chính; không tích hợp TTS, voice cloning, lip-sync bên thứ ba. Test mock xác minh prompt/request/lịch sử, không chứng minh giọng thật giống nhau.

API thêm: `/api/shared-characters` (CRUD nhân vật dùng chung, `/reference` để tải lên/xóa/xem ảnh tham chiếu, `/generate` để AI sinh nhân vật mẫu, `/illustrations` để sinh ảnh sheet (đầu/cận mặt riêng + một toàn thân chính diện kèm trang phục) cho nhân vật mẫu, `/:id/prompt` để xuất prompt, `/:id/reference/from-generation` để gắn ảnh đã tạo làm ảnh tham chiếu), `/api/projects`, `/api/projects/:id/characters`, `/api/projects/:id/characters/:characterId/reference` (tải lên/xóa ảnh tham chiếu), `/api/characters/:id/reference` (xem ảnh), `/api/projects/:id/scenes`, `/api/projects/:id/scenes/reorder`, `/api/scenes/:id/preview-prompt`, `/api/scenes/:id/generate`, `/api/scenes/:id/select-generation`. Lịch sử `/api/generations` hỗ trợ lọc `projectId` và `sceneId`.

## Cài đặt

### Docker trên VPS + Cloudflare Tunnel

Nếu triển khai trên VPS, xem [hướng dẫn Docker và Cloudflare Tunnel](docs/deployment-docker.md).
Cấu hình gồm app production, SQLite/media lưu trong volume và connector Cloudflare tùy chọn;
không cần cài Node/pnpm trên host. Hãy đăng ký admin qua localhost/SSH trước khi mở domain công khai.

### Cài đặt trực tiếp để phát triển

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

## Duyệt tài khoản (super admin)

Tài khoản đăng ký mới ở trạng thái **chờ duyệt**: đăng ký không cấp phiên đăng nhập,
giao diện hiện thông báo "Đã tạo tài khoản", và mọi API đều trả 401 cho tới khi được
duyệt. Đăng nhập khi chưa duyệt trả 403 kèm lý do rõ ràng (chờ duyệt hoặc đã bị từ chối).

Tài khoản tạo **trước** khi tính năng này ra đời mặc định đã được duyệt (giá trị mặc
định của migration 020), nên không cần thao tác gì thêm.

### Tạo super admin đầu tiên

Thêm email vào `.env` rồi khởi động lại backend:

```bash
SUPER_ADMIN_EMAILS=ban@gigone.com,it@gigone.com
```

- Khi deploy mới, env chỉ khai báo email, **không tạo tài khoản hay mật khẩu**. Mở
  **Đăng ký**, nhập tên, đúng email admin đã cấu hình và mật khẩu 10–200 ký tự.
  Admin được tự động duyệt, cấp phiên và vào trang quản trị ngay; không cần ai duyệt trước.
- Email admin cấu hình được phép ngoài `@gigone.com`; user thường vẫn chỉ đăng ký
  bằng `@gigone.com` và phải chờ duyệt. Email được chuẩn hóa chữ thường và bỏ khoảng trắng hai đầu.
- Các lần sau dùng **Đăng nhập**. Đăng ký lại email đã tồn tại trả 409, không ghi đè
  mật khẩu và không phải cơ chế khôi phục tài khoản.
- **Bảo mật triển khai:** chưa có bước xác minh quyền sở hữu email. Hãy hoàn tất đăng ký
  admin trên môi trường hạn chế truy cập trước khi mở hệ thống công khai.
- Email trong danh sách được **tự động duyệt** và có vai trò quản trị, kể cả tài khoản
  đã tồn tại từ trước (đồng bộ lúc khởi động, chỉ nâng quyền — bỏ email khỏi danh sách
  không giáng quyền tài khoản đã là admin).
- Danh sách rỗng thì **không ai duyệt được** tài khoản mới; backend ghi log cảnh báo
  lúc khởi động.
- Tài khoản quản trị đăng nhập thẳng vào **trang duyệt tài khoản**: có danh sách,
  bộ lọc theo trạng thái, tìm theo email và ba thao tác **Duyệt / Từ chối / Thu hồi**.
  Sidebar admin gồm **Duyệt tài khoản**, **Nhật ký sử dụng**, **Cài đặt**, không có Studio.

### Cài đặt và đổi mật khẩu

Cả admin và user có mục **Cài đặt** trên sidebar (`?page=account-settings`).
Trang này tách biệt mục **API & Models** hiện có (`?page=settings`). Nhập mật khẩu
hiện tại, mật khẩu mới 10–200 ký tự và xác nhận mật khẩu mới rồi chọn **Cập nhật mật khẩu**.
Sau khi thành công, thiết bị hiện tại tiếp tục đăng nhập bằng phiên mới; mọi phiên cũ
bị thu hồi. Mật khẩu không bị trim và không lưu trong env. API dùng chung cho hai vai trò:
`POST /api/auth/change-password` với `{ currentPassword, newPassword }`.

Thu hồi duyệt hoặc từ chối sẽ hủy mọi phiên đang sống của tài khoản đó ngay lập tức.

API quản trị (đều yêu cầu vai trò admin): `GET /api/admin/users` (lọc `status`, `q`,
`limit`, `offset`), `POST /api/admin/users/:id/approve`, `.../reject`, `.../revoke`.
Không thể tự đổi trạng thái tài khoản của chính mình hoặc của một tài khoản admin khác.

## Kiểm thử

```bash
pnpm run typecheck    # TypeScript cho cả frontend và backend
pnpm run test:backend # 878 test: unit, xác thực, bảo mật, dự án, nhân vật, AI tạo nhân vật, prompt, LLM, Tạo kịch bản AI, nhiều nhân vật mỗi cảnh, phiên tạo nội dung, Canvas dự án, xuất video
pnpm run test:e2e     # 165 test giao diện trên trình duyệt thật (gồm phiên tạo nội dung, Canvas dự án, Tạo kịch bản AI, sidebar thu gọn)
pnpm run test         # chạy cả hai
pnpm run verify       # typecheck + backend + build + e2e
pnpm run test:shots   # chụp ảnh giao diện vào shots/
```

Phạm vi test mới gồm catalog/handle cách ly tài khoản, mention theo ID và label đóng băng,
preview ảnh/giới hạn, Canvas và kịch bản/Timeline, URL tạm/thu hồi, overlay logo/thử lại cục bộ,
quota phiên bản media, nâng cấp database cũ và khôi phục khi trùng handle. Bản cập nhật thư viện
đối tượng đã kiểm tra 878 test backend + 165 test E2E, cùng typecheck, bản dịch và build.
Số test thay đổi theo tính năng; kết quả runner là nguồn chính xác cho checkout đang dùng.
E2E mặc định dùng cổng 8790/5180; nếu cổng bận, đặt `PW_TEST_PORT` và `PW_WEB_URL` (đợt xác minh này dùng 8798/5188).

Test E2E tự khởi động backend mock ở cổng 8790 và Vite ở cổng 5180, với database/media tạm và khóa riêng cho từng lần chạy. Test từ chối dùng lại server đang chạy, không đụng dữ liệu thật và **không gọi provider nào**.

Vì tài khoản mới phải chờ duyệt, helper test (`registerUser` ở backend, `signUpFresh` ở
E2E) đăng ký rồi duyệt qua API thật trước khi đăng nhập; server test E2E đặt
`SUPER_ADMIN_EMAILS=e2e-admin@gigone.com` cho việc đó. Các bài kiểm tra riêng cho luồng
duyệt nằm ở `tests/backend/adminApproval.test.ts` và `tests/adminApproval.spec.ts`.

## Kiến trúc

```
server/
  index.ts                  khởi động, validate env, tắt an toàn
  env.ts                    schema biến môi trường (zod), fail-fast
  app.ts                    lắp ráp Express, phục vụ frontend ở production
  db/                       node:sqlite + migrations
  crypto/                   AES-256-GCM cho API key, scrypt cho mật khẩu
  auth/                     session, cookie, middleware, duyệt tài khoản (accounts.ts), routes
  admin/                    API quản trị: liệt kê/duyệt/từ chối/thu hồi tài khoản
  providers/                CRUD, chống SSRF, client gọi provider
  models/                   CRUD và phân loại model
  characters/               CRUD nhân vật, ảnh tham chiếu, AI sinh nhân vật và xuất prompt
  llm/                      chọn model LLM & Chat và gọi chat completion cho tính năng văn bản
  planner/                  Tạo kịch bản AI: prompt, chuẩn hoá, phiên chat, áp dụng thành dự án
  exports/                  xuất video: dò ffmpeg, ghép cảnh, hàng đợi trong worker
  generations/              routes, worker, adapter ảnh/video/mock
  quickSessions/            phiên "Tạo nội dung đơn lẻ": CRUD phiên và danh sách nhân vật
  canvas/                   Canvas dự án: vật phẩm, đồ thị node, mention theo ID, preview/run
  entityLibrary/            catalog/handle, mention, URL tạm, overlay logo và phiên bản media
  trash/                    Thùng rác chung: soft delete, khôi phục và dọn có kiểm tra tham chiếu
  media/                    lưu trữ và phục vụ media có xác thực
src/
  api/                      client gọi backend, kiểu dữ liệu, API dự án
  components/canvas/        Canvas dự án: bảng node, ô @mention, trình bố trí khung hình
  components/               AuthPage, Sidebar, CharacterForm, CharacterAiModal, CharacterIllustrate,
                            CharacterPromptModal, CharacterIllustrateModal, Lightbox, thẻ kết quả
  pages/                    ProjectStudio, StudioPage, CharactersPage, LibraryPage, SettingsPage
  App.tsx                   vỏ ứng dụng, điều hướng, quản lý trạng thái
tests/
  backend/                  Vitest: unit, xác thực, bảo mật, dự án, nhân vật, LLM, tạo nội dung
  helpers/auth.ts           fixture đăng ký tài khoản cho Playwright
  helpers/mockServer.ts     backend mock cổng riêng cho E2E
  characters.spec.ts        thư viện nhân vật, AI tạo nhân vật, minh hoạ, prompt và phân loại LLM & Chat
  planner.spec.ts           Tạo kịch bản AI: chat, kịch bản nháp, nhân vật, trang Timeline ngang và batch sinh ảnh
  projectStudio.spec.ts     luồng dự án, nhân vật, cảnh, phiên bản
  quickSessions.spec.ts     phiên tạo nội dung: nhiều nội dung, sửa từ nội dung cũ, ảnh nguồn, nhân vật
  canvas.spec.ts            Canvas dự án: node, tự lưu, sản phẩm mới, bố trí khung và chạy node
  characterDeletion.spec.ts xoá nhân vật còn tham chiếu: hộp thoại xác nhận và dự án trong Thùng rác
  trash.spec.ts             Thùng rác chung: thumbnail, khôi phục, xoá vĩnh viễn, dọn sạch
  entityLibrary.spec.ts     thư viện đồ vật/logo và picker mention theo ID
  studioLayout.spec.ts      bố cục Studio: lưới dự án, hai cột, mobile
  *.spec.ts                 Playwright: giao diện, layout, cỡ chữ, luồng
```

## API

| Nhóm | Endpoint |
| --- | --- |
| Xác thực | `POST /api/auth/register`, `/login`, `/logout`, `/change-password`, `GET /api/auth/me` |
| Provider | `GET\|POST /api/providers`, `PATCH\|DELETE /api/providers/:id` |
| | `POST /api/providers/:id/test`, `POST /api/providers/:id/sync-models` |
| Model | `GET\|POST /api/models`, `PATCH\|DELETE /api/models/:id` (phân loại `image`, `video`, `llm`, `unclassified`) |
| Nhân vật dùng chung | `GET\|POST /api/shared-characters`, `GET\|PATCH\|DELETE /api/shared-characters/:id` |
| | `POST\|DELETE /api/shared-characters/:id/reference`, `GET /api/characters/:id/reference` |
| | `POST /api/shared-characters/generate` (AI sinh nhân vật mẫu, không lưu) |
| | `POST /api/shared-characters/analyze-reference?modelId=...&language=...` (ảnh nhị phân), `POST /api/shared-characters/:id/analyze-reference` (ảnh đã lưu): chỉ gợi ý tên/ngoại hình, không sửa giọng nói hoặc tự lưu |
| | `POST /api/shared-characters/illustrations` (sinh ảnh sheet: đầu/cận mặt riêng + một toàn thân chính diện kèm trang phục, prompt do server dựng) |
| | `GET /api/shared-characters/:id/prompt` (xuất prompt để dùng nơi khác) |
| | `POST /api/shared-characters/:id/reference/from-generation` (gắn ảnh đã tạo làm ảnh tham chiếu) |
| Cài đặt thư viện | `GET\|PATCH /api/entity-library/preferences`: nhớ loại, số ứng viên, model văn bản/thị giác, model ảnh, tạo ảnh/tự lưu, kích thước và chất lượng theo tài khoản; không lưu mô tả/ảnh. PATCH `{version:1, expectedUserId?, settings:{...}}`; giao diện tự gửi ID tài khoản đọc từ GET để chặn ghi trễ sau đổi phiên. |
| Thư viện đối tượng | `GET /api/entity-library/`, `GET\|POST /api/entity-library/assets`, `PATCH\|DELETE /api/entity-library/assets/:id` |
| | `GET /api/entity-library/:kind/:id/conversion-data` → `{revision,voice,continuityNotes,referenceViews}`; `POST .../:kind/:id/convert` → `{entity}`. Chuyển loại tài nguyên độc lập chưa dùng, giữ ID/handle/ảnh, bảo toàn dữ liệu riêng; chặn revision cũ và tham chiếu sống/có thể khôi phục, không sửa snapshot lịch sử. |
| | `GET\|POST\|DELETE /api/entity-library/assets/:id/reference`, `POST .../reference/from-generation`, `PATCH /api/entity-library/:kind/:id/handle` |
| Tác vụ | `POST\|GET /api/generations`, `GET\|DELETE /api/generations/:id` |
| | `POST /api/generations/preview` (không gọi provider); create nhận `promptDocument`, `allowTemporaryMedia`, `logoOverlays` trong dữ liệu yêu cầu |
| | `POST /api/generations/:id/retry-overlay` (ghép cục bộ), `POST /api/generations/:id/revoke-media` (thu hồi URL tạm) |
| | `POST /api/generations` nhận thêm `quickSessionId`, `characterIds` (tối đa 6), `sourceAssetIds` (ảnh đã tạo làm ảnh nguồn) |
| | `GET /api/generations?quickSessionId=<id>` (lọc theo phiên) |
| | `POST /api/generations/:id/retry-download` |
| Thùng rác chung | `GET /api/trash`, `POST /api/trash/:kind/:id/restore`, `DELETE /api/trash/:kind/:id`, `DELETE /api/trash` |
| Phiên tạo nội dung | `GET\|POST /api/quick-sessions`, `GET\|PATCH\|DELETE /api/quick-sessions/:id` |
| Canvas dự án | `GET\|POST /api/projects/:id/items`, `PATCH\|DELETE /api/projects/:id/items/:itemId` |
| | `POST\|DELETE /api/projects/:id/items/:itemId/reference`, `POST .../reference/from-generation`, `POST .../reference/generate` |
| | `GET\|PUT /api/projects/:id/canvas`, `GET /api/projects/:id/canvas/runs`, `POST .../canvas/nodes/:nodeId/preview\|run` |
| Tạo kịch bản AI | `GET\|POST /api/plans`, `GET\|PATCH\|DELETE /api/plans/:id` |
| | `PATCH /api/plans/:id/setup` (chọn model chat/ảnh/video) |
| | `POST /api/plans/:id/messages` (chat theo tab `script`\|`cast`\|`timeline`) |
| | `POST\|PUT /api/plans/:id/script`, `POST\|PUT /api/plans/:id/cast`, `POST\|PUT /api/plans/:id/timeline` |
| | `POST\|DELETE /api/plans/:id/cast/:castId/portrait` (+`/attach`, `/upload`) |
| | `POST\|DELETE /api/plans/:id/timeline/:frameId/background` (+`/attach`, `/upload`) |
| | `POST /api/plans/:id/timeline/:frameId/arrange` (AI sắp xếp lại một frame: ai, hành động, vị trí) |
| | `POST\|GET /api/plans/:id/image-batch` (+`/:batchId`, `/:batchId/stop`, `/:batchId/retry`) — batch sinh ảnh storyboard |
| | `POST /api/plans/:id/apply` (chốt thành dự án, cảnh chưa duyệt) |
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

## Agnes Video 2.5 / 2.5 Flash

Model catalog tự phân loại ID `agnes-video-2.5` và `agnes-video-2.5-flash` thành **Kiểu API video: Agnes**. Alias của gateway có thể chọn thủ công ở Model catalog. Model khác vẫn dùng OpenAI; kiểu API được snapshot vào tác vụ, đổi catalog không đổi hợp đồng của job đang chạy.

- **Tạo:** POST `${BASE_URL}/videos` (Base URL thường là `https://apihub.agnes-ai.com/v1`), đọc **video_id**, không dùng `id` / `task_id` thay thế.
- **Poll:** GET `https://apihub.agnes-ai.com/agnesapi?video_id=...&model_name=...` ở root, luôn gửi đủ hai query. Chỉ đọc `status` và `progress`, không đọc các field `internal_*`.
- **Tải:** khi completed, tải MP4 từ `url`; không gọi `/videos/{id}/content`. URL chỉ lưu nội bộ để restart/tải lại, không log hoặc trả URL có token cho client. Giữ đúng API key đã ghim; không gửi key sang CDN khác origin.
- **Flash:** size `720P`, seconds chuỗi `4`–`12` (mặc định `5`), n=1. Khung hình chọn qua aspect ratio `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`. Không hardcode pixel của file trả về.
- **text:** chỉ mô tả, không media. **keyframe:** ít nhất URL khung đầu hoặc cuối, không arrays reference. **reference:** ít nhất một URL ảnh/audio, không khung đầu/cuối. Flash tối đa 5 ảnh, 3 audio, không video tham chiếu.
- UI đơn lẻ và cảnh Studio có controls tương ứng. API nội bộ dùng tên camelCase: `mode`, `aspectRatio`, `seed`, `firstFrame`, `lastFrame`, `referenceImages`, `referenceAudios`; backend chuyển sang tên Agnes (`aspect_ratio`, `first_frame`, `last_frame`, `images`, `audios`).
- URL media phải công khai, không cần đăng nhập và không phải localhost/mạng nội bộ. Ảnh thư viện
  **không tự được công khai hoặc gửi dạng data URL cho Agnes**: bạn có thể nhập URL công khai
  ở mode reference, hoặc bật `allowTemporaryMedia` cho ảnh đã chọn bằng mention khi `APP_ORIGIN`
  là HTTPS công khai. URL tạm theo generation hết hạn mặc định sau 2 giờ (trần 24 giờ), nên không
  bảo đảm còn hiệu lực nếu provider xử lý quá lâu; xem [chia sẻ tạm](<docs/entity-library.md#chia-sẻ-media-tạm-cho-agnes>).
  Khi tắt tuỳ chọn, ảnh thư viện không được gửi: chỉ mô tả và cảnh báo, không phải tham chiếu giả.
- Nếu POST trả HTTP 5xx (ví dụ 503), tác vụ giữ trạng thái **Chưa xác định** để tránh gửi trùng. Thẻ lỗi hiển thị mã HTTP, thông báo provider và request ID khi có; phản hồi 2xx thiếu video_id có thông báo riêng. Chưa có video_id thì không thể poll/tải: kiểm tra lịch sử trên Agnes trước khi tạo lại. Không suy diễn mã HTTP của tác vụ cũ từ lỗi chung của credential.
- Tác vụ cũ bị lỗi không tự tạo lại. Sau restart backend áp dụng migration và tải lại giao diện, chọn model Agnes rồi chủ động tạo tác vụ mới. Không tự đặt đơn giá $0 vì giá khuyến mãi có thể thay đổi.

Ví dụ body gửi sang provider:
```json
{"model":"agnes-video-2.5-flash","prompt":"A cat runs through a flower field","mode":"text","size":"720P","seconds":"5","aspect_ratio":"16:9","n":1}
```

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
- **Media:** mặc định lưu ngoài thư mục public, kiểm tra quyền sở hữu và magic bytes (không tin
  header provider); không phục vụ HTML/SVG. Ngoại lệ có chủ đích là URL token chỉ đọc cho đúng
  snapshot generation đã opt-in, có hết hạn/thu hồi; không cấp URL tạm cho localhost/LAN.
  DTO công khai không trả đường dẫn kho media nội bộ hoặc token URL tạm đã cấp cho provider.
- **Nhân vật dùng chung:** thuộc `user_id`; mọi truy vấn đều scope theo chủ sở hữu nên tài khoản
  khác nhận 404. Ảnh tham chiếu lưu trong thư mục riêng `media/<userId>/characters/<characterId>/`.
- **Model LLM & Chat:** key dùng chung cơ chế AES-256-GCM với provider ảnh/video (một key cho mỗi
  provider, chỉ trả về `keyHint` 4 ký tự cuối). Việc dò model đi qua `POST /api/providers/:id/test`
  và `/sync-models`, đều kiểm tra SSRF như mọi request provider khác.
- **Giới hạn:** 2 tác vụ đồng thời/người, prompt 8.000 ký tự, 20 MB/ảnh, 200 MB/video,
  1 GB media/người — chỉnh được qua `.env`.

## Cấu hình

Xem [.env.example](.env.example). Các biến quan trọng:

| Biến | Ý nghĩa |
| --- | --- |
| `APP_ENCRYPTION_KEY` | **Bắt buộc.** Khóa mã hóa API key, base64 của 32 byte |
| `PORT` | Cổng backend, mặc định 8787 |
| `DATABASE_PATH`, `MEDIA_DIR` | Nơi lưu database và media |
| `APP_ORIGIN` | Origin được phép cho CSRF; URL media tạm chỉ dùng được khi origin là HTTPS công khai (không localhost/LAN) |
| `PROVIDER_MODE` | `live` gọi provider thật, `mock` chỉ dùng cho test |
| `ALLOW_PRIVATE_PROVIDER_URLS` | `true` cho phép Base URL nội bộ/LAN (chỉ khi phát triển) |
| `COOKIE_SECURE` | Bật khi chạy sau HTTPS |
| `MAX_REFERENCE_BYTES` | Giới hạn ảnh tham chiếu nhân vật, mặc định 5 MB |
| `MAX_IMAGE_BYTES`, `MAX_VIDEO_BYTES`, `MAX_USER_MEDIA_BYTES` | Giới hạn dung lượng media |
| `MAX_CONCURRENT_JOBS_PER_USER`, `MAX_PROMPT_LENGTH` | Giới hạn tác vụ và độ dài prompt |
| `RATE_LIMIT_LLM_CHAT_PER_MIN` | Số lần gọi LLM sinh văn bản mỗi phút (tạo nhân vật, kịch bản), mặc định 10 |
| `IMAGE_REQUEST_TIMEOUT_MS` | Thời gian chờ tối đa cho một lần gọi provider tạo ảnh, mặc định 3 phút (180000 ms). Provider thường mất 60–90 giây mới trả ảnh; đặt 120000 để chờ tối đa 2 phút |
| `FFMPEG_PATH` | Đường dẫn tới ffmpeg; để trống thì tìm trong `PATH`. Cần cho chức năng xuất video |
| `EXPORT_TIMEOUT_MS` | Thời gian tối đa cho một lần ghép video, mặc định 10 phút |
| `EXPORT_MAX_SCENES` | Số cảnh tối đa cho một lần xuất video, mặc định 30 |

## Ảnh tham chiếu nhân vật

Khi thêm hoặc sửa nhân vật (ở **Nhân vật** hoặc trong **Studio**), bạn có thể chọn **ảnh tham chiếu** (PNG, JPEG, WebP, GIF; mặc định tối đa 5 MB).

- Ảnh mặc định lưu riêng tư và xem qua `/api/characters/:id/reference` sau khi kiểm tra quyền
  sở hữu. URL đọc tạm chỉ cấp cho snapshot một tác vụ khi opt-in, không đổi ảnh thành public vĩnh viễn.
- Định dạng được nhận dạng bằng **magic bytes**, không tin `Content-Type` do trình duyệt khai báo, nên không thể tải lên nội dung khác đội lốt ảnh.
- Thay ảnh tạo phiên bản đường dẫn mới, không ghi đè media đã được snapshot. Phiên bản giữ lại
  và ảnh trong Thùng rác vẫn tính quota; dọn tệp kiểm tra các tham chiếu còn sống, không cam kết
  mọi phiên bản cũ được xoá ngay khi thay ảnh.
- Khi tạo **video OpenAI-compatible**, ảnh nhân vật chính có thể gửi trong `input_reference`
  dạng data URL. Agnes không nhận ảnh riêng tư theo cách này; cần URL hợp lệ hoặc opt-in URL tạm.
- Khi tạo **ảnh**, ảnh tham chiếu là một trong các ảnh đầu vào (xem mục *Đồng bộ nhân vật khi tạo ảnh*).
- Trong trình soạn cảnh có ô **Gửi ảnh tham chiếu của … kèm video** để tắt khi provider không hỗ trợ.

**Giới hạn:** việc gửi `input_reference` phụ thuộc provider. Provider không hỗ trợ sẽ báo lỗi — hãy tắt tùy chọn đó hoặc xóa ảnh.

### Kiểu gửi ảnh tham chiếu video

Mỗi provider có trường **Ảnh tham chiếu video**, đổi được ở danh sách provider (API & Models):

| Kiểu | Cách gửi | Dùng cho |
| --- | --- | --- |
| `Object { image_url }` (mặc định) | `input_reference: { "image_url": "..." }` | OpenAI, Sora, đa số provider chuẩn |
| `Chuỗi thuần` | `input_reference: "..."` | Gateway **new-api**: NexusMMO và các gateway tương tự |

Gateway new-api khai báo `input_reference` là **chuỗi**, nên gửi object sẽ khiến provider từ chối yêu cầu
với thông báo `Video request failed` — đúng triệu chứng là model chạy được khi **không** kèm ảnh nhưng lỗi
ngay khi có ảnh tham chiếu. Nếu gặp lỗi đó, hãy đổi provider sang **Chuỗi thuần**.

Kiểu này được **lưu snapshot vào từng tác vụ**, nên đổi cấu hình sau không làm thay đổi cách xử lý của tác vụ đang chạy.

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

`response_format` **bắt buộc nằm trong `extra_body`** — đặt ở top-level có thể gây lỗi 400. Thời gian chờ mỗi lần gọi provider tạo ảnh mặc định **3 phút**, chỉnh bằng `IMAGE_REQUEST_TIMEOUT_MS`. Hạn chót này áp dụng cho cả lúc provider còn đang xử lý (chưa trả header), nên ảnh mất 60–90 giây vẫn nhận được bình thường.

**Trường `quality`:** mặc định **không được gửi**. Đây là trường đặc thù GPT Image; nhiều gateway tương thích OpenAI từ chối và trả lỗi dạng `quality is not supported`. Chỉ khi bạn chủ động chọn mức chất lượng trong mục **Chất lượng** thì trường này mới được gửi. Ở kiểu `extra_body`, `quality` không bao giờ được gửi.

Kiểu API được **lưu snapshot vào từng tác vụ**, nên đổi cấu hình provider sau đó không làm thay đổi cách xử lý của tác vụ đang chạy.

## Sao lưu

Cần sao lưu **cả ba** thứ sau, và giữ chúng đi cùng nhau:

1. `data/app.db` — tài khoản, provider, model, nhân vật, phiên tạo nội dung, Canvas dự án, phiên Tạo kịch bản AI, lịch sử
2. `data/media/` — ảnh/video gốc và bản overlay, ảnh tham chiếu nhân vật/đồ vật/logo, ảnh nguồn và các phiên bản bất biến giữ cho snapshot
3. `APP_ENCRYPTION_KEY` — **mất khóa này thì mọi API key đã lưu (provider ảnh/video và LLM) không giải mã được**

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
- AI tham chiếu logo chỉ best-effort; muốn dùng đúng ảnh logo cần overlay. Video OpenAI-compatible
  hiện không gửi ảnh đồ vật; Agnes cần URL hợp lệ/opt-in với hạ tầng HTTPS công khai.
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

**Tính năng AI báo "Chưa có model LLM & Chat"** — vào *API & Models* → **Model catalog**, đổi phân
loại một model thành **LLM & Chat**. Nếu provider chưa có model nào, bấm **Đồng bộ** trước (hoặc
**Thêm model** để nhập tay).

**Kiểm tra provider báo 401/403** — key sai hoặc hết hạn. Sửa provider và nhập key mới; key cũ
không đọc lại được.

**Provider không hỗ trợ `/models`** — một số gateway không có endpoint liệt kê model. Bấm **Thêm
model** rồi gõ đúng model ID provider yêu cầu và phân loại như bình thường.

**Tác vụ ở trạng thái "Chưa xác định"** — request có thể đã tới provider nhưng không nhận được
phản hồi. Kiểm tra ở provider trước khi tạo mới, để tránh bị tính phí hai lần.
