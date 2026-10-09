/**
 * Danh mục thông báo lỗi dùng chung cho backend và frontend.
 *
 * Mỗi lỗi do ứng dụng tạo ra (không phải lỗi thô từ provider) có một khoá
 * ngữ nghĩa (`messageKey`) và tham số (`messageParams`) để giao diện dịch sang
 * ngôn ngữ đang dùng. Trường `message` cũ vẫn được giữ nguyên để không phá vỡ
 * các bài test và client cũ.
 *
 * Quy ước:
 * - Khoá có dạng `miền.ngữ_cảnh` (ví dụ `projects.not_found`).
 * - `vi` là câu tiếng Việt; nếu câu có tham số thì dùng `{tenThamSo}`.
 * - `en` là bản dịch tiếng Anh tương ứng.
 * - Lỗi thô từ provider KHÔNG được dịch máy: chỉ bọc bằng khoá ngữ nghĩa và
 *   đặt nội dung gốc vào tham số `detail`.
 */

export type ErrorMessageLocale = 'en' | 'vi'

export const SUPPORTED_ERROR_LOCALES: readonly ErrorMessageLocale[] = ['vi', 'en']

export const DEFAULT_ERROR_LOCALE: ErrorMessageLocale = 'vi'

/** Tham số nội suy cho một khoá thông báo. */
export type ErrorMessageParams = Record<string, string | number>

export type ErrorCatalogEntry = {
  /** Bản tiếng Anh. */
  en: string
  /** Bản tiếng Việt, có thể chứa `{thamSo}`. */
  vi: string
}

const entry = (en: string, vi: string): ErrorCatalogEntry => ({ en, vi })

export const ERROR_CATALOG = {
  // ── Lỗi chung, dùng làm khoá dự phòng theo `code` ─────────────────────────
  'errors.bad_request': entry('The request data is invalid', 'Dữ liệu không hợp lệ'),
  'errors.unauthorized': entry('You need to sign in to continue', 'Bạn cần đăng nhập để tiếp tục'),
  'errors.forbidden': entry(
    'You do not have permission to perform this action',
    'Bạn không có quyền thực hiện thao tác này',
  ),
  'errors.not_found': entry('Not found', 'Không tìm thấy dữ liệu'),
  'errors.conflict': entry('The data conflicts with the current state', 'Dữ liệu xung đột với trạng thái hiện tại'),
  'errors.rate_limited': entry(
    'You are doing that too fast, please try again later',
    'Bạn thao tác quá nhanh, vui lòng thử lại sau',
  ),
  'errors.provider_error': entry('The AI provider failed. Please try again.', 'Nhà cung cấp AI gặp lỗi. Vui lòng thử lại.'),
  'errors.provider_incompatible': entry(
    'The AI provider returned data we cannot use.',
    'Nhà cung cấp AI trả về dữ liệu không phù hợp.',
  ),
  'errors.outcome_unknown': entry(
    'The outcome is still unknown. Check with the provider before retrying.',
    'Chưa xác định được kết quả xử lý. Hãy kiểm tra lại trước khi thử lại.',
  ),
  'errors.storage_limit': entry('The storage limit was exceeded.', 'Vượt giới hạn dung lượng cho phép.'),
  'errors.payload_too_large': entry('The uploaded file exceeds the size limit', 'Tệp tải lên vượt giới hạn cho phép'),
  'errors.invalid_json': entry('The request body is not valid JSON', 'Dữ liệu gửi lên không đúng định dạng'),
  'errors.internal': entry('Internal server error', 'Lỗi máy chủ'),
  'errors.unknown': entry('Unknown error', 'Lỗi không xác định'),
  'errors.endpoint_not_found': entry('The endpoint does not exist', 'Endpoint không tồn tại'),

  // ── Xác thực ──────────────────────────────────────────────────────────────
  'auth.credentials_invalid': entry('Invalid email or password', 'Email hoặc mật khẩu không hợp lệ'),
  'auth.invalid_credentials': entry('Incorrect email or password', 'Email hoặc mật khẩu không đúng'),
  'auth.current_password_incorrect': entry('The current password is incorrect', 'Mật khẩu hiện tại không đúng'),
  'auth.email_taken': entry('This email is already registered', 'Email này đã được đăng ký'),
  'auth.register_rate_limited': entry(
    'You have created too many accounts. Please try again later.',
    'Bạn đã tạo quá nhiều tài khoản. Vui lòng thử lại sau.',
  ),
  'auth.login_rate_limited': entry(
    'Too many failed sign-in attempts. Please try again later.',
    'Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau.',
  ),
  'auth.origin_forbidden': entry('This origin is not allowed', 'Origin không được phép'),
  'auth.password_too_short': entry('The password must be at least {min} characters', 'Mật khẩu phải có ít nhất {min} ký tự'),
  'auth.password_too_long': entry('The password is too long', 'Mật khẩu quá dài'),
  'auth.email_domain_not_allowed': entry(
    'Only accounts with an email in {domains} can register.',
    'Chỉ tài khoản có email thuộc tên miền {domains} mới được đăng ký.',
  ),

  // ── Kiểm tra dữ liệu đầu vào (Zod) ────────────────────────────────────────
  'validation.invalid_payload': entry('The submitted data is invalid', 'Dữ liệu gửi lên không hợp lệ'),
  'validation.email_invalid': entry('Invalid email', 'Email không hợp lệ'),
  'validation.password_required': entry('Please enter a password', 'Vui lòng nhập mật khẩu'),
  'validation.image_model_required': entry('Please choose an image model', 'Vui lòng chọn model tạo ảnh'),
  'validation.image_generation_required': entry('An image generation task is missing', 'Thiếu tác vụ tạo ảnh'),
  'validation.model_required': entry('Please choose a model', 'Vui lòng chọn model'),
  'validation.prompt_required': entry('Please enter a description', 'Vui lòng nhập mô tả'),
  'validation.provider_required': entry('Please choose a provider', 'Vui lòng chọn provider'),
  'validation.model_id_required': entry('Please enter a model ID', 'Vui lòng nhập model ID'),
  'validation.content_required': entry('Please enter the content', 'Vui lòng nhập nội dung'),
  'validation.character_name_required': entry('The character needs a name', 'Nhân vật cần có tên'),
  'validation.display_name_required': entry('Please enter a display name', 'Vui lòng nhập tên hiển thị'),
  'validation.base_url_required': entry('Please enter the Base URL', 'Vui lòng nhập Base URL'),
  'validation.api_key_required': entry('Please enter the API key', 'Vui lòng nhập API key'),

  // ── Dùng chung ────────────────────────────────────────────────────────────
  'common.no_changes': entry('There is nothing to save', 'Không có thay đổi nào để lưu'),
  'common.image_body_missing': entry('No image content was received', 'Không nhận được nội dung ảnh'),
  'common.source_image_body_missing': entry('No source image content was received', 'Không nhận được nội dung ảnh nguồn'),
  'common.reference_image_body_missing': entry(
    'No reference image content was received',
    'Không nhận được nội dung ảnh tham chiếu',
  ),

  // ── Dự án, cảnh, nhân vật ─────────────────────────────────────────────────
  'projects.not_found': entry('Project not found', 'Không tìm thấy dự án'),
  'projects.scene_not_found': entry('Scene not found', 'Không tìm thấy cảnh'),
  'projects.archived': entry('The project is archived', 'Dự án đã được lưu trữ'),
  'projects.restore_expired': entry('The restore window for this project has expired', 'Đã hết thời hạn khôi phục dự án'),
  'projects.not_in_trash': entry('The project is not in the trash', 'Dự án không nằm trong thùng rác'),
  'projects.active_generations': entry(
    'The project still has active or undetermined generation tasks',
    'Dự án còn tác vụ tạo nội dung đang hoạt động hoặc chưa xác định trạng thái',
  ),
  'projects.active_exports': entry('The project still has an active video export', 'Dự án còn tác vụ xuất video đang hoạt động'),
  'projects.model_not_owned': entry('The model does not belong to your account', 'Model không thuộc tài khoản của bạn'),
  'projects.select_generation_invalid': entry(
    'You can only select a successful task from this scene',
    'Chỉ có thể chọn tác vụ thành công thuộc cảnh này',
  ),
  'projects.scene_has_no_generation': entry('The new scene has no task to select yet', 'Cảnh mới chưa có tác vụ để chọn'),
  'projects.scene_position_invalid': entry('The scene position is invalid', 'Vị trí cảnh không hợp lệ'),
  'projects.scene_order_invalid': entry(
    'The order must contain every scene exactly once',
    'Thứ tự phải chứa đầy đủ mỗi cảnh đúng một lần',
  ),
  'scenes.illustration_not_found': entry(
    'The illustration image does not exist or does not belong to your account',
    'Ảnh minh hoạ không tồn tại hoặc không thuộc tài khoản của bạn',
  ),

  'characters.not_found': entry('Character not found', 'Không tìm thấy nhân vật'),
  'characters.in_use': entry(
    'The character is used by a scene. Remove it from the scene before deleting.',
    'Nhân vật đang được cảnh sử dụng. Gỡ nhân vật khỏi cảnh trước khi xóa.',
  ),
  'characters.reference_image_missing': entry('The character has no reference image yet', 'Nhân vật chưa có ảnh tham chiếu'),
  'characters.reference_image_gone': entry(
    'The character reference image is no longer in media storage. Upload it again.',
    'Ảnh tham chiếu của nhân vật không còn trong kho media. Hãy tải lại ảnh cho nhân vật.',
  ),
  'characters.image_model_invalid': entry(
    'The selected model is invalid or not classified as "Image generation".',
    'Model đã chọn không hợp lệ hoặc chưa được phân loại thành "Tạo ảnh".',
  ),
  'characters.image_generation_incomplete': entry(
    'The image task has not finished. Wait for it before attaching it to the character.',
    'Tác vụ tạo ảnh chưa hoàn tất. Hãy đợi ảnh xong rồi gắn vào nhân vật.',
  ),

  // ── Tác vụ tạo nội dung ───────────────────────────────────────────────────
  'generations.not_found': entry('Generation task not found', 'Không tìm thấy tác vụ'),
  'generations.image_generation_not_found': entry('Image generation task not found', 'Không tìm thấy tác vụ tạo ảnh'),
  'generations.kind_invalid': entry('Invalid content kind', 'Loại nội dung không hợp lệ'),
  'generations.rate_limited': entry(
    'You are creating too fast. Please wait a moment and try again.',
    'Bạn tạo quá nhanh. Vui lòng đợi một lát rồi thử lại.',
  ),
  'generations.already_succeeded': entry('The task already finished; no need to reload', 'Tác vụ đã hoàn tất, không cần tải lại'),
  'generations.delete_running': entry(
    'The task is running and cannot be deleted. Wait for it to finish.',
    'Tác vụ đang chạy, không thể xóa. Hãy đợi hoàn tất.',
  ),
  'generations.missing_provider_job_id': entry(
    'This task has no provider job ID to reload',
    'Tác vụ này không có ID job ở provider để tải lại',
  ),
  'generations.source_image_not_owned': entry(
    'The source image does not exist or does not belong to your account',
    'Ảnh nguồn không tồn tại hoặc không thuộc tài khoản của bạn',
  ),
  'generations.scene_requires_video_model': entry('A video scene must choose a video model', 'Cảnh video phải chọn model video'),
  'generations.source_images_not_supported': entry(
    'Only image models accept source images for image-to-image generation',
    'Chỉ model tạo ảnh mới nhận ảnh nguồn để tạo ảnh từ ảnh',
  ),
  'generations.model_not_found': entry(
    'The model does not exist or does not belong to your account',
    'Model không tồn tại hoặc không thuộc tài khoản của bạn',
  ),
  'generations.model_unclassified': entry(
    'This model is not classified yet. Set it to Image generation or Video generation in API & Models.',
    'Model này chưa được phân loại. Hãy đặt thành Tạo ảnh hoặc Tạo video trong API & Models.',
  ),
  'generations.model_disabled': entry('This model is disabled', 'Model này đang bị tắt'),
  'generations.prompt_invalid': entry('The description is invalid', 'Mô tả không hợp lệ'),
  'generations.prompt_too_long': entry('The description is limited to {max} characters', 'Mô tả tối đa {max} ký tự'),
  'generations.composed_prompt_too_long': entry(
    'The composed description is limited to 16000 characters',
    'Mô tả tổng hợp tối đa 16000 ký tự',
  ),
  'generations.dialogue_requires_character': entry(
    'Dialogue requires a selected character',
    'Lời thoại cần có nhân vật được chọn',
  ),
  'generations.too_many_source_images': entry(
    'At most {max} source images per generation',
    'Tối đa {max} ảnh nguồn cho một lần tạo',
  ),
  'generations.too_many_input_images': entry(
    'At most {max} input images per generation, including character references. Remove some source images or deselect characters.',
    'Tối đa {max} ảnh đầu vào cho một lần tạo, gồm cả ảnh tham chiếu nhân vật. Hãy bớt ảnh nguồn hoặc bỏ chọn nhân vật.',
  ),
  'generations.too_many_active_jobs': entry(
    'You have {count} running tasks. Wait for them to finish before creating more.',
    'Bạn đang có {count} tác vụ chạy. Hãy đợi hoàn tất rồi tạo thêm.',
  ),

  // ── Lỗi tác vụ được lưu lại (worker) ──────────────────────────────────────
  'generations.provider_missing': entry(
    'The provider for this task was deleted. Add it again and create a new task.',
    'Provider của tác vụ này đã bị xóa. Hãy thêm lại provider rồi thử tạo mới.',
  ),
  'generations.provider_missing_short': entry(
    'The provider for this task was deleted.',
    'Provider của tác vụ này đã bị xóa.',
  ),
  'generations.poll_timeout': entry(
    'Automatic tracking stopped after the wait limit. You can check again with the job ID without creating a new video.',
    'Đã dừng theo dõi tự động sau thời gian chờ. Bạn có thể kiểm tra lại bằng ID job mà không tạo video mới.',
  ),
  'generations.provider_failed': entry('The provider reported that the task failed', 'Provider báo tác vụ thất bại'),
  'generations.provider_job_failed': entry(
    'The provider reported that the video task failed: {detail}',
    'Provider báo tác vụ tạo video thất bại: {detail}',
  ),
  'generations.interrupted': entry(
    'The backend restarted while the task was running and no job ID was available. It is not retried automatically to avoid double billing — check with the provider before retrying.',
    'Backend khởi động lại khi tác vụ đang chạy và chưa có ID job. Không tự gửi lại để tránh tính phí hai lần — hãy kiểm tra ở provider trước khi thử lại.',
  ),
  'generations.download_failed': entry(
    'Could not download the generated media: {detail}',
    'Không tải được media đã tạo: {detail}',
  ),

  // ── Lỗi provider khi tạo ảnh/video ────────────────────────────────────────
  'generations.provider_returned_no_image': entry('The provider returned no image', 'Provider không trả về ảnh nào'),
  'generations.provider_payload_invalid': entry(
    'The provider returned data in an unexpected format',
    'Provider trả về dữ liệu không đúng định dạng',
  ),
  'generations.image_payload_unsupported': entry(
    'The provider reported success but returned no supported b64_json or url field',
    'Provider trả về thành công nhưng không có trường b64_json hoặc url nào được hỗ trợ',
  ),
  'generations.provider_image_unstorable': entry(
    'The provider returned no image content that could be saved',
    'Provider không trả về nội dung ảnh nào có thể lưu',
  ),
  'generations.image_download_failed': entry(
    'Could not download the image from the provider (status {status})',
    'Không tải được ảnh từ provider (mã {status})',
  ),
  'generations.image_request_rejected': entry(
    'The provider rejected the image request: {detail}',
    'Provider từ chối yêu cầu tạo ảnh: {detail}',
  ),
  'generations.video_job_payload_invalid': entry(
    'The provider returned video job data in an unexpected format',
    'Provider trả về dữ liệu job video không đúng định dạng',
  ),
  'generations.video_job_id_missing': entry('The provider returned no video job ID', 'Provider không trả về ID job video'),
  'generations.video_job_id_missing_poll': entry(
    'The video task has no job ID to track',
    'Tác vụ video không có ID job để theo dõi',
  ),
  'generations.video_job_id_missing_download': entry(
    'The video task has no job ID to download',
    'Tác vụ video không có ID job để tải',
  ),
  'generations.video_job_not_found': entry('The provider can no longer find this video job', 'Provider không còn tìm thấy job video này'),
  'generations.video_state_unsupported': entry(
    'The provider returned an unsupported video job state: {state}',
    'Provider trả về trạng thái job video không được hỗ trợ: {state}',
  ),
  'generations.video_request_rejected': entry(
    'The provider rejected the video request: {detail}',
    'Provider từ chối yêu cầu tạo video: {detail}',
  ),
  'generations.video_not_ready': entry('The provider has no video content to download yet', 'Provider chưa có nội dung video để tải'),
  'generations.video_poll_failed': entry(
    'Could not check video progress: {detail}',
    'Không kiểm tra được tiến trình video: {detail}',
  ),
  'generations.video_download_failed': entry(
    'Could not download the video from the provider: {detail}',
    'Không tải được video từ provider: {detail}',
  ),
  'generations.provider_returned_no_video': entry('The provider returned no video content', 'Provider không trả về nội dung video'),
  'generations.provider_returned_empty_video': entry('The provider returned an empty video', 'Provider trả về video rỗng'),

  // ── Media và dung lượng ───────────────────────────────────────────────────
  'media.source_image_not_found': entry('Source image not found', 'Không tìm thấy ảnh nguồn'),
  'media.source_image_missing': entry('The source image is no longer on the server', 'Ảnh nguồn không còn trên máy chủ'),
  'media.reference_image_missing': entry('The reference image is no longer on the server', 'Ảnh tham chiếu không còn trên máy chủ'),
  'media.generation_image_missing': entry('The task image is no longer on the server', 'Ảnh của tác vụ không còn trên máy chủ'),
  'media.generation_has_no_image': entry('This task has no image to attach', 'Tác vụ này không có ảnh nào để gắn'),
  'media.file_not_found': entry('File not found', 'Không tìm thấy tệp'),
  'media.file_missing': entry('The file no longer exists on the server', 'Tệp không còn tồn tại trên máy chủ'),
  'media.path_invalid': entry('Invalid media path', 'Đường dẫn media không hợp lệ'),
  'media.format_unsupported': entry('Unsupported media format', 'Định dạng media không được hỗ trợ'),
  'media.image_format_unsupported': entry('Unsupported image format', 'Định dạng ảnh không được hỗ trợ'),
  'media.reference_image_format_invalid': entry(
    'The reference image must be a valid PNG, JPEG, WebP or GIF',
    'Ảnh tham chiếu phải là PNG, JPEG, WebP hoặc GIF hợp lệ',
  ),
  'media.source_image_format_invalid': entry(
    'The source image must be a valid PNG, JPEG, WebP or GIF',
    'Ảnh nguồn phải là PNG, JPEG, WebP hoặc GIF hợp lệ',
  ),
  'media.provider_content_unsupported': entry(
    'The content returned by the provider is not a supported image or video format',
    'Nội dung provider trả về không phải định dạng ảnh hoặc video được hỗ trợ',
  ),
  'storage.provider_image_too_large': entry(
    'The image returned by the provider exceeds the size limit',
    'Ảnh provider trả về vượt giới hạn dung lượng cho phép',
  ),
  'storage.user_quota_exceeded': entry(
    'You have used up your media storage. Delete some old results.',
    'Bạn đã dùng hết dung lượng media cho phép. Hãy xóa bớt kết quả cũ.',
  ),
  'storage.video_too_large': entry('The video exceeds the size limit', 'Video vượt giới hạn dung lượng cho phép'),
  'storage.file_too_large': entry('The file exceeds the allowed limit ({maxMb} MB)', 'Tệp vượt giới hạn cho phép ({maxMb} MB)'),
  'storage.reference_image_too_large': entry(
    'The reference image exceeds the {maxMb} MB limit',
    'Ảnh tham chiếu vượt giới hạn {maxMb} MB',
  ),
  'storage.source_image_too_large': entry(
    'The source image exceeds the {maxMb} MB limit',
    'Ảnh nguồn vượt giới hạn {maxMb} MB',
  ),
  'storage.export_video_too_large': entry('The exported video exceeds the {maxMb} MB limit', 'Video xuất vượt giới hạn {maxMb} MB'),

  // ── Xuất video ────────────────────────────────────────────────────────────
  'exports.not_found': entry('Video export not found', 'Không tìm thấy bản xuất video'),
  'exports.already_running': entry(
    'A video export is already running. Wait for it before starting a new one.',
    'Đang có bản xuất video chạy. Hãy đợi hoàn tất rồi xuất bản mới.',
  ),
  'exports.project_has_no_scenes': entry('The project has no scenes to export', 'Dự án chưa có cảnh nào để xuất video'),
  'exports.scene_not_in_project': entry('The export list contains a scene outside this project', 'Danh sách xuất có cảnh không thuộc dự án này'),
  'exports.too_many_scenes': entry('At most {max} scenes per export', 'Một lần xuất tối đa {max} cảnh'),
  'exports.item_invalid': entry(
    'Only videos successfully generated for the correct scene can be stitched. Check the selected scenes.',
    'Chỉ ghép được video đã tạo thành công thuộc đúng cảnh. Hãy kiểm tra lại các cảnh đã chọn.',
  ),
  'exports.generation_has_no_video': entry('The selected task has no video file to stitch', 'Tác vụ đã chọn không có tệp video để ghép'),
  'exports.scene_has_no_video': entry(
    'Scene "{scene}" has no successful video to stitch',
    'Cảnh "{scene}" chưa có video thành công để ghép',
  ),
  'exports.no_scenes_to_stitch': entry('There are no scenes to stitch', 'Không có cảnh nào để ghép'),
  'exports.file_not_ready': entry('This export has no video file yet', 'Bản xuất này chưa có tệp video'),
  'exports.file_missing': entry('The exported video file is no longer on the server', 'Tệp video đã xuất không còn trên máy chủ'),
  'exports.delete_running': entry(
    'The export is running and cannot be deleted yet. Wait for it to finish.',
    'Bản xuất đang chạy, chưa xoá được. Hãy đợi hoàn tất.',
  ),
  'exports.ffmpeg_missing': entry(
    'ffmpeg was not found on the server. Install ffmpeg (for example: apt install ffmpeg) or set FFMPEG_PATH in .env and try again.',
    'Chưa tìm thấy ffmpeg trên máy chủ. Hãy cài ffmpeg (ví dụ: apt install ffmpeg) hoặc đặt FFMPEG_PATH trong .env rồi thử lại.',
  ),
  'exports.media_missing': entry(
    'One video in the list is no longer on the server. Recreate that scene and export again.',
    'Một video trong danh sách không còn trên máy chủ. Hãy tạo lại cảnh đó rồi xuất lại.',
  ),
  'exports.ffmpeg_failed': entry('Video stitching failed: {detail}', 'Ghép video thất bại: {detail}'),
  'exports.failed': entry('Video export failed: {detail}', 'Xuất video thất bại: {detail}'),

  // ── Provider ──────────────────────────────────────────────────────────────
  'providers.not_found': entry('Provider not found', 'Không tìm thấy provider'),
  'providers.api_key_invalid': entry(
    'The API key is invalid or has no access permission',
    'API key không hợp lệ hoặc không có quyền truy cập',
  ),
  'providers.base_url_invalid': entry('The Base URL is invalid', 'Base URL không hợp lệ'),
  'providers.base_url_scheme_unsupported': entry(
    'The Base URL only supports http or https',
    'Base URL chỉ hỗ trợ http hoặc https',
  ),
  'providers.base_url_has_credentials': entry(
    'The Base URL must not contain credentials',
    'Base URL không được chứa thông tin đăng nhập',
  ),
  'providers.base_url_requires_https': entry('The Base URL must use https', 'Base URL phải dùng https'),
  'providers.base_url_private_address': entry(
    'The Base URL points to an internal address, which is not allowed',
    'Base URL trỏ tới địa chỉ nội bộ, không được phép',
  ),
  'providers.dns_resolve_failed': entry('Could not resolve "{host}"', 'Không phân giải được "{host}"'),
  'providers.domain_resolve_failed': entry('Could not resolve the domain "{host}"', 'Không phân giải được tên miền "{host}"'),
  'providers.domain_private_address': entry(
    'The domain "{host}" points to an internal address ({address}), which is not allowed',
    'Tên miền "{host}" trỏ tới địa chỉ nội bộ ({address}), không được phép',
  ),
  'providers.has_active_jobs': entry(
    'This provider still has running tasks. Wait for them to finish or delete the tasks first.',
    'Provider này còn tác vụ đang chạy. Hãy đợi hoàn tất hoặc xóa tác vụ trước.',
  ),
  'providers.models_endpoint_unsupported': entry(
    'This provider does not support the /models endpoint. You can still add models manually.',
    'Provider này không hỗ trợ endpoint /models. Bạn vẫn có thể thêm model thủ công.',
  ),
  'providers.timeout': entry('The provider took too long; the request was cancelled', 'Provider phản hồi quá lâu, yêu cầu đã bị hủy'),
  'providers.redirect_blocked': entry(
    'The provider returned a redirect. For safety the app does not forward the API key elsewhere.',
    'Provider trả về chuyển hướng. Vì an toàn, ứng dụng không tự động gửi API key sang địa chỉ khác.',
  ),
  'providers.models_payload_invalid': entry(
    'The provider returned a model list in an unexpected format',
    'Provider trả về danh sách model không đúng định dạng mong đợi',
  ),
  'providers.models_list_failed': entry('Could not fetch the model list: {detail}', 'Không lấy được danh sách model: {detail}'),
  'providers.test_failed': entry('The provider connection failed: {detail}', 'Kết nối provider thất bại: {detail}'),
  'providers.timeout_unknown': entry(
    'The provider did not respond in time. The request may have been sent and be processing — check before creating a new one.',
    'Provider không phản hồi kịp. Yêu cầu có thể đã được gửi và đang xử lý — hãy kiểm tra lại trước khi thử tạo mới.',
  ),
  'providers.connection_lost_unknown': entry(
    'Lost connection to the provider after sending the request. It may have been processed — check before creating a new one.',
    'Mất kết nối tới provider sau khi gửi yêu cầu. Yêu cầu có thể đã được xử lý — hãy kiểm tra lại trước khi thử tạo mới.',
  ),

  // ── Model ─────────────────────────────────────────────────────────────────
  'models.not_found': entry('Model not found', 'Không tìm thấy model'),
  'models.kind_invalid': entry('Invalid model kind', 'Loại model không hợp lệ'),
  'models.duplicate_id': entry('This model ID already exists in the selected provider', 'Model ID này đã tồn tại trong provider đã chọn'),
  'models.provider_not_found': entry(
    'The provider does not exist or does not belong to your account',
    'Provider không tồn tại hoặc không thuộc tài khoản của bạn',
  ),
  'models.has_active_jobs': entry(
    'This model still has running tasks. Wait for them to finish before deleting.',
    'Model này còn tác vụ đang chạy. Hãy đợi hoàn tất trước khi xóa.',
  ),

  // ── LLM & Chat ────────────────────────────────────────────────────────────
  'llm.model_not_found': entry('LLM & Chat model not found', 'Không tìm thấy model LLM & Chat'),
  'llm.model_missing': entry(
    'There is no LLM & Chat model. In API & Models, add a provider and classify a model as "LLM & Chat".',
    'Chưa có model LLM & Chat. Vào API & Models, thêm provider rồi phân loại một model thành "LLM & Chat".',
  ),
  'llm.model_not_chat': entry(
    'The selected model is not classified as "LLM & Chat". Reclassify it in API & Models.',
    'Model đã chọn chưa được phân loại thành "LLM & Chat". Vào API & Models để phân loại lại.',
  ),
  'llm.model_disabled': entry('This chat model is disabled. Re-enable it in API & Models.', 'Model chat này đang bị tắt. Vào API & Models để bật lại.'),
  'llm.timeout': entry('The AI took too long to respond. Please try again.', 'AI phản hồi quá lâu. Hãy thử lại.'),
  'llm.unreadable_response': entry('The AI returned unreadable data. Please try again.', 'AI trả về dữ liệu không đọc được. Hãy thử lại.'),
  'llm.empty_response': entry('The AI returned empty content', 'AI trả về nội dung rỗng'),
  'llm.chat_endpoint_missing': entry(
    'The provider has no chat/completions endpoint or model "{model}". Check the Base URL and the selected model.',
    'Provider không tìm thấy endpoint chat/completions hoặc model "{model}". Kiểm tra lại Base URL và model đã chọn.',
  ),
  'llm.request_rejected': entry('The AI rejected the request: {detail}', 'AI từ chối yêu cầu: {detail}'),

  // ── Trợ lý lập kế hoạch ───────────────────────────────────────────────────
  'planner.session_not_found': entry('Chat session not found', 'Không tìm thấy phiên trò chuyện'),
  'planner.session_project_not_found': entry('Project for the chat session not found', 'Không tìm thấy dự án của phiên trò chuyện'),
  'planner.session_character_not_found': entry('Character not found in the session', 'Không tìm thấy nhân vật trong phiên'),
  'planner.timeline_frame_not_found': entry('Frame not found in the timeline', 'Không tìm thấy frame trong timeline'),
  'planner.image_batch_not_found': entry('Image generation batch not found', 'Không tìm thấy batch sinh ảnh'),
  'planner.session_kind_invalid': entry('Invalid chat session kind', 'Loại phiên trò chuyện không hợp lệ'),
  'planner.project_session_requires_project': entry('A session inside a project requires a projectId', 'Phiên trong dự án cần có projectId'),
  'planner.session_without_project': entry('A planning session is not attached to an existing project', 'Phiên lập kế hoạch không gắn dự án có sẵn'),
  'planner.rate_limited': entry(
    'You are acting too fast. Please wait a moment and try again.',
    'Bạn thao tác quá nhanh. Vui lòng đợi một lát rồi thử lại.',
  ),
  'planner.video_model_required': entry(
    'Choose a valid, enabled video model. Check it in API & Models.',
    'Cần chọn model video hợp lệ đang bật. Hãy kiểm tra trong API & Models.',
  ),
  'planner.image_model_missing': entry(
    'No image model is selected for this session. Choose one first.',
    'Chưa chọn model ảnh cho phiên này. Hãy chọn model ảnh trước.',
  ),
  'planner.image_model_missing_setup': entry(
    'No image model is selected for this session. Choose one in the model setup step.',
    'Chưa chọn model ảnh cho phiên này. Hãy chọn ở bước cấu hình model.',
  ),
  'planner.model_label_mismatch': entry(
    'The selected model is invalid or not classified as "{label}".',
    'Model đã chọn không hợp lệ hoặc chưa được phân loại thành "{label}".',
  ),
  'planner.image_batch_running': entry(
    'An image batch is running for this session. Stop it or wait for it to finish.',
    'Đang có batch sinh ảnh chạy cho phiên này. Hãy dừng hoặc đợi xong.',
  ),
  'planner.frames_already_have_images': entry(
    'Every frame already has an image. Enable “Regenerate existing images” to refresh them.',
    'Mọi frame đã có ảnh. Bật “Tạo lại cả ảnh đã có” nếu muốn làm mới.',
  ),
  'planner.ai_storyboard_invalid': entry('The AI did not return valid storyboard data. Please try again.', 'AI không trả về dữ liệu dàn dựng hợp lệ. Hãy thử lại.'),
  'planner.ai_frame_character_unknown': entry('The AI could not determine a character for this frame. Please try again.', 'AI không xác định được nhân vật cho frame này. Hãy thử lại.'),
  'planner.timeline_empty': entry('The timeline has no frames yet. Build the timeline first.', 'Timeline chưa có frame nào. Hãy lên timeline trước.'),
  'planner.timeline_empty_apply': entry('The timeline has no frames to apply.', 'Timeline chưa có frame nào để áp dụng.'),
  'planner.timeline_empty_before_lock': entry(
    'The timeline has no frames yet. Build the timeline before locking it.',
    'Timeline chưa có frame nào. Hãy lên timeline trước khi chốt.',
  ),
  'planner.image_generation_incomplete': entry(
    'The image task has not finished. Wait for it before attaching it to the script.',
    'Tác vụ tạo ảnh chưa hoàn tất. Hãy đợi ảnh xong rồi gắn vào kịch bản.',
  ),
  'planner.batch_image_model_missing': entry('This session has no image model selected.', 'Phiên chưa chọn model ảnh.'),
  'planner.batch_enqueue_failed': entry('Could not queue the image task: {detail}', 'Không xếp được hàng tác vụ ảnh: {detail}'),
  'planner.batch_session_deleted': entry(
    'The session was deleted; the image is still in the Library.',
    'Phiên đã bị xoá; ảnh vẫn nằm trong Thư viện.',
  ),
  'planner.batch_frame_deleted': entry(
    'The frame was removed from the timeline; the image is still in the Library.',
    'Frame đã bị xoá khỏi timeline; ảnh vẫn nằm trong Thư viện.',
  ),
  'planner.batch_attach_failed': entry('Could not attach the image to the frame: {detail}', 'Không gắn được ảnh vào frame: {detail}'),
  'planner.batch_generation_missing_for_frame': entry('There is no image task for this frame.', 'Không có tác vụ ảnh cho frame này.'),
  'planner.batch_generation_gone': entry('The image task no longer exists.', 'Tác vụ ảnh không còn tồn tại.'),
  'planner.batch_generation_failed': entry('The image generation task failed.', 'Tác vụ tạo ảnh thất bại.'),
  'planner.batch_timeout': entry('Image generation took too long. Please try again.', 'Tạo ảnh quá lâu. Hãy thử lại.'),
  'planner.batch_stalled': entry(
    'The image batch stopped because it made no progress. Retry the images.',
    'Batch sinh ảnh đã dừng vì không có tiến triển. Hãy thử lại ảnh.',
  ),
  'providers.credential_not_found': entry('API key not found.', 'Không tìm thấy API key.'),
  'providers.credential_limit': entry('A provider can have at most {max} API keys.', 'Mỗi provider có tối đa {max} API key.'),
  'providers.credential_duplicate': entry('This API key is already saved for this provider.', 'API key này đã được lưu cho provider.'),
  'providers.credential_in_use': entry('This API key is still needed by an active or recoverable task. Disable it for new requests instead.', 'API key vẫn cần cho tác vụ đang chạy hoặc có thể phục hồi. Hãy tắt key cho yêu cầu mới thay vì xoá hoặc thay key.'),
  'providers.credentials_reorder_invalid': entry('Provide every API key ID exactly once in the new order.', 'Thứ tự mới phải chứa mỗi ID API key đúng một lần.'),
  'providers.no_available_credentials': entry('No API key is available. Add, enable or test a key.', 'Không có API key khả dụng. Hãy thêm, bật hoặc kiểm tra key.'),
  'providers.credentials_cooldown': entry('All available keys are temporarily paused. Try again in {retryAfter} seconds.', 'Các key khả dụng đang tạm nghỉ. Thử lại sau {retryAfter} giây.'),
  'providers.credential_decrypt_failed': entry('Unable to decrypt this API key. Replace it or check the server encryption key.', 'Không giải mã được API key. Hãy thay key hoặc kiểm tra khoá mã hoá máy chủ.'),
  'providers.key_auth_failed': entry('This API key was rejected for authentication. Replace it or test it again.', 'API key bị từ chối xác thực. Hãy thay key hoặc kiểm tra lại.'),
  'providers.key_rate_limited': entry('This API key is temporarily rate limited.', 'API key đang bị giới hạn tần suất tạm thời.'),
  'providers.test_rate_limited': entry('Too many connection tests. Please try again later.', 'Quá nhiều lần kiểm tra kết nối. Hãy thử lại sau.'),
  'locations.unknown': entry('The selected location does not exist.', 'Bối cảnh được chọn không tồn tại.'),
  'locations.reference_missing': entry('The selected location has no reference image yet.', 'Bối cảnh được chọn chưa có ảnh tham chiếu.'),
  'locations.reference_not_owned': entry('A location or character reference image no longer exists.', 'Ảnh tham chiếu của bối cảnh hoặc nhân vật không còn tồn tại.'),
  'locations.too_many_references': entry('This frame needs {count} reference images but the model accepts at most {max}.', 'Khung hình cần {count} ảnh tham chiếu nhưng model chỉ nhận tối đa {max}.'),
  'locations.project_mismatch': entry('The location does not belong to this project.', 'Bối cảnh không thuộc dự án này.'),
} as const

export type ErrorMessageKey = keyof typeof ERROR_CATALOG

const PARAM_PATTERN = /\{[a-zA-Z0-9_]+\}/

export function isErrorMessageKey(value: unknown): value is ErrorMessageKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value)
}

export function errorCatalogEntry(key: ErrorMessageKey): ErrorCatalogEntry {
  return ERROR_CATALOG[key]
}

export function errorCatalogKeys(): ErrorMessageKey[] {
  return Object.keys(ERROR_CATALOG) as ErrorMessageKey[]
}

/**
 * Nội suy tham số vào mẫu câu. Tham số thiếu được giữ nguyên dạng `{ten}` để
 * lỗi lập trình lộ ra thay vì âm thầm tạo câu sai.
 */
export function formatErrorMessage(
  key: ErrorMessageKey,
  params?: ErrorMessageParams,
  locale: ErrorMessageLocale = DEFAULT_ERROR_LOCALE,
): string {
  const source = ERROR_CATALOG[key] as ErrorCatalogEntry | undefined
  if (!source) return ''
  const template = source[locale] ?? source.vi
  if (!params) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/** Khoá dự phòng theo `code` cho lỗi chưa có khoá ngữ nghĩa (kể cả dữ liệu cũ). */
export const GENERIC_KEY_BY_CODE: Readonly<Record<string, ErrorMessageKey>> = {
  BAD_REQUEST: 'errors.bad_request',
  UNAUTHORIZED: 'errors.unauthorized',
  FORBIDDEN: 'errors.forbidden',
  NOT_FOUND: 'errors.not_found',
  CONFLICT: 'errors.conflict',
  RATE_LIMITED: 'errors.rate_limited',
  PROVIDER_ERROR: 'errors.provider_error',
  PROVIDER_INCOMPATIBLE: 'errors.provider_incompatible',
  OUTCOME_UNKNOWN: 'errors.outcome_unknown',
  STORAGE_LIMIT: 'errors.storage_limit',
  PAYLOAD_TOO_LARGE: 'errors.payload_too_large',
  INTERNAL_ERROR: 'errors.internal',
  // Mã lỗi được worker lưu vào database.
  PROVIDER_MISSING: 'generations.provider_missing',
  PROVIDER_FAILED: 'generations.provider_failed',
  POLL_TIMEOUT: 'generations.poll_timeout',
  INTERRUPTED: 'generations.interrupted',
  DOWNLOAD_FAILED: 'generations.download_failed',
  EXPORT_FAILED: 'exports.failed',
  FFMPEG_MISSING: 'exports.ffmpeg_missing',
  MEDIA_MISSING: 'exports.media_missing',
}

export const FALLBACK_ERROR_KEY: ErrorMessageKey = 'errors.unknown'

export function genericMessageKeyForCode(code: string | null | undefined): ErrorMessageKey {
  if (!code) return FALLBACK_ERROR_KEY
  return GENERIC_KEY_BY_CODE[code] ?? FALLBACK_ERROR_KEY
}

/**
 * Bảng tra câu tiếng Việt cũ → khoá ngữ nghĩa, chỉ gồm các mẫu KHÔNG có tham số.
 * Nhờ khớp chính xác tuyệt đối, resolver không bao giờ gán nhầm khoá cho thông
 * báo thô của provider.
 */
const LEGACY_MESSAGE_INDEX: Record<string, ErrorMessageKey> = (() => {
  const index: Record<string, ErrorMessageKey> = {}
  for (const key of errorCatalogKeys()) {
    const catalogEntry = ERROR_CATALOG[key] as ErrorCatalogEntry
    if (!PARAM_PATTERN.test(catalogEntry.vi)) index[catalogEntry.vi] = key
  }
  return index
})()

/** Khớp chính xác một câu lỗi do ứng dụng tạo ra với khoá ngữ nghĩa của nó. */
export function messageKeyForLegacyMessage(message: string): ErrorMessageKey | undefined {
  return LEGACY_MESSAGE_INDEX[message]
}

/**
 * Giải khoá cho một lỗi: ưu tiên khoá tường minh, rồi tới khớp mẫu ứng dụng,
 * cuối cùng là dự phòng theo `code`.
 */
export function resolveErrorMessageKey(
  message: string,
  code: string | null | undefined,
  explicit?: ErrorMessageKey,
): ErrorMessageKey {
  if (explicit) return explicit
  return messageKeyForLegacyMessage(message) ?? genericMessageKeyForCode(code)
}
