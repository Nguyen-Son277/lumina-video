/**
 * Catalog namespace `admin` — trang duyệt tài khoản dành riêng cho super admin.
 *
 * Quy ước chung của dự án:
 * - Mọi khoá đều có đủ `en` (mặc định) và `vi`, cùng tập tham số nội suy.
 * - KHÔNG chứa email, ID hay nội dung do người dùng nhập; những giá trị đó truyền
 *   qua tham số `{...}` và hiển thị nguyên văn.
 */

import type { Catalog } from '../types'

export const adminCatalog = {
  // ── Vỏ trang quản trị ─────────────────────────────────────────────────────
  adminTitle: { en: 'Account approvals', vi: 'Duyệt tài khoản' },
  adminTabAccounts: { en: 'Accounts', vi: 'Tài khoản' },
  adminTabUsage: { en: 'Usage log', vi: 'Nhật ký sử dụng' },
  adminTabsAria: { en: 'Admin sections', vi: 'Khu vực quản trị' },
  adminSubtitle: {
    en: 'Approve or reject new accounts before they can sign in.',
    vi: 'Duyệt hoặc từ chối tài khoản mới trước khi họ đăng nhập được.',
  },
  adminSignedInAs: { en: 'Signed in as {email}', vi: 'Đang đăng nhập bằng {email}' },
  adminOnlyAdmins: {
    en: 'Only administrators can open this page.',
    vi: 'Chỉ quản trị viên mới mở được trang này.',
  },

  // ── Số liệu và bộ lọc ─────────────────────────────────────────────────────
  adminCountPending: { en: '{count} waiting', vi: '{count} chờ duyệt' },
  adminCountApproved: { en: '{count} approved', vi: '{count} đã duyệt' },
  adminCountRejected: { en: '{count} rejected', vi: '{count} bị từ chối' },
  adminCountTotal: { en: '{count} accounts', vi: '{count} tài khoản' },
  adminFilterPending: { en: 'Waiting', vi: 'Chờ duyệt' },
  adminFilterApproved: { en: 'Approved', vi: 'Đã duyệt' },
  adminFilterRejected: { en: 'Rejected', vi: 'Bị từ chối' },
  adminFilterAll: { en: 'All', vi: 'Tất cả' },
  adminSearchLabel: { en: 'Search by email', vi: 'Tìm theo email' },
  adminSearchPlaceholder: { en: 'name@gigone.com', vi: 'ten@gigone.com' },
  adminRefresh: { en: 'Refresh', vi: 'Làm mới' },

  // ── Bảng tài khoản ────────────────────────────────────────────────────────
  adminColumnEmail: { en: 'Email', vi: 'Email' },
  adminColumnStatus: { en: 'Status', vi: 'Trạng thái' },
  adminColumnRole: { en: 'Role', vi: 'Vai trò' },
  adminColumnCreated: { en: 'Registered', vi: 'Ngày đăng ký' },
  adminColumnActions: { en: 'Actions', vi: 'Thao tác' },
  adminStatusPending: { en: 'Waiting', vi: 'Chờ duyệt' },
  adminStatusApproved: { en: 'Approved', vi: 'Đã duyệt' },
  adminStatusRejected: { en: 'Rejected', vi: 'Bị từ chối' },
  adminRoleAdmin: { en: 'Administrator', vi: 'Quản trị viên' },
  adminRoleUser: { en: 'User', vi: 'Người dùng' },
  adminEmpty: { en: 'No accounts match this filter.', vi: 'Không có tài khoản nào khớp bộ lọc.' },
  adminLoading: { en: 'Loading accounts...', vi: 'Đang tải danh sách tài khoản...' },

  // ── Thao tác ──────────────────────────────────────────────────────────────
  adminApprove: { en: 'Approve', vi: 'Duyệt' },
  adminReject: { en: 'Reject', vi: 'Từ chối' },
  adminRevoke: { en: 'Revoke approval', vi: 'Thu hồi duyệt' },
  adminApproveNotice: { en: 'Approved {email}', vi: 'Đã duyệt {email}' },
  adminRejectNotice: { en: 'Rejected {email}', vi: 'Đã từ chối {email}' },
  adminRevokeNotice: { en: 'Moved {email} back to waiting', vi: 'Đã đưa {email} về hàng chờ' },
} satisfies Catalog

/** Khoá hợp lệ của catalog `admin`. */
export type AdminCatalogKey = keyof typeof adminCatalog
