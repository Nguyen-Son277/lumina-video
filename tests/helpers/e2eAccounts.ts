/**
 * Tài khoản super admin dùng chung cho bộ test E2E.
 *
 * Server test (tests/helpers/mockServer.ts) đặt `SUPER_ADMIN_EMAILS` bằng hằng số
 * này, nhờ đó test có thể duyệt tài khoản mới qua API thật thay vì sửa database.
 */
export const E2E_ADMIN_EMAIL = 'e2e-admin@gigone.com'
export const E2E_ADMIN_PASSWORD = 'matkhau-admin-e2e-123'
