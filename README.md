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
- Xóa nhân vật đang được cảnh sử dụng sẽ bị chặn — gỡ nhân vật khỏi cảnh trước.

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
thành **ảnh tham chiếu** của nhân vật khi chốt dự án. Chọn **Nơi lưu** cho từng nhân vật: *Thư viện
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
được sao chép thành ảnh nguồn của cảnh, và ảnh chân dung trở thành ảnh tham chiếu nhân vật.

Điểm quan trọng về an toàn chi phí: cảnh mới luôn ở trạng thái chưa duyệt. Chỉ khi bạn duyệt một cảnh
trong Studio thì cảnh đó mới được xếp hàng tạo nội dung. Bật **tự động xếp hàng khi duyệt** để hệ
thống tự tạo lần lượt; vì giới hạn `MAX_CONCURRENT_JOBS_PER_USER`, các cảnh được tạo theo hàng đợi và
tiếp tục chạy kể cả khi bạn đóng tab.

Cổng được ép ở **server**: không thể sinh kịch bản khi chưa chọn model chat, không thể sinh ảnh khi
chưa chọn model ảnh, và không thể chốt khi timeline chưa có frame.

**Gợi ý nhân vật "để không bị lỗi":** AI bắt buộc nêu cảnh báo cho các rủi ro làm video lệch — quá
nhiều nhân vật cho một video ngắn, nhân vật thiếu mô tả ngoại hình, cảnh có lời thoại mà thiếu người
nói, cảnh cần nhiều hơn một người nói (phải tách cảnh), hoặc bỏ phí nhân vật đã có trong thư viện.
Nhân vật trùng tên với **thư viện** được dùng lại thay vì tạo bản sao (nhân vật của dự án khác thì
không, để cảnh không trỏ sang dự án khác).

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
- Khi tạo **video**, API video chỉ nhận **một** ảnh tham chiếu, nên chỉ ảnh của người nói chính được gửi; các nhân vật khác được mô tả bằng văn bản trong prompt.
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

Khi tạo ảnh (đơn lẻ hoặc trong dự án) và chọn một nhân vật có ảnh tham chiếu, ứng dụng gửi ảnh đó kèm yêu cầu để model bám đúng ngoại hình:

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

API thêm: `/api/shared-characters` (CRUD nhân vật dùng chung, `/reference` để tải lên/xóa/xem ảnh tham chiếu, `/generate` để AI sinh nhân vật mẫu, `/illustrations` để sinh ảnh sheet (cận mặt + 4 góc nhìn) cho nhân vật mẫu, `/:id/prompt` để xuất prompt, `/:id/reference/from-generation` để gắn ảnh đã tạo làm ảnh tham chiếu), `/api/projects`, `/api/projects/:id/characters`, `/api/projects/:id/characters/:characterId/reference` (tải lên/xóa ảnh tham chiếu), `/api/characters/:id/reference` (xem ảnh), `/api/projects/:id/scenes`, `/api/projects/:id/scenes/reorder`, `/api/scenes/:id/preview-prompt`, `/api/scenes/:id/generate`, `/api/scenes/:id/select-generation`. Lịch sử `/api/generations` hỗ trợ lọc `projectId` và `sceneId`.

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

- Email trong danh sách được **tự động duyệt** và có vai trò quản trị, kể cả tài khoản
  đã tồn tại từ trước (đồng bộ lúc khởi động, chỉ nâng quyền — bỏ email khỏi danh sách
  không giáng quyền tài khoản đã là admin).
- Danh sách rỗng thì **không ai duyệt được** tài khoản mới; backend ghi log cảnh báo
  lúc khởi động.
- Tài khoản quản trị đăng nhập thẳng vào **trang duyệt tài khoản**: chỉ có danh sách,
  bộ lọc theo trạng thái, tìm theo email và ba thao tác **Duyệt / Từ chối / Thu hồi**.
  Trang này không có tính năng tạo ảnh, video hay bất kỳ mục Studio nào.

Thu hồi duyệt hoặc từ chối sẽ hủy mọi phiên đang sống của tài khoản đó ngay lập tức.

API quản trị (đều yêu cầu vai trò admin): `GET /api/admin/users` (lọc `status`, `q`,
`limit`, `offset`), `POST /api/admin/users/:id/approve`, `.../reject`, `.../revoke`.
Không thể tự đổi trạng thái tài khoản của chính mình hoặc của một tài khoản admin khác.

## Kiểm thử

```bash
pnpm run typecheck    # TypeScript cho cả frontend và backend
pnpm run test:backend # 250 test: unit, xác thực, bảo mật, dự án, nhân vật, AI tạo nhân vật, prompt, LLM, Tạo kịch bản AI, nhiều nhân vật mỗi cảnh, xuất video
pnpm run test:e2e     # 75 test giao diện trên trình duyệt thật (gồm luồng Tạo kịch bản AI, sidebar thu gọn)
pnpm run test         # chạy cả hai
pnpm run verify       # typecheck + backend + build + e2e
pnpm run test:shots   # chụp ảnh giao diện vào shots/
```

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
  characters.spec.ts        thư viện nhân vật, AI tạo nhân vật, minh hoạ, prompt và phân loại LLM & Chat
  planner.spec.ts           Tạo kịch bản AI: chat, kịch bản nháp, nhân vật, trang Timeline ngang và batch sinh ảnh
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
| Model | `GET\|POST /api/models`, `PATCH\|DELETE /api/models/:id` (phân loại `image`, `video`, `llm`, `unclassified`) |
| Nhân vật dùng chung | `GET\|POST /api/shared-characters`, `GET\|PATCH\|DELETE /api/shared-characters/:id` |
| | `POST\|DELETE /api/shared-characters/:id/reference`, `GET /api/characters/:id/reference` |
| | `POST /api/shared-characters/generate` (AI sinh nhân vật mẫu, không lưu) |
| | `POST /api/shared-characters/illustrations` (sinh ảnh sheet: cận mặt + 4 góc nhìn, prompt do server dựng) |
| | `GET /api/shared-characters/:id/prompt` (xuất prompt để dùng nơi khác) |
| | `POST /api/shared-characters/:id/reference/from-generation` (gắn ảnh đã tạo làm ảnh tham chiếu) |
| Tác vụ | `POST\|GET /api/generations`, `GET\|DELETE /api/generations/:id` |
| | `POST /api/generations/:id/retry-download` |
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
| `APP_ORIGIN` | Origin được phép, dùng cho kiểm tra CSRF |
| `PROVIDER_MODE` | `live` gọi provider thật, `mock` chỉ dùng cho test |
| `ALLOW_PRIVATE_PROVIDER_URLS` | `true` cho phép Base URL nội bộ/LAN (chỉ khi phát triển) |
| `COOKIE_SECURE` | Bật khi chạy sau HTTPS |
| `MAX_REFERENCE_BYTES` | Giới hạn ảnh tham chiếu nhân vật, mặc định 5 MB |
| `MAX_IMAGE_BYTES`, `MAX_VIDEO_BYTES`, `MAX_USER_MEDIA_BYTES` | Giới hạn dung lượng media |
| `MAX_CONCURRENT_JOBS_PER_USER`, `MAX_PROMPT_LENGTH` | Giới hạn tác vụ và độ dài prompt |
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

1. `data/app.db` — tài khoản, provider, model, nhân vật, phiên Tạo kịch bản AI, lịch sử
2. `data/media/` — ảnh và video đã tạo, ảnh tham chiếu nhân vật, ảnh nguồn
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
