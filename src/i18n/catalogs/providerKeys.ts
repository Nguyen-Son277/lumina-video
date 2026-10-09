/**
 * Namespace `providerKeys` — quản lý nhiều API key cho một provider.
 *
 * Chỉ chứa câu do ứng dụng sở hữu (nhãn, trạng thái, thông báo). Nội dung do
 * người dùng/provider sinh ra (nhãn key, gợi ý đã che, thông điệp lỗi gốc) giữ
 * nguyên văn và không bao giờ đi qua catalog này.
 *
 * Thông báo (toast) dùng `notification('providerKeys', key, params)` để dịch lại
 * theo ngôn ngữ hiện tại; không truyền chuỗi đã dịch vào tầng thông báo.
 */

export const providerKeysCatalog = {
  // ── Bảng quản lý key ──────────────────────────────────────────────────────
  panelTitle: { en: 'API keys', vi: 'API key' },
  panelDescription: {
    en: 'Keep several keys for this provider and choose how they are used.',
    vi: 'Giữ nhiều key cho provider này và chọn cách dùng chúng.',
  },
  keysAria: { en: 'API keys for {name}', vi: 'API key của {name}' },
  showKeys: { en: 'Show API keys', vi: 'Hiện API key' },
  hideKeys: { en: 'Hide API keys', vi: 'Ẩn API key' },
  keyCount: {
    en: '{count} keys',
    vi: '{count} key',
    enOne: '{count} key',
  },
  loadingKeys: { en: 'Loading keys…', vi: 'Đang tải key…' },

  emptyTitle: { en: 'No API keys yet', vi: 'Chưa có API key' },
  emptyCaption: {
    en: 'Add at least one key so this provider can run.',
    vi: 'Thêm ít nhất một key để provider này hoạt động.',
  },

  // ── Trạng thái từng key ───────────────────────────────────────────────────
  statusOk: { en: 'Working', vi: 'Hoạt động' },
  statusAuthFailed: { en: 'Auth failed', vi: 'Sai xác thực' },
  statusCooldown: { en: 'Cooling down', vi: 'Tạm nghỉ' },
  statusUnknown: { en: 'Not tested', vi: 'Chưa kiểm tra' },
  cooldownRemaining: { en: 'Retry in {seconds}s', vi: 'Thử lại sau {seconds}s' },
  enabledBadge: { en: 'Enabled', vi: 'Đang bật' },
  disabledBadge: { en: 'Disabled', vi: 'Đã tắt' },
  enableKey: { en: 'Enable key', vi: 'Bật key' },
  disableKey: { en: 'Disable key', vi: 'Tắt key' },
  enableKeyAria: { en: 'Enable key {label}', vi: 'Bật key {label}' },
  disableKeyAria: { en: 'Disable key {label}', vi: 'Tắt key {label}' },
  keyRowAria: { en: 'API key {label}', vi: 'API key {label}' },
  untitledKey: { en: 'API key', vi: 'API key' },
  maskedHintPlaceholder: { en: 'Hidden', vi: 'Đã ẩn' },

  // ── Hành động ─────────────────────────────────────────────────────────────
  addKey: { en: 'Add key', vi: 'Thêm key' },
  editKey: { en: 'Edit key', vi: 'Sửa key' },
  editKeyAria: { en: 'Edit key {label}', vi: 'Sửa key {label}' },
  deleteKey: { en: 'Delete key', vi: 'Xoá key' },
  deleteKeyAria: { en: 'Delete key {label}', vi: 'Xoá key {label}' },
  testKey: { en: 'Test key', vi: 'Kiểm tra key' },
  testKeyAria: { en: 'Test key {label}', vi: 'Kiểm tra key {label}' },
  testingKey: { en: 'Testing…', vi: 'Đang kiểm tra…' },
  moveUp: { en: 'Move up', vi: 'Di chuyển lên' },
  moveDown: { en: 'Move down', vi: 'Di chuyển xuống' },
  moveUpAria: { en: 'Move key {label} up', vi: 'Di chuyển key {label} lên' },
  moveDownAria: { en: 'Move key {label} down', vi: 'Di chuyển key {label} xuống' },

  // ── Chế độ chọn key ───────────────────────────────────────────────────────
  modeLabel: { en: 'Key selection', vi: 'Cách chọn key' },
  modeAria: { en: 'Key selection mode for {name}', vi: 'Cách chọn key của {name}' },
  modeFailover: { en: 'Failover', vi: 'Dự phòng' },
  modeRoundRobin: { en: 'Round robin', vi: 'Luân phiên' },
  modeFailoverHint: {
    en: 'Always uses the first working key in the list.',
    vi: 'Luôn dùng key đầu tiên còn hoạt động trong danh sách.',
  },
  modeRoundRobinHint: {
    en: 'Rotates through the keys in order.',
    vi: 'Xoay vòng qua các key theo thứ tự.',
  },

  // ── Hộp thoại thêm/sửa key ────────────────────────────────────────────────
  addKeyTitle: { en: 'Add API key', vi: 'Thêm API key' },
  addKeyDescription: {
    en: 'The key is encrypted with AES-256-GCM and never shown again.',
    vi: 'Key được mã hoá AES-256-GCM và không bao giờ hiển thị lại.',
  },
  editKeyTitle: { en: 'Edit API key', vi: 'Sửa API key' },
  editKeyDescription: {
    en: 'Leave the key field blank to keep the current secret.',
    vi: 'Để trống ô key để giữ bí mật hiện tại.',
  },
  labelField: { en: 'Label', vi: 'Nhãn' },
  labelPlaceholder: { en: 'e.g. Personal key', vi: 'Ví dụ: Key cá nhân' },
  secretField: { en: 'API key', vi: 'API key' },
  secretPlaceholderNew: { en: 'sk-••••••••••••••••', vi: 'sk-••••••••••••••••' },
  secretPlaceholderKeep: {
    en: 'Leave blank to keep the current key',
    vi: 'Để trống để giữ key hiện tại',
  },
  secretNote: {
    en: 'Saved keys are never shown in full.',
    vi: 'Key đã lưu không bao giờ hiển thị đầy đủ.',
  },
  saveKey: { en: 'Save key', vi: 'Lưu key' },
  saveChanges: { en: 'Save changes', vi: 'Lưu thay đổi' },
  cancel: { en: 'Cancel', vi: 'Huỷ' },
  close: { en: 'Close', vi: 'Đóng' },

  // ── Xác nhận xoá ──────────────────────────────────────────────────────────
  deleteConfirmTitle: { en: 'Delete this key?', vi: 'Xoá key này?' },
  deleteConfirmBody: {
    en: 'Tasks that still need this key may fail. This cannot be undone.',
    vi: 'Tác vụ còn cần key này có thể thất bại. Không thể hoàn tác.',
  },
  confirmDelete: { en: 'Delete key', vi: 'Xoá key' },

  // ── Giới hạn ──────────────────────────────────────────────────────────────
  limitReached: {
    en: 'A provider can have at most {max} API keys.',
    vi: 'Mỗi provider có tối đa {max} API key.',
  },

  // ── Sửa provider ──────────────────────────────────────────────────────────
  editProvider: { en: 'Edit provider', vi: 'Sửa provider' },
  editProviderAria: { en: 'Edit provider {name}', vi: 'Sửa provider {name}' },
  editProviderTitle: { en: 'Edit provider', vi: 'Sửa provider' },
  editProviderDescription: {
    en: 'Update the display name, Base URL or image API style.',
    vi: 'Cập nhật tên hiển thị, Base URL hoặc kiểu API ảnh.',
  },
  providerNameField: { en: 'Display name', vi: 'Tên hiển thị' },
  baseUrlField: { en: 'Base URL', vi: 'Base URL' },
  imageApiStyleField: { en: 'Image API', vi: 'API ảnh' },
  providerNameRequired: { en: 'Display name is required.', vi: 'Cần nhập tên hiển thị.' },

  // ── Thông báo (descriptor) ────────────────────────────────────────────────
  notifyKeyAdded: { en: 'API key added.', vi: 'Đã thêm API key.' },
  notifyKeyUpdated: { en: 'API key updated.', vi: 'Đã cập nhật API key.' },
  notifyKeyRemoved: { en: 'API key deleted.', vi: 'Đã xoá API key.' },
  notifyKeyReordered: { en: 'Key order updated.', vi: 'Đã cập nhật thứ tự key.' },
  notifyModeChanged: { en: 'Key selection mode updated.', vi: 'Đã cập nhật cách chọn key.' },
  notifyProviderUpdated: { en: 'Provider updated.', vi: 'Đã cập nhật provider.' },
  notifyKeyTestOk: { en: 'This key works.', vi: 'Key này hoạt động.' },
  notifyKeyTestFailed: { en: 'This key failed the check.', vi: 'Key này kiểm tra thất bại.' },
} as const

export type ProviderKeysCatalog = typeof providerKeysCatalog
