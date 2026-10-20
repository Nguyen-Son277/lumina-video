/**
 * Catalog namespace `shell` — toàn bộ chuỗi UI thuộc lớp vỏ ứng dụng:
 * App (khởi động, tải trang, toast), Sidebar/Topbar, AuthPage, Common
 * (Toast, thẻ kết quả, nhãn trạng thái) và Lightbox, SettingsPage.
 *
 * Quy ước:
 * - Mọi khoá đều có đủ `en` (mặc định) và `vi`.
 * - Khoá ngữ nghĩa theo màn hình/thành phần; tham số nội suy ghi trong `{tên}`.
 * - KHÔNG chứa nội dung do người dùng/AI/provider sinh ra, giá trị enum API,
 *   ID, URL hay prompt — những thứ đó luôn hiển thị nguyên văn.
 */

import type { Catalog } from '../types'

export const shellCatalog = {
  cardImagePurpose: { en: 'Library destination: {name}', vi: 'Đối tượng thư viện: {name}' },
  cardLibraryQueued: { en: 'Waiting to save final outputs to the library…', vi: 'Đang chờ lưu ảnh hoàn chỉnh vào thư viện…' },
  cardLibraryPublished: { en: 'Final outputs saved to the identity library.', vi: 'Đã lưu ảnh hoàn chỉnh vào thư viện đối tượng.' },
  cardLibraryFailed: { en: 'Could not save outputs to the library. Provider results are preserved.', vi: 'Chưa lưu được ảnh vào thư viện. Kết quả provider vẫn được giữ.' },
  cardRetryLibrary: { en: 'Retry library save · no provider call', vi: 'Thử lưu thư viện lại · không gọi provider' },
  toastProviderSavedRefreshFailed: { en: 'Provider saved. Could not refresh the model list; reload the page to try again.', vi: 'Provider đã lưu. Chưa tải lại được danh sách model; hãy tải lại trang để thử lại.' },
  providerProtocol: { en: 'Provider protocol', vi: 'Giao thức nhà cung cấp' },
  protocolCompat: { en: '[OI] / Agnes', vi: '[OI] / Agnes' },
  protocolHiggsfield: { en: 'Higgsfield · Seedance 2.5', vi: 'Higgsfield · Seedance 2.5' },
  hfCredentialPlaceholder: { en: 'KEY_ID:KEY_SECRET', vi: 'KEY_ID:KEY_SECRET' },
  hfCredential: { en: 'Higgsfield API credential', vi: 'Khóa API Higgsfield' },
  hfCredentialFormat: { en: 'Paste the complete KEY_ID:KEY_SECRET value, with one colon and no internal whitespace.', vi: 'Dán nguyên chuỗi KEY_ID:KEY_SECRET, gồm một dấu hai chấm và không có khoảng trắng bên trong.' },
  hfCredentialHint: { en: 'Credentials stay encrypted on the backend. Seedance 2.5 is added automatically; no paid test is sent.', vi: 'Thông tin xác thực được mã hóa ở backend. Seedance 2.5 được thêm tự động; không gửi tác vụ kiểm tra trả phí.' },
  stopQueuedVideo: { en: 'Stop', vi: 'Dừng' },
  stoppingQueuedVideo: { en: 'Stopping…', vi: 'Đang dừng…' },
  stopQueuedVideoHint: { en: 'Stop this video while it is waiting in the queue', vi: 'Dừng tạo video đang chờ trong hàng đợi' },
  statusCancelled: { en: 'Stopped', vi: 'Đã dừng' },
  secretShow: { en: 'Show', vi: 'Hiện' },
  secretHide: { en: 'Hide', vi: 'Ẩn' },
  showPassword: { en: 'Show password', vi: 'Hiện mật khẩu' },
  hidePassword: { en: 'Hide password', vi: 'Ẩn mật khẩu' },
  showApiKey: { en: 'Show API key', vi: 'Hiện API key' },
  hideApiKey: { en: 'Hide API key', vi: 'Ẩn API key' },
  // ── Thương hiệu ────────────────────────────────────────────────────────────
  brandCaption: { en: 'CREATIVE WORKSPACE', vi: 'CREATIVE WORKSPACE' },

  // ── Sidebar / Topbar ───────────────────────────────────────────────────────
  sidebarExpand: { en: 'Expand menu', vi: 'Mở rộng menu' },
  sidebarCollapse: { en: 'Collapse menu', vi: 'Thu gọn menu' },
  workspacePersonal: { en: 'Personal workspace', vi: 'Workspace cá nhân' },
  workspacePersonalCaption: {
    en: 'Your own private account',
    vi: 'Tài khoản riêng của bạn',
  },
  navSectionWorkspace: { en: 'Workspace', vi: 'Workspace' },
  navSectionManage: { en: 'Manage', vi: 'Quản lý' },
  navDocs: { en: 'Docs', vi: 'Hướng dẫn' },
  loadingDocs: { en: 'Loading documentation…', vi: 'Đang tải hướng dẫn…' },
  navQuick: { en: 'Quick create', vi: 'Tạo nội dung đơn lẻ' },
  navStudio: { en: 'Studio', vi: 'Studio' },
  navCharacters: { en: 'Characters', vi: 'Nhân vật' },
  navEntities: { en: 'Characters & resources', vi: 'Nhân vật & tài nguyên' },
  loadingEntities: { en: 'Loading identity library…', vi: 'Đang tải thư viện đối tượng…' },
  navLibrary: { en: 'Library', vi: 'Thư viện' },
  navPlanner: { en: 'AI script planner', vi: 'Tạo kịch bản AI' },
  navTimeline: { en: 'Timeline', vi: 'Timeline' },
  navApiModels: { en: 'API & Models', vi: 'API & Models' },
  navCollections: { en: 'Collections', vi: 'Bộ sưu tập' },
  navUsage: { en: 'Usage', vi: 'Sử dụng' },
  navTrash: { en: 'Trash', vi: 'Thùng rác' },
  planApiKeyTitle: { en: 'Your API key', vi: 'API key của bạn' },
  planApiKeyCaption: {
    en: 'Your key is encrypted and only used to call providers.',
    vi: 'Key được mã hóa và chỉ dùng để gọi provider.',
  },
  signedIn: { en: 'Signed in', vi: 'Đã đăng nhập' },
  logout: { en: 'Sign out', vi: 'Đăng xuất' },
  openMenu: { en: 'Open menu', vi: 'Mở menu' },
  closeMenu: { en: 'Close menu', vi: 'Đóng menu' },
  help: { en: 'Help', vi: 'Trợ giúp' },
  helpMessage: {
    en: 'Every action uses your own API key.',
    vi: 'Mọi thao tác đều dùng API key của bạn.',
  },

  // ── Đăng nhập / Đăng ký ────────────────────────────────────────────────────
  authLoginTitle: { en: 'Sign in to continue', vi: 'Đăng nhập để tiếp tục' },
  authRegisterTitle: { en: 'Create a new account', vi: 'Tạo tài khoản mới' },
  authSubtitle: {
    en: 'Each account has its own providers, models and library. Your API key is encrypted and never shown again.',
    vi: 'Mỗi tài khoản có provider, model và thư viện riêng. API key của bạn được mã hóa và không hiển thị lại.',
  },
  authNameLabel: { en: 'Name', vi: 'Tên' },
  authNamePlaceholder: { en: 'Your name', vi: 'Tên của bạn' },
  authNameError: {
    en: 'Enter a name from 1 to 100 characters without control characters.',
    vi: 'Vui lòng nhập tên từ 1 đến 100 ký tự và không chứa ký tự điều khiển.',
  },
  emailLabel: { en: 'Email', vi: 'Email' },
  emailPlaceholder: { en: 'you@example.com', vi: 'ban@example.com' },
  passwordLabel: { en: 'Password', vi: 'Mật khẩu' },
  passwordPlaceholder: { en: 'Enter your password', vi: 'Nhập mật khẩu' },
  passwordMinPlaceholder: { en: 'At least 10 characters', vi: 'Ít nhất 10 ký tự' },
  navAccountSettings: { en: 'Settings', vi: 'Cài đặt' },
  navAdminAccounts: { en: 'Account approval', vi: 'Duyệt tài khoản' },
  navAdminUsage: { en: 'System usage', vi: 'Nhật ký sử dụng' },
  authRegisterHint: {
    en: 'Use an @gigone.com email or a configured administrator email. Passwords need at least 10 characters.',
    vi: 'Dùng email @gigone.com hoặc email quản trị đã cấu hình. Mật khẩu cần ít nhất 10 ký tự.',
  },
  authApprovalHint: {
    en: 'New users need approval. For initial setup, register the configured administrator email to set its password and receive automatic approval. Already registered? Sign in instead.',
    vi: 'User mới cần được duyệt. Khi thiết lập lần đầu, đăng ký đúng email admin đã cấu hình để đặt mật khẩu và được tự động duyệt. Đã đăng ký? Hãy đăng nhập.',
  },
  authPendingTitle: { en: 'Account created', vi: 'Đã tạo tài khoản' },
  authPendingBody: {
    en: 'Your account is waiting for an administrator to approve it. Please sign in again once it has been approved.',
    vi: 'Tài khoản của bạn đang chờ quản trị viên duyệt. Hãy đăng nhập lại sau khi được duyệt.',
  },
  authPendingBack: { en: 'Back to sign in', vi: 'Quay lại đăng nhập' },
  authDomainError: {
    en: 'Only emails in the @gigone.com domain can register.',
    vi: 'Chỉ email thuộc tên miền @gigone.com mới được đăng ký.',
  },
  authBusy: { en: 'Processing...', vi: 'Đang xử lý...' },
  authLoginAction: { en: 'Sign in', vi: 'Đăng nhập' },
  authRegisterAction: { en: 'Create account', vi: 'Tạo tài khoản' },
  authNoAccount: { en: "Don't have an account?", vi: 'Chưa có tài khoản?' },
  authHaveAccount: { en: 'Already have an account?', vi: 'Đã có tài khoản?' },
  authRegisterNow: { en: 'Sign up now', vi: 'Đăng ký ngay' },

  // ── App: khởi động, tải trang, toast ───────────────────────────────────────
  bootCheckingSession: {
    en: 'Checking your session...',
    vi: 'Đang kiểm tra phiên đăng nhập...',
  },
  loadingProjectStudio: { en: 'Loading project studio…', vi: 'Đang tải Studio dự án…' },
  loadingCharacters: { en: 'Loading character library…', vi: 'Đang tải thư viện nhân vật…' },
  loadingPlanner: { en: 'Loading AI script planner…', vi: 'Đang tải Tạo kịch bản AI…' },
  loadingTimeline: { en: 'Loading timeline…', vi: 'Đang tải Timeline…' },
  loadingTrash: { en: 'Loading trash…', vi: 'Đang tải thùng rác…' },
  toastProviderAdded: {
    en: 'Provider added. Press Sync or add models manually.',
    vi: 'Đã thêm provider. Hãy bấm Đồng bộ hoặc thêm model thủ công.',
  },
  toastModelAdded: { en: 'Model added.', vi: 'Đã thêm model.' },
  toastImageStyleExtraBody: {
    en: 'Switched to source images in extra_body (Agnes).',
    vi: 'Đã đổi sang kiểu ảnh nguồn trong extra_body (Agnes).',
  },
  toastImageStyleOpenai: {
    en: 'Switched to the standard OpenAI image API.',
    vi: 'Đã đổi sang kiểu API ảnh chuẩn OpenAI.',
  },
  toastVideoRefStyleUpdated: {
    en: 'Video reference image format updated.',
    vi: 'Đã cập nhật kiểu gửi ảnh tham chiếu video.',
  },
  toastProviderRemoved: {
    en: 'Provider and its models were deleted.',
    vi: 'Đã xóa provider và các model liên quan.',
  },
  toastModelRemoved: { en: 'Model deleted.', vi: 'Đã xóa model.' },
  toastModelUpdated: { en: 'Model category updated.', vi: 'Đã cập nhật phân loại model.' },
  toastProviderConnected: {
    en: 'Connection succeeded. The provider has {count} models.',
    vi: 'Kết nối thành công. Provider có {count} model.',
  },
  toastSyncDone: {
    en: 'Sync complete: {added} new models added, {skipped} existing models skipped.',
    vi: 'Đồng bộ xong: thêm {added} model mới, bỏ qua {skipped} model đã có.',
  },
  toastGenerationRemoved: { en: 'Result moved to trash. You can restore it within 30 days.', vi: 'Đã chuyển kết quả vào thùng rác. Bạn có thể khôi phục trong 30 ngày.' },
  confirmTrashUnknownVideo: {
    en: 'Move this unresolved video to trash? No video_id was received, so the app cannot track this request. This only hides the local record; it does not cancel the provider request or refund charges. The provider may still be processing it. Check the provider history before creating another video.',
    vi: 'Chuyển video chưa rõ kết quả vào Thùng rác? Ứng dụng chưa nhận được video_id nên không thể theo dõi yêu cầu này. Thao tác này chỉ ẩn bản ghi cục bộ, không hủy yêu cầu ở provider và không hoàn phí. Provider có thể vẫn đang xử lý. Hãy kiểm tra lịch sử provider trước khi tạo video mới.',
  },
  confirmTrashUnknownImage: {
    en: 'This image request has an unknown status and no provider job ID. Moving it to trash only hides the local record; it does not cancel the provider request or refund any charges, and cannot guarantee whether the provider is still processing it or will produce a result. Check the provider history before submitting again. Move this local record to trash?',
    vi: 'Yêu cầu tạo ảnh này có trạng thái chưa xác định và không có mã tác vụ của provider. Chuyển vào thùng rác chỉ ẩn bản ghi cục bộ; không hủy yêu cầu ở provider, không hoàn phí và không thể bảo đảm provider còn đang xử lý hay sẽ tạo ra kết quả. Hãy kiểm tra lịch sử trên provider trước khi gửi lại. Chuyển bản ghi cục bộ này vào thùng rác?',
  },
  toastRetryingDownload: {
    en: 'Retrying the result download from the provider.',
    vi: 'Đang thử tải lại kết quả từ provider.',
  },

  // ── Nhãn trạng thái tác vụ ─────────────────────────────────────────────────
  generationProgressAria: { en: 'Generation progress', vi: 'Tiến trình tạo nội dung' },
  statusQueued: { en: 'Queued', vi: 'Đang chờ' },
  statusRunning: { en: 'Processing', vi: 'Đang xử lý' },
  statusDownloading: { en: 'Downloading result', vi: 'Đang tải kết quả' },
  statusSucceeded: { en: 'Completed', vi: 'Hoàn tất' },
  statusFailed: { en: 'Failed', vi: 'Thất bại' },
  statusUnknown: { en: 'Unknown', vi: 'Chưa xác định' },
  unknownVideoNoIdHint: { en: 'No video_id was received, so this task cannot be polled or downloaded yet. You can move this local record to trash; this does not cancel the provider request or refund charges. Check your task history on the provider before creating another video.', vi: 'Chưa nhận được video_id nên chưa thể theo dõi hoặc tải tác vụ này. Bạn có thể chuyển bản ghi này vào Thùng rác; thao tác này không hủy yêu cầu ở provider và không hoàn phí. Kiểm tra lịch sử tác vụ trên provider trước khi tạo video khác.' },
  providerRequestId: { en: 'Provider request ID: {id}', vi: 'Request ID của provider: {id}' },

  // ── Thẻ kết quả (CreationCard) ─────────────────────────────────────────────
  untitled: { en: 'Untitled', vi: 'Chưa đặt tên' },
  mediaKindVideo: { en: 'VIDEO', vi: 'VIDEO' },
  mediaKindImage: { en: 'IMAGE', vi: 'ẢNH' },
  zoomImageAria: { en: 'Zoom image: {title}', vi: 'Phóng to ảnh: {title}' },
  zoomImageTitle: { en: 'Click to view details', vi: 'Bấm để xem chi tiết' },
  download: { en: 'Download', vi: 'Tải xuống' },
  retryDownload: { en: 'Retry result', vi: 'Tải lại kết quả' },
  deleteResult: { en: 'Delete result', vi: 'Xóa kết quả' },
  inProject: { en: 'In project', vi: 'Trong project' },
  notInProject: { en: 'Not in a project', vi: 'Chưa thuộc project' },
  promptSent: { en: 'Sent prompt', vi: 'Prompt đã gửi' },
  cardEditPrompt: { en: 'Edit description', vi: 'Sửa mô tả' },
  cardUseAsSource: { en: 'Use as source image', vi: 'Dùng làm ảnh nguồn' },
  cardOriginal: { en: 'Original', vi: 'Bản gốc' },
  cardLogoOverlay: { en: 'Logo-composited', vi: 'Bản ghép logo' },
  cardOverlayQueued: { en: 'Logo compositing queued', vi: 'Đang chờ ghép logo' },
  cardOverlayRunning: { en: 'Compositing logo locally…', vi: 'Đang ghép logo trên máy chủ…' },
  cardOverlayProgressAria: { en: 'Local logo compositing progress', vi: 'Tiến trình ghép logo trên máy chủ' },
  cardOverlayFailed: {
    en: 'Logo compositing failed. The original is still available. Check the logo, ffmpeg and storage, then retry.',
    vi: 'Ghép logo thất bại. Bản gốc vẫn được giữ. Kiểm tra logo, ffmpeg và dung lượng rồi thử lại.',
  },
  cardRetryOverlay: { en: 'Retry logo compositing', vi: 'Thử ghép logo lại' },
  cardRetryOverlayBusy: { en: 'Requesting local retry…', vi: 'Đang yêu cầu ghép lại…' },
  cardRetryOverlayHint: { en: 'Uses the saved original; does not call the provider or generate again.', vi: 'Dùng bản gốc đã lưu; không gọi provider hoặc tạo nội dung lại.' },
  cardOverlayPollFailed: { en: 'Could not refresh logo compositing progress. Retrying automatically.', vi: 'Chưa tải được tiến trình ghép logo. Hệ thống sẽ tự thử theo dõi lại.' },

  // ── Lightbox ───────────────────────────────────────────────────────────────
  lightboxViewImage: { en: 'View image: {title}', vi: 'Xem ảnh: {title}' },
  zoomOut: { en: 'Zoom out', vi: 'Thu nhỏ' },
  zoomOutTitle: { en: 'Zoom out (−)', vi: 'Thu nhỏ (−)' },
  zoomIn: { en: 'Zoom in', vi: 'Phóng to' },
  zoomInTitle: { en: 'Zoom in (+)', vi: 'Phóng to (+)' },
  zoomFit: { en: 'Fit to frame', vi: 'Về kích thước vừa khung' },
  zoomFitTitle: { en: 'Fit (0)', vi: 'Vừa khung (0)' },
  close: { en: 'Close', vi: 'Đóng' },
  closeTitle: { en: 'Close (Esc)', vi: 'Đóng (Esc)' },
  lightboxHint: {
    en: 'Scroll or use +/− to zoom · drag to pan when zoomed in · double-click to zoom 2×',
    vi: 'Lăn chuột hoặc nút +/− để thu phóng · kéo để di chuyển khi đã phóng to · nháy đúp để phóng 2×',
  },

  // ── Settings: phân loại model ──────────────────────────────────────────────
  modelKindImage: { en: 'Image generation', vi: 'Tạo ảnh' },
  modelKindVideo: { en: 'Video generation', vi: 'Tạo video' },
  modelKindLlm: { en: 'LLM & Chat', vi: 'LLM & Chat' },
  modelKindUnclassified: { en: 'Unclassified', vi: 'Chưa phân loại' },

  // ── Settings: modal provider ───────────────────────────────────────────────
  providerModalEyebrow: { en: 'New connection', vi: 'Kết nối mới' },
  addProvider: { en: 'Add provider', vi: 'Thêm provider' },
  providerModalDescription: {
    en: 'Connect an OpenAI-compatible endpoint with a Base URL and API key.',
    vi: 'Kết nối một endpoint tương thích OpenAI bằng Base URL và API key.',
  },
  displayNameLabel: { en: 'Display name', vi: 'Tên hiển thị' },
  providerNamePlaceholder: { en: 'e.g. Production gateway', vi: 'Ví dụ: Production gateway' },
  baseUrlLabel: { en: 'Base URL', vi: 'Base URL' },
  imageApiStyleLabel: { en: 'Image API style', vi: 'Kiểu API tạo ảnh' },
  imageStyleOpenaiFull: {
    en: 'OpenAI standard · /images/generations and /images/edits',
    vi: 'Chuẩn OpenAI · /images/generations và /images/edits',
  },
  imageStyleExtraBodyFull: {
    en: 'Source image in extra_body · Agnes and similar gateways',
    vi: 'Ảnh nguồn trong extra_body · Agnes và gateway tương tự',
  },
  apiKeyLabel: { en: 'API key', vi: 'API key' },
  keyEncryptionWarning: {
    en: 'The key is encrypted with AES-256-GCM and never shown again.',
    vi: 'Key được mã hóa AES-256-GCM và không bao giờ hiển thị lại.',
  },
  cancel: { en: 'Cancel', vi: 'Hủy' },
  saveProvider: { en: 'Save provider', vi: 'Lưu provider' },

  // ── Settings: modal model ──────────────────────────────────────────────────
  noProviderTitle: { en: 'No providers yet', vi: 'Chưa có provider' },
  noProviderDescription: {
    en: 'Add a provider before adding a model.',
    vi: 'Bạn cần thêm provider trước khi thêm model.',
  },
  modelEyebrow: { en: 'Model', vi: 'Model' },
  addModel: { en: 'Add model', vi: 'Thêm model' },
  modelModalDescription: {
    en: 'Enter the exact model ID required by the provider, then pick a content type.',
    vi: 'Nhập đúng model ID mà provider yêu cầu, sau đó chọn loại nội dung.',
  },
  providerLabel: { en: 'Provider', vi: 'Provider' },
  modelIdLabel: { en: 'Model ID', vi: 'Model ID' },
  modelIdPlaceholder: { en: 'e.g. gpt-image-1', vi: 'Ví dụ: gpt-image-1' },
  displayNameOptionalLabel: { en: 'Display name (optional)', vi: 'Tên hiển thị (tùy chọn)' },
  displayNamePlaceholder: { en: 'e.g. GPT Image 1', vi: 'Ví dụ: GPT Image 1' },
  saveModel: { en: 'Save model', vi: 'Lưu model' },

  // ── Settings: trang chính ──────────────────────────────────────────────────
  settingsEyebrow: { en: 'Configuration', vi: 'Cấu hình' },
  settingsTitleLead: { en: 'Your ', vi: 'API ' },
  settingsTitleAccent: { en: 'API.', vi: 'của bạn.' },
  settingsDescription: {
    en: 'Add a provider (Base URL + API key), then classify each model: image, video or LLM & Chat.',
    vi: 'Thêm provider (Base URL + API key), sau đó phân loại từng model: ảnh, video hay LLM & Chat.',
  },
  tabProviders: { en: 'Providers', vi: 'Providers' },
  tabModelCatalog: { en: 'Model catalog', vi: 'Model catalog' },
  noticeKeyEncryptedTitle: {
    en: 'API keys are encrypted with AES-256-GCM',
    vi: 'API key được mã hóa AES-256-GCM',
  },
  noticeKeyEncryptedCaption: {
    en: 'Keys are only decrypted server-side when calling a provider and are never returned to the browser.',
    vi: 'Key chỉ được giải mã ở phía máy chủ khi gọi provider và không bao giờ trả về trình duyệt.',
  },
  providerConnected: { en: 'Connected', vi: 'Đã kết nối' },
  providerError: { en: 'Connection error', vi: 'Lỗi kết nối' },
  providerUnchecked: { en: 'Not tested', vi: 'Chưa kiểm tra' },
  modelsCountLabel: { en: 'models', vi: 'model' },
  imageApiColumnLabel: { en: 'Image API', vi: 'API ảnh' },
  imageApiStyleAria: {
    en: 'Image API style for {name}',
    vi: 'Kiểu API ảnh của {name}',
  },
  imageStyleOpenaiShort: { en: 'OpenAI standard', vi: 'Chuẩn OpenAI' },
  imageStyleExtraBodyShort: { en: 'extra_body (Agnes)', vi: 'extra_body (Agnes)' },
  videoRefColumnLabel: { en: 'Video reference', vi: 'Ảnh tham chiếu video' },
  videoRefStyleAria: {
    en: 'Video reference image format for {name}',
    vi: 'Kiểu gửi ảnh tham chiếu video của {name}',
  },
  videoRefLabel: { en: 'Video reference image', vi: 'Kiểu gửi ảnh tham chiếu video' },
  videoRefObjectFull: {
    en: 'Object { image_url } — OpenAI / Sora',
    vi: 'Object { image_url } — OpenAI / Sora',
  },
  videoRefStringFull: {
    en: 'Plain string — new-api gateways (e.g. NexusMMO)',
    vi: 'Chuỗi thuần — gateway new-api (ví dụ NexusMMO)',
  },
  videoRefObjectShort: { en: 'Object { image_url }', vi: 'Object { image_url }' },
  videoRefStringShort: { en: 'Plain string', vi: 'Chuỗi thuần' },
  videoRefHint: {
    en: 'Choose "Plain string" when your gateway rejects requests with the message "Video request failed".',
    vi: 'Chọn "Chuỗi thuần" nếu gateway của bạn báo lỗi "Video request failed".',
  },
  syncModelsTitle: { en: 'Fetch the model list', vi: 'Lấy danh sách model' },
  sync: { en: 'Sync', vi: 'Đồng bộ' },
  test: { en: 'Test', vi: 'Kiểm tra' },
  removeProvider: { en: 'Delete provider', vi: 'Xóa provider' },
  providersEmptyTitle: { en: 'No providers yet', vi: 'Danh sách provider đang trống' },
  providersEmptyCaption: {
    en: 'Add your first connection with a Base URL and API key to get started.',
    vi: 'Thêm kết nối đầu tiên bằng Base URL và API key để bắt đầu.',
  },
  catalogNote: {
    en: 'Classify models by what the provider actually supports. Unclassified models will not appear in Studio.',
    vi: 'Phân loại model theo khả năng thật của provider. Model chưa phân loại sẽ không xuất hiện trong Studio.',
  },
  classifyModelAria: { en: 'Category of {name}', vi: 'Phân loại {name}' },
  removeModelAria: { en: 'Delete {name}', vi: 'Xóa {name}' },

  // ── Đơn giá model (nhập ngay trong Model catalog) ───────────────────────────
  modelImageSize: { en: 'Image size', vi: 'Kích thước ảnh' },
  modelImageSizeDefault: { en: 'Provider default', vi: 'Mặc định của provider' },
  modelImageReferences: { en: 'Reference images', vi: 'Ảnh tham chiếu' },
  modelImageReferenceUnknown: { en: 'Unknown (allow)', vi: 'Chưa rõ (cho phép)' },
  modelImageReferenceYes: { en: 'Supported', vi: 'Có hỗ trợ' },
  modelImageReferenceNo: { en: 'Not supported', vi: 'Không hỗ trợ' },
  modelImageReferenceTransport: { en: 'Reference image transport', vi: 'Cách gửi ảnh tham chiếu' },
  modelImageReferenceProviderDefault: { en: 'Provider default', vi: 'Mặc định của provider' },
  modelImageReferenceGenerationsImages: { en: 'generations/images endpoint', vi: 'Endpoint generations/images' },
  modelImageMaxReferences: { en: 'Maximum reference images', vi: 'Số ảnh tham chiếu tối đa' },
  modelImageMaxReferencesDefault: { en: 'Provider default (1–16)', vi: 'Mặc định provider (1–16)' },
  modelImageMaxReferencesRange: { en: 'Enter a whole number from 1 to 16.', vi: 'Nhập số nguyên từ 1 đến 16.' },
  modelPriceOpen: { en: 'Unit price', vi: 'Đơn giá' },
  modelPriceOpenAria: { en: 'Unit price of {name}', vi: 'Đơn giá của {name}' },
  modelPriceTitle: { en: 'Unit price of {name}', vi: 'Đơn giá của {name}' },
  modelPriceNotSet: { en: 'No unit price yet', vi: 'Chưa đặt đơn giá' },
  modelPriceSummaryInput: { en: 'In {price} / 1K', vi: 'Vào {price} / 1K' },
  modelPriceSummaryOutput: { en: 'Out {price} / 1K', vi: 'Ra {price} / 1K' },
  modelPriceSummaryUnit: { en: '{price} / call', vi: '{price} / lượt' },
  modelPriceInput: { en: 'Input / 1K tokens', vi: 'Vào / 1K token' },
  modelPriceOutput: { en: 'Output / 1K tokens', vi: 'Ra / 1K token' },
  modelPriceUnit: { en: 'Price per call', vi: 'Giá mỗi lượt' },
  modelPriceCurrency: { en: 'Currency', vi: 'Tiền tệ' },
  modelPriceSave: { en: 'Save price', vi: 'Lưu đơn giá' },
  modelPriceSaving: { en: 'Saving…', vi: 'Đang lưu…' },
  modelPriceSaved: { en: 'Saved', vi: 'Đã lưu' },
  modelPriceSaveFailed: { en: 'Could not save the unit price.', vi: 'Không lưu được đơn giá.' },
  modelPriceInvalid: {
    en: 'Price must be a number greater than or equal to 0. Leave it empty to clear the price.',
    vi: 'Đơn giá phải là số lớn hơn hoặc bằng 0. Để trống nếu muốn xoá đơn giá.',
  },
  modelPriceClearHint: { en: 'Empty clears the price', vi: 'Để trống là xoá đơn giá' },
  modelPriceClose: { en: 'Close', vi: 'Đóng' },
  modelPriceNote: {
    en: 'Providers do not return prices, so enter your own unit price here to estimate cost: image and video models per call, chat models per 1K tokens.',
    vi: 'Provider không trả giá, nên bạn tự nhập đơn giá ở đây để ước tính chi phí: model ảnh/video theo lượt, model chat theo 1K token.',
  },
  delete: { en: 'Delete', vi: 'Xóa' },
  modelsEmptyTitle: { en: 'No models yet', vi: 'Chưa có model nào' },
  modelsEmptyCaption: {
    en: 'Add a provider and press Sync, or add a model manually.',
    vi: 'Thêm provider rồi bấm Đồng bộ, hoặc thêm model thủ công.',
  },
} as const satisfies Catalog

export type ShellCatalog = typeof shellCatalog
export type ShellCatalogKey = keyof ShellCatalog
