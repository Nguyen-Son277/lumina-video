/**
 * Catalog namespace `usage` — toàn bộ chuỗi giao diện do ứng dụng sở hữu thuộc
 * khu vực Nhật ký sử dụng:
 *
 *   - `src/pages/UsagePage.tsx`
 *   - `src/components/AdminUsagePanel.tsx`
 *
 * Quy ước:
 *   - Mỗi khoá là NGỮ NGHĨA, có đủ `en` (mặc định) và `vi`.
 *   - KHÔNG chứa nội dung do người dùng/AI/provider sinh ra, prompt, giá trị enum
 *     API (`planner_chat`, `succeeded`…) hay định danh — những thứ đó giữ nguyên.
 *   - Khoá có tham số nội suy ghi trong `{tên}` và hai bản dịch phải trùng placeholder.
 */

import type { Catalog } from '../types'

export const usageCatalog = {
  // ── Tiêu đề trang, tab, trạng thái chung ───────────────────────────────────
  pageEyebrow: { en: 'Usage log', vi: 'Nhật ký sử dụng' },
  pageTitleLead: { en: 'Usage ', vi: 'Nhật ký ' },
  pageTitleAccent: { en: 'report.', vi: 'sử dụng.' },
  pageIntro: {
    en: 'Every image, video and LLM call with status, tokens and estimated cost. Enter model prices below so the estimates are accurate.',
    vi: 'Mọi lượt tạo ảnh, video và gọi LLM kèm trạng thái, token và chi phí ước tính. Nhập đơn giá model bên dưới để ước tính chính xác.',
  },
  loading: { en: 'Loading usage log…', vi: 'Đang tải nhật ký sử dụng…' },
  refresh: { en: 'Refresh', vi: 'Tải lại' },
  retry: { en: 'Try again', vi: 'Thử lại' },
  tabEvents: { en: 'Events', vi: 'Sự kiện' },
  tabMessages: { en: 'Messages', vi: 'Tin nhắn' },

  // ── Bộ lọc ─────────────────────────────────────────────────────────────────
  filterRange: { en: 'Time range', vi: 'Khoảng thời gian' },
  rangeToday: { en: 'Today', vi: 'Hôm nay' },
  range7d: { en: '7 days', vi: '7 ngày' },
  range30d: { en: '30 days', vi: '30 ngày' },
  rangeAll: { en: 'All', vi: 'Tất cả' },
  rangeCustom: { en: 'Custom', vi: 'Tự chọn' },
  filterFrom: { en: 'From', vi: 'Từ ngày' },
  filterTo: { en: 'To', vi: 'Đến ngày' },
  filterKind: { en: 'Type', vi: 'Loại' },
  kindAll: { en: 'All types', vi: 'Mọi loại' },
  kindImage: { en: 'Images', vi: 'Ảnh' },
  kindVideo: { en: 'Videos', vi: 'Video' },
  kindLlm: { en: 'LLM', vi: 'LLM' },
  kindUnclassified: { en: 'Unclassified', vi: 'Chưa phân loại' },
  filterOutcome: { en: 'Status', vi: 'Trạng thái' },
  outcomeAll: { en: 'All statuses', vi: 'Mọi trạng thái' },
  outcomeOk: { en: 'Completed', vi: 'Hoàn tất' },
  outcomeFailed: { en: 'Failed', vi: 'Thất bại' },
  outcomeUnknown: { en: 'Unknown', vi: 'Chưa xác định' },
  outcomePending: { en: 'Pending', vi: 'Đang chờ' },
  filterModel: { en: 'Model', vi: 'Model' },
  modelAll: { en: 'All models', vi: 'Mọi model' },
  filterSearch: { en: 'Search content', vi: 'Tìm trong nội dung' },
  searchPlaceholder: { en: 'Prompt or reply text', vi: 'Nội dung prompt hoặc phản hồi' },

  // ── Thẻ tổng quan ──────────────────────────────────────────────────────────
  cardTotal: { en: 'Total calls', vi: 'Tổng lượt' },
  cardBreakdown: {
    en: 'Images {image} · Videos {video} · LLM {llm}',
    vi: 'Ảnh {image} · Video {video} · LLM {llm}',
  },
  cardCost: { en: 'Estimated cost', vi: 'Chi phí ước tính' },
  costUnknownLabel: { en: 'Not estimated', vi: 'Chưa ước tính' },
  costUnknownNote: {
    en: '{count} calls have no estimate yet',
    vi: '{count} lượt chưa ước tính được',
  },
  cardTokens: { en: 'Tokens', vi: 'Token' },
  tokenPair: { en: '{input} in · {output} out', vi: '{input} vào · {output} ra' },
  cardFailed: { en: 'Failed / unknown', vi: 'Lỗi / không xác định' },
  failedPair: {
    en: '{failed} failed · {unknown} unknown',
    vi: '{failed} lỗi · {unknown} chưa xác định',
  },
  cardMedia: { en: 'Media storage', vi: 'Dung lượng media' },

  // ── Ngân sách tháng ────────────────────────────────────────────────────────
  budgetTitle: { en: 'Monthly budget', vi: 'Ngân sách tháng' },
  budgetAmountLabel: { en: 'Budget amount', vi: 'Mức ngân sách' },
  budgetCurrencyLabel: { en: 'Currency', vi: 'Tiền tệ' },
  budgetSave: { en: 'Save budget', vi: 'Lưu ngân sách' },
  budgetSaving: { en: 'Saving…', vi: 'Đang lưu…' },
  budgetSaved: { en: 'Budget saved.', vi: 'Đã lưu ngân sách.' },
  budgetInvalid: {
    en: 'Enter a budget of 0 or more, or leave it empty to remove it.',
    vi: 'Nhập ngân sách từ 0 trở lên, hoặc để trống để xoá.',
  },
  budgetUsed: {
    en: '{percent}% of the monthly budget used',
    vi: 'Đã dùng {percent}% ngân sách tháng',
  },
  budgetSpent: { en: '{spent} of {budget}', vi: '{spent} trên {budget}' },
  budgetOver: {
    en: 'You have gone over this month’s budget.',
    vi: 'Bạn đã vượt ngân sách tháng này.',
  },
  budgetUnset: {
    en: 'Set a monthly budget to track spending.',
    vi: 'Đặt ngân sách tháng để theo dõi chi tiêu.',
  },

  // ── Bảng sự kiện ───────────────────────────────────────────────────────────
  tableTime: { en: 'Time', vi: 'Thời gian' },
  tableKind: { en: 'Type', vi: 'Loại' },
  tableModel: { en: 'Model', vi: 'Model' },
  tableStatus: { en: 'Status', vi: 'Trạng thái' },
  tableCost: { en: 'Cost', vi: 'Chi phí' },
  tableContent: { en: 'Content', vi: 'Nội dung' },
  tableLinks: { en: 'Links', vi: 'Liên kết' },
  contentPromptLabel: { en: 'Prompt', vi: 'Prompt' },
  contentResponseLabel: { en: 'Reply', vi: 'Phản hồi' },
  linkProject: { en: 'Project', vi: 'Dự án' },
  linkSession: { en: 'Session', vi: 'Phiên' },
  linkScene: { en: 'Scene', vi: 'Cảnh' },
  linkLibrary: { en: 'Library', vi: 'Thư viện' },
  attemptCount: { en: '{count} attempts', vi: '{count} lần thử' },
  eventsEmptyTitle: { en: 'No events in this range', vi: 'Không có sự kiện trong khoảng này' },
  eventsEmptyHint: {
    en: 'Create an image or video, or chat with the AI, then come back here.',
    vi: 'Hãy tạo ảnh, video hoặc chat với AI rồi quay lại đây.',
  },
  loadMore: { en: 'Load more', vi: 'Tải thêm' },
  showingCount: { en: 'Showing {shown} of {total}', vi: 'Hiển thị {shown}/{total}' },

  // ── Tab Tin nhắn ───────────────────────────────────────────────────────────
  messagesEmptyTitle: { en: 'No messages in this range', vi: 'Không có tin nhắn trong khoảng này' },
  messagesEmptyHint: {
    en: 'Chat with the AI script writer to see your messages and their cost here.',
    vi: 'Chat với Tạo kịch bản AI để thấy tin nhắn và chi phí của chúng ở đây.',
  },
  roleUser: { en: 'You', vi: 'Bạn' },
  roleAssistant: { en: 'AI', vi: 'AI' },
  sessionFallback: { en: 'Untitled session', vi: 'Phiên chưa đặt tên' },
  messageCalls: { en: '{count} LLM calls', vi: '{count} lần gọi LLM' },
  messageChars: { en: '{count} characters', vi: '{count} ký tự' },
  messageCostUnknown: {
    en: '{count} calls not estimated',
    vi: '{count} lượt chưa ước tính được',
  },

  // ── Đơn giá model ──────────────────────────────────────────────────────────
  pricingTitle: { en: 'Model unit prices', vi: 'Đơn giá model' },
  pricingIntro: {
    en: 'Providers do not return prices; enter them yourself so the system can estimate costs.',
    vi: 'Provider không trả giá; bạn tự nhập để hệ thống ước tính.',
  },
  pricingUnit: { en: 'Price per call', vi: 'Giá mỗi lượt' },
  pricingInput: { en: 'Input / 1K tokens', vi: 'Vào / 1K token' },
  pricingOutput: { en: 'Output / 1K tokens', vi: 'Ra / 1K token' },
  pricingCurrency: { en: 'Currency', vi: 'Tiền tệ' },
  pricingSave: { en: 'Save price', vi: 'Lưu đơn giá' },
  pricingSaving: { en: 'Saving…', vi: 'Đang lưu…' },
  pricingSaved: { en: 'Saved', vi: 'Đã lưu' },
  pricingClearHint: { en: 'Empty clears the price', vi: 'Để trống là xoá đơn giá' },
  pricingInvalid: {
    en: 'Enter a number of 0 or more, or leave the field empty to clear it.',
    vi: 'Nhập số từ 0 trở lên, hoặc để trống để xoá.',
  },
  pricingEmpty: {
    en: 'No models yet. Add a provider and models in API & Models.',
    vi: 'Chưa có model. Thêm provider và model ở API & Models.',
  },

  // ── Gợi ý tiết kiệm ────────────────────────────────────────────────────────
  savingsTitle: { en: 'Saving suggestions', vi: 'Gợi ý tiết kiệm' },
  savingsIntro: {
    en: 'Calculated from the log only — no AI calls.',
    vi: 'Chỉ tính từ nhật ký — không gọi AI.',
  },
  savingsFailed: { en: 'Failed or unknown calls', vi: 'Lượt lỗi hoặc không xác định' },
  savingsFailedValue: { en: '{count} calls · {cost}', vi: '{count} lượt · {cost}' },
  savingsRetried: { en: 'Calls sent more than once', vi: 'Lượt đã gửi nhiều lần' },
  savingsRetriedValue: { en: '{count} calls retried', vi: '{count} lượt có thử lại' },
  savingsDuplicate: { en: 'Repeated scenes in 24h', vi: 'Tạo trùng cùng cảnh trong 24h' },
  savingsDuplicateValue: { en: '{count} duplicate generations', vi: '{count} lượt tạo trùng' },
  savingsTopModel: { en: 'Most expensive model', vi: 'Model tốn nhiều nhất' },
  savingsTopModelValue: { en: '{model} · {cost}', vi: '{model} · {cost}' },
  savingsNone: {
    en: 'Nothing stands out in this range.',
    vi: 'Chưa có điểm bất thường trong khoảng này.',
  },

  // ── Lưu log ────────────────────────────────────────────────────────────────
  logsTitle: { en: 'Log retention', vi: 'Lưu log' },
  logsNote: {
    en: 'LLM logs are deleted automatically after {days} days; images and videos are never deleted.',
    vi: 'Log LLM tự xoá sau {days} ngày; ảnh/video không bị xoá.',
  },
  deleteLogs: { en: 'Delete my LLM logs', vi: 'Xoá log LLM của tôi' },
  confirmDeleteLogs: {
    en: 'Delete all of your LLM logs? Images and videos are not affected.',
    vi: 'Xoá toàn bộ log LLM của bạn? Ảnh và video không bị ảnh hưởng.',
  },
  deletedLogs: { en: 'Deleted {count} log entries.', vi: 'Đã xoá {count} bản ghi.' },
  purgeLogs: { en: 'Purge logs older than {days} days', vi: 'Dọn log cũ hơn {days} ngày' },
  confirmPurgeLogs: {
    en: 'Purge LLM logs older than {days} days?',
    vi: 'Dọn log LLM cũ hơn {days} ngày?',
  },
  purgedLogs: { en: 'Purged {count} old log entries.', vi: 'Đã dọn {count} bản ghi cũ.' },

  // ── Panel quản trị ─────────────────────────────────────────────────────────
  adminTitle: { en: 'System-wide usage', vi: 'Nhật ký toàn hệ thống' },
  adminIntro: {
    en: 'Every account’s image, video and LLM calls. Only administrators can open this.',
    vi: 'Mọi lượt tạo ảnh, video và gọi LLM của tất cả tài khoản. Chỉ quản trị viên mở được.',
  },
  adminUserFilter: { en: 'User', vi: 'Người dùng' },
  adminUserAll: { en: 'All users', vi: 'Mọi người dùng' },
  adminUserPlaceholder: { en: 'User ID', vi: 'ID người dùng' },
  adminUserColumn: { en: 'User', vi: 'Người dùng' },
  adminTotal: { en: '{count} events in total', vi: 'Tổng {count} sự kiện' },
  adminEmpty: { en: 'No events found', vi: 'Không tìm thấy sự kiện' },
  adminEmptyHint: {
    en: 'Try a wider time range or clear the filters.',
    vi: 'Hãy thử khoảng thời gian rộng hơn hoặc xoá bộ lọc.',
  },
} as const satisfies Catalog

export type UsageCatalog = typeof usageCatalog
export type UsageCatalogKey = keyof UsageCatalog
