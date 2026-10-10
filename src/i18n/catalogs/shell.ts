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
  navQuick: { en: 'Quick create', vi: 'Tạo nội dung đơn lẻ' },
  navStudio: { en: 'Studio', vi: 'Studio' },
  navCharacters: { en: 'Characters', vi: 'Nhân vật' },
  navLibrary: { en: 'Library', vi: 'Thư viện' },
  navPlanner: { en: 'AI script planner', vi: 'Tạo kịch bản AI' },
  navTimeline: { en: 'Timeline', vi: 'Timeline' },
  navApiModels: { en: 'API & Models', vi: 'API & Models' },
  navCollections: { en: 'Collections', vi: 'Bộ sưu tập' },
  navUsage: { en: 'Usage', vi: 'Sử dụng' },
  planApiKeyTitle: { en: 'Your API key', vi: 'API key của bạn' },
  planApiKeyCaption: {
    en: 'Your key is encrypted and only used to call providers.',
    vi: 'Key được mã hóa và chỉ dùng để gọi provider.',
  },
  signedIn: { en: 'Signed in', vi: 'Đã đăng nhập' },
  logout: { en: 'Sign out', vi: 'Đăng xuất' },
  openMenu: { en: 'Open menu', vi: 'Mở menu' },
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
  emailLabel: { en: 'Email', vi: 'Email' },
  emailPlaceholder: { en: 'you@example.com', vi: 'ban@example.com' },
  passwordLabel: { en: 'Password', vi: 'Mật khẩu' },
  passwordPlaceholder: { en: 'Enter your password', vi: 'Nhập mật khẩu' },
  passwordMinPlaceholder: { en: 'At least 10 characters', vi: 'Ít nhất 10 ký tự' },
  authRegisterHint: {
    en: 'Registration is limited to @gigone.com emails. Passwords need at least 10 characters.',
    vi: 'Chỉ đăng ký bằng email @gigone.com. Mật khẩu cần ít nhất 10 ký tự.',
  },
  authApprovalHint: {
    en: 'New accounts need an administrator to approve them before you can sign in.',
    vi: 'Tài khoản mới cần quản trị viên duyệt trước khi đăng nhập.',
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
  toastGenerationRemoved: { en: 'Removed from the library.', vi: 'Đã xóa khỏi thư viện.' },
  toastRetryingDownload: {
    en: 'Retrying the result download from the provider.',
    vi: 'Đang thử tải lại kết quả từ provider.',
  },

  // ── Nhãn trạng thái tác vụ ─────────────────────────────────────────────────
  statusQueued: { en: 'Queued', vi: 'Đang chờ' },
  statusRunning: { en: 'Processing', vi: 'Đang xử lý' },
  statusDownloading: { en: 'Downloading result', vi: 'Đang tải kết quả' },
  statusSucceeded: { en: 'Completed', vi: 'Hoàn tất' },
  statusFailed: { en: 'Failed', vi: 'Thất bại' },
  statusUnknown: { en: 'Unknown', vi: 'Chưa xác định' },

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
