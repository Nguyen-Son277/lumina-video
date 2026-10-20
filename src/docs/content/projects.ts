import { bilingual as b, type DocsArticle } from '../types'

export const projectArticles: DocsArticle[] = [
  {
    id: 'studio-projects',
    group: 'create',
    title: b('Build and manage creative projects', 'Tạo và quản lý dự án sáng tạo'),
    description: b('Keep a shared style, images, characters, locations and video scenes together, then manage the project safely through archive and trash.', 'Tập hợp phong cách chung, ảnh, nhân vật, bối cảnh và cảnh video trong một dự án, rồi quản lý an toàn bằng lưu trữ và thùng rác.'),
    keywords: b('project studio create edit archive restore trash search filter images characters locations style language', 'dự án studio tạo sửa lưu trữ khôi phục thùng rác tìm kiếm lọc ảnh nhân vật bối cảnh phong cách ngôn ngữ'),
    destination: 'studio',
    related: ['scenes-export'],
    sections: [
      {
        id: 'create-project',
        title: b('Create a project with reusable creative direction', 'Tạo dự án với định hướng sáng tạo dùng chung'),
        blocks: [
          { type: 'steps', items: [
            b('Open Project studio and choose Create project. Enter a meaningful project name; a blank name cannot be saved.', 'Mở Project studio và chọn Tạo dự án. Nhập tên dự án có ý nghĩa; không thể lưu khi tên để trống.'),
            b('Add a description to explain the story or purpose, then write the shared style. Use visual details such as medium, palette, lighting and camera mood rather than repeating every scene action.', 'Thêm mô tả để giải thích câu chuyện hoặc mục đích, rồi viết phong cách chung. Nên nêu chất liệu, bảng màu, ánh sáng và cảm xúc máy quay thay vì lặp lại hành động của từng cảnh.'),
            b('Choose Vietnamese, English or Other language. For Other language, enter the language code in the additional required field. Save project, then open its workspace.', 'Chọn Tiếng Việt, Tiếng Anh hoặc Ngôn ngữ khác. Với Ngôn ngữ khác, nhập mã ngôn ngữ vào ô bắt buộc xuất hiện thêm. Bấm Lưu dự án rồi mở không gian làm việc.'),
          ] },
          { type: 'table', headers: [b('Field', 'Trường'), b('How it is used', 'Cách sử dụng')], rows: [
            [b('Name', 'Tên'), b('Required identifier shown in the project list; use a name that distinguishes this production from similar drafts.', 'Thông tin bắt buộc hiển thị trong danh sách; đặt tên phân biệt sản phẩm này với các bản nháp tương tự.')],
            [b('Description', 'Mô tả'), b('Optional project context, also included in project search.', 'Bối cảnh dự án không bắt buộc, đồng thời được dùng khi tìm kiếm dự án.')],
            [b('Shared style and language', 'Phong cách chung và ngôn ngữ'), b('Combined into the prompt for project images and scenes. Review these before generating a batch because they affect more than one scene.', 'Được ghép vào prompt của ảnh và cảnh trong dự án. Kiểm tra trước khi tạo hàng loạt vì chúng ảnh hưởng nhiều cảnh, không chỉ một cảnh.')],
          ] },
          { type: 'example', title: b('A consistent short film', 'Một phim ngắn nhất quán'), text: b('Name: Pine Forest Morning. Description: A traveller returns to Da Lat. Shared style: watercolor cinema, warm dawn light, muted greens, gentle camera movement. Language: English. Put the traveller’s specific action in each image or scene prompt, not in the shared style.', 'Tên: Buổi sáng rừng thông. Mô tả: Một người lữ hành trở lại Đà Lạt. Phong cách chung: điện ảnh màu nước, ánh bình minh ấm, sắc xanh dịu, chuyển động máy quay nhẹ. Ngôn ngữ: Tiếng Việt. Đặt hành động cụ thể của người lữ hành trong prompt từng ảnh hoặc cảnh, không đặt trong phong cách chung.') },
        ],
      },
      {
        id: 'find-edit-project',
        title: b('Find, open and edit existing projects', 'Tìm, mở và sửa dự án hiện có'),
        blocks: [
          { type: 'steps', items: [
            b('Use the project search field to match text in the name, description or shared style. Search ignores letter case; clear the field if the list appears unexpectedly empty.', 'Dùng ô tìm dự án để tìm nội dung trong tên, mô tả hoặc phong cách chung. Tìm kiếm không phân biệt chữ hoa chữ thường; xóa nội dung ô nếu danh sách trống ngoài dự kiến.'),
            b('Enable Show archived projects when looking for an archived item. The normal list hides archived projects by default; Trash is a separate view.', 'Bật Hiện dự án lưu trữ khi tìm mục đã lưu trữ. Danh sách thường mặc định ẩn các dự án này; Thùng rác là chế độ xem riêng.'),
            b('Open a project card, use Edit project to change its saved details, and save the form. Use Refresh to reload the list and the selected project’s characters, scenes and results after a loading problem.', 'Mở thẻ dự án, dùng Sửa dự án để thay thông tin đã lưu rồi lưu biểu mẫu. Dùng Làm mới để tải lại danh sách cùng nhân vật, cảnh và kết quả của dự án đang chọn sau khi gặp lỗi tải.'),
          ] },
          { type: 'callout', tone: 'info', title: b('Project settings are not a regeneration command', 'Thiết lập dự án không phải lệnh tạo lại'), text: b('Saving a name, style or language changes project configuration. It does not itself request new images or videos. Inspect the next scene prompt preview before generating with revised creative direction.', 'Lưu tên, phong cách hoặc ngôn ngữ chỉ đổi cấu hình dự án, không tự yêu cầu ảnh hay video mới. Kiểm tra phần xem trước prompt của cảnh trước khi tạo theo định hướng đã sửa.') },
        ],
      },
      {
        id: 'workspace-tabs',
        title: b('Use the right tab for each resource', 'Dùng đúng thẻ cho từng tài nguyên'),
        blocks: [
          { type: 'table', headers: [b('Tab', 'Thẻ'), b('Workflow', 'Quy trình')], rows: [
            [b('Images', 'Ảnh'), b('Create standalone project images and review their result cards. These are not automatically the storyboard illustrations of video scenes.', 'Tạo ảnh riêng trong dự án và xem các thẻ kết quả. Chúng không tự trở thành ảnh minh họa storyboard của cảnh video.')],
            [b('Characters', 'Nhân vật'), b('Add and edit appearance and voice profiles. Cards indicate whether a character belongs to this project or the shared library; check that scope before editing reusable identities.', 'Thêm và sửa ngoại hình cùng hồ sơ giọng nói. Thẻ cho biết nhân vật thuộc dự án hay thư viện dùng chung; kiểm tra phạm vi trước khi sửa nhân vật được tái sử dụng.')],
            [b('Locations', 'Bối cảnh'), b('Maintain names, stage, descriptions, continuity notes and image prompts. Upload references, generate references with an image model or attach an existing result; labelled views help distinguish camera angles.', 'Quản lý tên, giai đoạn, mô tả, ghi chú liên tục và prompt ảnh. Tải ảnh tham chiếu, tạo ảnh bằng model ảnh hoặc gắn kết quả có sẵn; các góc có nhãn giúp phân biệt hướng máy quay.')],
            [b('Video scenes', 'Cảnh video'), b('Create ordered scenes, assign video models, approve scenes, generate versions and export the assembled video. See the scene and export article for the full sequence.', 'Tạo cảnh theo thứ tự, gán model video, duyệt cảnh, tạo phiên bản và xuất video đã ghép. Xem bài về cảnh và xuất video để thực hiện đầy đủ quy trình.')],
            [b('Canvas', 'Canvas'), b('Open the project’s visual board with its project resources. Keep this separate from the scene list when checking the order used for video export.', 'Mở bảng làm việc trực quan cùng tài nguyên dự án. Phân biệt bảng này với danh sách cảnh khi kiểm tra thứ tự dùng để xuất video.')],
          ] },
          { type: 'callout', tone: 'warning', title: b('Reference privacy and permission', 'Quyền sử dụng và riêng tư của ảnh tham chiếu'), text: b('Use only faces, locations, logos and source images you have permission to process. A reference or prompt used for generation may be sent to the configured provider; inspect available previews and temporary-media options instead of assuming an upload stays only in the browser.', 'Chỉ dùng khuôn mặt, địa điểm, logo và ảnh nguồn mà bạn có quyền xử lý. Tham chiếu hoặc prompt dùng để tạo có thể được gửi đến provider đã cấu hình; hãy kiểm tra phần xem trước và tùy chọn media tạm thay vì cho rằng tệp tải lên chỉ nằm trong trình duyệt.') },
        ],
      },
      {
        id: 'project-images',
        title: b('Generate and review project images', 'Tạo và kiểm tra ảnh trong dự án'),
        blocks: [
          { type: 'steps', items: [
            b('In Images, write the image description and choose an enabled image model. Choose 1024×1024, 1536×1024 or 1024×1536, then select Default, Low, Medium or High quality as appropriate for that provider.', 'Trong thẻ Ảnh, viết mô tả và chọn model ảnh đang bật. Chọn 1024×1024, 1536×1024 hoặc 1024×1536, rồi chọn chất lượng Mặc định, Thấp, Trung bình hoặc Cao phù hợp với provider.'),
            b('Expand references when needed: optionally attach a character, use entity mentions and add up to four source images. Source images use the image-edit workflow; the provider must support it. Review the server preview when it is shown before confirming generation.', 'Mở phần tham chiếu khi cần: có thể gắn nhân vật, dùng đề cập thực thể và thêm tối đa bốn ảnh nguồn. Ảnh nguồn sử dụng quy trình chỉnh sửa ảnh; provider phải hỗ trợ. Kiểm tra bản xem trước từ máy chủ khi được hiển thị trước khi xác nhận tạo.'),
            b('Choose Generate and follow the result card status. If a result has a download failure, use its retry-download action rather than immediately generating another image. Advanced JSON must be an object, not an array or plain text.', 'Bấm Tạo và theo dõi trạng thái trên thẻ kết quả. Nếu kết quả lỗi tải tệp, dùng thao tác tải lại thay vì lập tức tạo ảnh khác. JSON nâng cao phải là đối tượng, không phải mảng hay văn bản thuần.'),
          ] },
          { type: 'callout', tone: 'warning', title: b('Check model support and charges', 'Kiểm tra hỗ trợ model và chi phí'), text: b('Generation uses your API key and may incur provider charges. Quality and reference support vary by model; Default quality avoids sending a provider-specific quality value. If no usable model is listed, configure a provider and classify an image model in API & Models before retrying.', 'Tạo nội dung dùng API key của bạn và có thể phát sinh phí provider. Chất lượng và khả năng nhận ảnh tham chiếu tùy model; chất lượng Mặc định không gửi giá trị chất lượng riêng của provider. Nếu không có model dùng được, cấu hình provider và phân loại model ảnh trong API & Models trước khi thử lại.') },
        ],
      },
      {
        id: 'archive-trash-recovery',
        title: b('Archive, trash and recover without surprises', 'Lưu trữ, chuyển thùng rác và khôi phục an toàn'),
        blocks: [
          { type: 'table', headers: [b('Action', 'Thao tác'), b('Effect and recovery', 'Tác động và khôi phục')], rows: [
            [b('Archive', 'Lưu trữ'), b('Keeps the project but blocks new content creation. Enable Show archived projects, open it and choose Restore before resuming creation.', 'Giữ dự án nhưng chặn tạo nội dung mới. Bật Hiện dự án lưu trữ, mở dự án và chọn Khôi phục trước khi tiếp tục tạo.')],
            [b('Move to trash', 'Chuyển vào thùng rác'), b('Opens a confirmation dialog. Results are kept by default; read the optional result-file deletion checkbox carefully. The project can be restored during its 30-day trash period.', 'Mở hộp thoại xác nhận. Mặc định giữ kết quả; đọc kỹ ô tùy chọn xóa tệp kết quả. Có thể khôi phục dự án trong thời gian 30 ngày ở thùng rác.')],
            [b('Restore from Trash', 'Khôi phục từ Thùng rác'), b('Returns the project without automatically queuing generation. Check the expiry date and result-retention note shown on the trash item before relying on recovery.', 'Đưa dự án trở lại mà không tự xếp hàng tạo nội dung. Kiểm tra hạn xóa và ghi chú giữ kết quả trên mục trong thùng rác trước khi dựa vào khả năng khôi phục.')],
          ] },
          { type: 'callout', tone: 'warning', title: b('Wait for active work before deletion', 'Chờ tác vụ đang chạy trước khi xóa'), text: b('Projects with running or unknown tasks must wait for those tasks to finish before deletion. If deletion fails, inspect task status and the displayed error rather than repeatedly submitting it. Trash is not permanent backup: after 30 days the project is permanently deleted, with result handling determined by your deletion choice.', 'Dự án có tác vụ đang chạy hoặc chưa rõ trạng thái phải chờ tác vụ kết thúc trước khi xóa. Nếu xóa thất bại, kiểm tra trạng thái tác vụ và thông báo lỗi thay vì gửi lặp lại. Thùng rác không phải bản sao lưu vĩnh viễn: sau 30 ngày dự án bị xóa hẳn, còn kết quả được xử lý theo lựa chọn khi xóa.') },
        ],
      },
    ],
  },
  {
    id: 'scenes-export',
    group: 'create',
    title: b('Edit scenes, choose versions and export video', 'Sửa cảnh, chọn phiên bản và xuất video'),
    description: b('Move from a saved scene and prompt preview to individual or bulk video generation, then join completed versions into a downloadable project export.', 'Đi từ cảnh đã lưu và bản xem trước prompt đến tạo video riêng lẻ hoặc hàng loạt, rồi ghép các phiên bản hoàn tất thành bản xuất dự án để tải về.'),
    keywords: b('scene editor preview dialogue speaker voice bulk approval versions cover results export ffmpeg video download', 'cảnh trình sửa xem trước prompt lời thoại người nói giọng hàng loạt duyệt phiên bản ảnh bìa kết quả xuất ffmpeg video tải về'),
    destination: 'studio',
    related: ['studio-projects'],
    sections: [
      {
        id: 'scene-content',
        title: b('Create a scene and configure its video', 'Tạo cảnh và cấu hình video'),
        blocks: [
          { type: 'steps', items: [
            b('Open a project’s Video scenes tab and add a scene, or edit an existing scene. Give it a clear scene name and describe the action, framing and camera movement. Add setting text or choose a project location where appropriate.', 'Mở thẻ Cảnh video của dự án rồi thêm cảnh hoặc sửa cảnh hiện có. Đặt tên rõ ràng và mô tả hành động, bố cục cùng chuyển động máy quay. Thêm nội dung bối cảnh hoặc chọn bối cảnh dự án khi phù hợp.'),
            b('Expand video configuration, choose a provider and an enabled video model, then adjust the model-specific controls. Duration, resolution and supported input modes depend on the model; do not copy incompatible parameters from a different provider.', 'Mở cấu hình video, chọn provider và model video đang bật, rồi điều chỉnh bộ điều khiển riêng của model. Thời lượng, độ phân giải và chế độ đầu vào phụ thuộc model; không sao chép thông số không tương thích từ provider khác.'),
            b('Save scene or choose Save & preview prompt. A scene needs a title and a usable model; a description is normally required, with a model-specific exception for Higgsfield image mode. Fix validation errors before requesting generation.', 'Bấm Lưu cảnh hoặc Lưu & xem trước prompt. Cảnh cần tên và model dùng được; thông thường phải có mô tả, ngoại trừ chế độ ảnh của Higgsfield theo quy tắc model. Khắc phục lỗi kiểm tra dữ liệu trước khi yêu cầu tạo.'),
          ] },
          { type: 'table', headers: [b('Configuration', 'Cấu hình'), b('What to check', 'Điều cần kiểm tra')], rows: [
            [b('Video model', 'Model video'), b('If a previously saved model is unavailable, explicitly choose an available video model. If none exists, add and classify one in API & Models.', 'Nếu model đã lưu không còn khả dụng, chủ động chọn model video hiện có. Nếu chưa có model nào, thêm và phân loại trong API & Models.')],
            [b('Duration and advanced JSON', 'Thời lượng và JSON nâng cao'), b('Use the permitted duration for the selected model. Advanced parameters must parse as a JSON object; invalid JSON can block saving, preview and model changes.', 'Dùng thời lượng được phép của model đã chọn. Thông số nâng cao phải phân tích được thành đối tượng JSON; JSON sai có thể chặn lưu, xem trước và đổi model.')],
            [b('References and overlays', 'Tham chiếu và lớp phủ'), b('Bind only intended entities and inspect the preview for actual references and warnings. Temporary-media permission is separate from writing a name in the prompt.', 'Chỉ gắn thực thể cần thiết và xem bản xem trước để biết tham chiếu thực tế cùng cảnh báo. Quyền dùng media tạm là lựa chọn riêng, không đồng nghĩa với việc viết tên trong prompt.')],
          ] },
        ],
      },
      {
        id: 'dialogue-voice',
        title: b('Write dialogue for one speaking character', 'Viết lời thoại cho một nhân vật nói'),
        blocks: [
          { type: 'paragraph', text: b('Choose the speaking character before adding dialogue. A scene with dialogue cannot be saved without a speaker. Each scene supports one speaking character; split a conversation into separate scenes when you need a different speaker and voice profile.', 'Chọn nhân vật nói trước khi nhập lời thoại. Cảnh có lời thoại không thể lưu nếu thiếu người nói. Mỗi cảnh hỗ trợ một nhân vật nói; chia hội thoại thành các cảnh riêng khi cần đổi người nói và hồ sơ giọng.') },
          { type: 'example', title: b('A simple speaking shot', 'Một cảnh nói đơn giản'), text: b('Scene: Morning greeting. Action: An pauses on a misty forest path; medium close-up, gentle camera push-in. Speaker: An. Dialogue: “We are finally back.” Keep another character’s reply in the next scene rather than putting two speakers in this dialogue field.', 'Cảnh: Lời chào buổi sáng. Hành động: An dừng trên lối rừng có sương; cận vừa, máy quay tiến nhẹ. Người nói: An. Lời thoại: “Cuối cùng mình cũng trở lại.” Đặt câu đáp của nhân vật khác ở cảnh tiếp theo thay vì nhập hai người nói trong ô lời thoại này.') },
          { type: 'callout', tone: 'warning', title: b('Voice guidance is not an identity lock', 'Hướng dẫn giọng không khóa danh tính'), text: b('The model receives the chosen character’s voice profile, but prompt instructions cannot lock voice identity or guarantee lip sync. Preview the generated audio and mouth movement before selecting a version; use only voice descriptions and likenesses you are authorized to process.', 'Model nhận hồ sơ giọng của nhân vật đã chọn, nhưng chỉ dẫn prompt không khóa được danh tính giọng hoặc bảo đảm khớp miệng. Nghe âm thanh và kiểm tra chuyển động miệng trước khi chọn phiên bản; chỉ dùng mô tả giọng và hình ảnh nhân vật mà bạn có quyền xử lý.') },
        ],
      },
      {
        id: 'preview-generate',
        title: b('Save, preview and generate deliberately', 'Chủ động lưu, xem trước và tạo'),
        blocks: [
          { type: 'steps', items: [
            b('Use Save & preview prompt to persist the current scene and display the compiled prompt sent to the provider. Check the combined scene instructions, shared project direction and speaker details rather than reviewing only the short action field.', 'Dùng Lưu & xem trước prompt để lưu cảnh hiện tại và hiển thị prompt đã tổng hợp gửi đến provider. Kiểm tra cả chỉ dẫn cảnh, định hướng chung của dự án và thông tin người nói, không chỉ ô hành động ngắn.'),
            b('After editing, save again before using Generate / retry a new version. Generation is disabled for an unsaved or dirty draft, during an illustration upload, in an archived project or when video configuration is invalid.', 'Sau khi chỉnh sửa, lưu lại trước khi dùng Tạo / thử lại phiên bản mới. Nút tạo bị khóa khi bản nháp chưa lưu hoặc đã thay đổi, đang tải ảnh minh họa, dự án đã lưu trữ hoặc cấu hình video không hợp lệ.'),
            b('If an entity confirmation appears, inspect the effective prompt, reference count, overlays and warnings before confirming. Changing inputs invalidates that confirmation. Follow queued, running and downloading states until the result is ready.', 'Nếu xuất hiện xác nhận thực thể, kiểm tra prompt thực tế, số ảnh tham chiếu, lớp phủ và cảnh báo trước khi xác nhận. Đổi dữ liệu đầu vào làm xác nhận cũ mất hiệu lực. Theo dõi các trạng thái chờ, đang chạy và đang tải cho đến khi kết quả sẵn sàng.'),
          ] },
          { type: 'callout', tone: 'warning', title: b('A new version may mean another provider charge', 'Phiên bản mới có thể phát sinh phí provider'), text: b('Generate / retry a new version submits a new generation using your API key. Saving or previewing a scene is not the same action. When an existing generation only failed to download, use Retry download where offered instead of paying for another generation unnecessarily.', 'Tạo / thử lại phiên bản mới gửi yêu cầu tạo mới bằng API key của bạn. Lưu hoặc xem trước cảnh là thao tác khác. Khi tác vụ hiện có chỉ lỗi tải tệp, dùng Tải lại nếu có thay vì tạo lại và phát sinh phí không cần thiết.') },
        ],
      },
      {
        id: 'bulk-scenes',
        title: b('Apply bulk settings, approve and queue scenes', 'Áp dụng cấu hình hàng loạt, duyệt và xếp hàng cảnh'),
        blocks: [
          { type: 'steps', items: [
            b('Select scene checkboxes, then open Bulk actions and Bulk video settings. With selected scenes, applying settings replaces their model and video settings. With no selection, it targets only scenes without a model.', 'Chọn các ô cảnh rồi mở Thao tác hàng loạt và Cấu hình video hàng loạt. Khi có chọn cảnh, áp dụng sẽ thay model và thông số video của các cảnh đó. Khi không chọn, chỉ nhắm đến cảnh chưa có model.'),
            b('Choose the provider, model and valid parameters, inspect the target count, then Apply model and settings. This only saves configuration; it does not generate videos. Scene-specific references and logos are preserved, while shared frames entered here apply to all receiving scenes.', 'Chọn provider, model và thông số hợp lệ, kiểm tra số cảnh đích rồi bấm Áp dụng model và cấu hình. Thao tác chỉ lưu cấu hình, không tạo video. Tham chiếu và logo riêng từng cảnh được giữ lại, còn khung hình chung nhập tại đây áp dụng cho mọi cảnh nhận cấu hình.'),
            b('Approve the intended scenes individually or use Approve selected. Choose Generate for approved scenes: with a selection, only approved scenes within that selection are targeted; without a selection, all approved scenes are targeted. The worker queues them sequentially.', 'Duyệt từng cảnh mong muốn hoặc dùng Duyệt cảnh đã chọn. Bấm Tạo cho các cảnh đã duyệt: khi có chọn cảnh, chỉ nhắm đến cảnh đã duyệt trong phần chọn; khi không chọn, nhắm đến mọi cảnh đã duyệt. Worker xếp hàng lần lượt.'),
          ] },
          { type: 'callout', tone: 'warning', title: b('Apply the draft before generation', 'Áp dụng bản nháp trước khi tạo'), text: b('Bulk generation uses each scene’s saved settings, not an unsaved bulk draft. Applying settings clears pending automatic-generation flags but does not change already queued or running videos. Check scope, approvals and provider fees before starting a large batch; storyboard illustrations are not automatically input frames.', 'Tạo hàng loạt dùng cấu hình đã lưu của từng cảnh, không dùng bản nháp hàng loạt chưa áp dụng. Áp dụng cấu hình xóa cờ chờ tự tạo nhưng không đổi video đã xếp hàng hoặc đang chạy. Kiểm tra phạm vi, trạng thái duyệt và phí provider trước khi chạy nhiều cảnh; ảnh storyboard không tự trở thành khung hình đầu vào.') },
        ],
      },
      {
        id: 'versions-results-cover',
        title: b('Review versions and understand scene covers', 'Kiểm tra phiên bản và hiểu ảnh bìa cảnh'),
        blocks: [
          { type: 'steps', items: [
            b('Open a scene’s results to see its history, newest first, with creation dates, model/provider and generation status. Play completed videos and compare them before choosing Select this version.', 'Mở kết quả của cảnh để xem lịch sử từ mới đến cũ, kèm thời điểm tạo, model/provider và trạng thái. Phát các video đã hoàn tất và so sánh trước khi bấm Chọn phiên bản này.'),
            b('The selected marker records the version to use for export. You can return to editing from the results window; failed or active entries are not substitutes for a completed video.', 'Dấu đã chọn ghi nhận phiên bản dùng để xuất. Có thể quay lại sửa từ cửa sổ kết quả; mục thất bại hoặc đang chạy không thay thế được video hoàn tất.'),
            b('For a storyboard illustration, save the scene first, then upload a replacement or remove the illustration in the editor. Illustrations may also come from the AI script planner timeline. They are visual planning aids and are not sent to the video model as input frames.', 'Để dùng ảnh minh họa storyboard, lưu cảnh trước rồi tải ảnh thay thế hoặc xóa ảnh trong trình sửa. Ảnh cũng có thể đến từ timeline của Tạo kịch bản AI. Đây là công cụ lập kế hoạch trực quan, không được gửi đến model video làm khung hình đầu vào.'),
          ] },
          { type: 'callout', tone: 'info', title: b('A cover is not proof of the export selection', 'Ảnh bìa không chứng minh phiên bản xuất'), text: b('Scene cards try to show a usable video from the latest video task, fall back to the illustration if video media is unavailable, and finally show a play placeholder. A newer queued or failed task can therefore leave an illustration visible even when an older successful version exists. Check the selected version in results before export.', 'Thẻ cảnh cố hiển thị video dùng được từ tác vụ video mới nhất, chuyển sang ảnh minh họa nếu không có media video, cuối cùng là biểu tượng phát. Vì vậy tác vụ mới đang chờ hoặc thất bại có thể khiến ảnh minh họa vẫn xuất hiện dù có phiên bản thành công cũ. Kiểm tra phiên bản đã chọn trong kết quả trước khi xuất.') },
        ],
      },
      {
        id: 'export-project-video',
        title: b('Join completed scene videos into an export', 'Ghép video cảnh hoàn tất thành bản xuất'),
        blocks: [
          { type: 'steps', items: [
            b('Check the scene order in the project and use the scene move controls to correct it. Export follows timeline order and includes every scene, so each scene needs a successful video with an available file.', 'Kiểm tra thứ tự cảnh trong dự án và dùng nút di chuyển cảnh để sửa. Bản xuất theo thứ tự timeline và gồm mọi cảnh, nên mỗi cảnh phải có video thành công với tệp còn khả dụng.'),
            b('Preview and select the preferred successful video for each scene. The export uses that selected usable version; when it is unavailable, it falls back to the latest successful video with an asset. Wait for any logo post-processing to finish.', 'Xem trước và chọn video thành công mong muốn cho từng cảnh. Bản xuất dùng phiên bản đã chọn còn dùng được; nếu không khả dụng, hệ thống dùng video thành công mới nhất có tệp. Chờ bước xử lý chèn logo hoàn tất.'),
            b('Open the project export window and choose Create video export. Opening the window alone does not start an export. This joins existing scene videos; it does not generate missing videos.', 'Mở cửa sổ xuất video của dự án và chọn Tạo bản xuất video. Chỉ mở cửa sổ không bắt đầu xuất. Thao tác ghép video cảnh có sẵn, không tạo những video còn thiếu.'),
            b('Follow queued and running progress in recent exports. You may close the window while server processing continues and reopen it later. When completed, choose Download video; use Delete export only when you no longer need that exported copy.', 'Theo dõi tiến trình chờ và đang chạy trong danh sách bản xuất gần đây. Có thể đóng cửa sổ trong lúc máy chủ tiếp tục xử lý rồi mở lại sau. Khi hoàn tất, chọn Tải video về; chỉ dùng Xóa bản xuất khi không còn cần bản ghép đó.'),
          ] },
          { type: 'callout', tone: 'tip', title: b('Treat each export as a production snapshot', 'Xem mỗi bản xuất như một bản chốt sản xuất'), text: b('An export records its scene video choices when it is created. If you later reorder scenes or select other versions, create another export to reflect the changes. Downloaded videos contain the chosen imagery, dialogue and logos; review them before sharing outside your team.', 'Bản xuất ghi nhận lựa chọn video cảnh tại thời điểm tạo. Nếu sau đó đổi thứ tự cảnh hoặc chọn phiên bản khác, tạo bản xuất mới để phản ánh thay đổi. Video tải về chứa hình ảnh, lời thoại và logo đã chọn; kiểm tra trước khi chia sẻ ra ngoài nhóm.') },
        ],
      },
      {
        id: 'scene-export-troubleshooting',
        title: b('Troubleshoot scene generation and export', 'Khắc phục lỗi tạo cảnh và xuất video'),
        blocks: [
          { type: 'table', headers: [b('Symptom', 'Hiện tượng'), b('Next step', 'Bước xử lý')], rows: [
            [b('Generate is disabled', 'Nút Tạo bị khóa'), b('Save the latest edits, finish illustration uploads and check model, duration and JSON validation. Restore an archived project before creating content.', 'Lưu chỉnh sửa mới nhất, chờ tải ảnh minh họa xong và kiểm tra model, thời lượng cùng JSON. Khôi phục dự án đã lưu trữ trước khi tạo nội dung.')],
            [b('Dialogue needs a character', 'Lời thoại cần nhân vật'), b('Choose one speaking character or clear the dialogue for a silent scene, then save again.', 'Chọn một nhân vật nói hoặc xóa lời thoại nếu cảnh im lặng, rồi lưu lại.')],
            [b('No approved scene is ready', 'Chưa có cảnh đã duyệt sẵn sàng'), b('Check approvals and selection scope. Assign and apply saved video settings before requesting the approved batch.', 'Kiểm tra trạng thái duyệt và phạm vi chọn. Gán và áp dụng cấu hình video đã lưu trước khi yêu cầu tạo nhóm đã duyệt.')],
            [b('A scene has no video to export', 'Một cảnh chưa có video để xuất'), b('Return to that named scene, generate a video and wait for a successful downloadable result. An illustration or queued version is not enough; then create the export again.', 'Quay lại cảnh được nêu tên, tạo video và chờ kết quả thành công có tệp tải được. Ảnh minh họa hoặc phiên bản đang chờ chưa đủ; sau đó tạo bản xuất lại.')],
            [b('ffmpeg is unavailable', 'ffmpeg không khả dụng'), b('Ask the app operator to install ffmpeg on the server or configure FFMPEG_PATH. This is server tooling, not a missing browser feature; do not remake scene videos just for this error. Create a new export after the tooling is fixed.', 'Nhờ người quản lý ứng dụng cài ffmpeg trên máy chủ hoặc cấu hình FFMPEG_PATH. Đây là công cụ máy chủ, không phải tính năng thiếu của trình duyệt; không cần tạo lại video cảnh chỉ vì lỗi này. Tạo bản xuất mới sau khi sửa công cụ.')],
            [b('Export fails or hits a limit', 'Xuất thất bại hoặc chạm giới hạn'), b('Read the displayed error for missing files, scene-count limits, active-export limits or processing failures. Wait for active work where relevant, fix the reported cause and create a fresh export rather than repeatedly submitting unchanged inputs.', 'Đọc lỗi hiển thị để biết thiếu tệp, vượt số cảnh, vượt số bản xuất đang chạy hoặc lỗi xử lý. Chờ tác vụ đang chạy khi phù hợp, sửa nguyên nhân được báo rồi tạo bản xuất mới thay vì gửi lặp dữ liệu không đổi.')],
          ] },
        ],
      },
    ],
  },
]
