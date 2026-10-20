/** Account security copy; API errors remain unknown causes until render. */
export const accountSettingsCatalog = {
  title: { en: 'Account settings', vi: 'Cài đặt tài khoản' },
  description: { en: 'Manage the security of your account.', vi: 'Quản lý bảo mật tài khoản của bạn.' },
  email: { en: 'Email address', vi: 'Địa chỉ email' },
  emailHint: { en: 'Your sign-in email cannot be changed here.', vi: 'Không thể thay đổi email đăng nhập tại đây.' },
  passwordTitle: { en: 'Change password', vi: 'Đổi mật khẩu' },
  passwordDescription: {
    en: 'Choose a strong password you do not use for another account.',
    vi: 'Chọn mật khẩu mạnh mà bạn không sử dụng cho tài khoản khác.',
  },
  currentPassword: { en: 'Current password', vi: 'Mật khẩu hiện tại' },
  newPassword: { en: 'New password', vi: 'Mật khẩu mới' },
  confirmPassword: { en: 'Confirm new password', vi: 'Xác nhận mật khẩu mới' },
  passwordHint: { en: 'Use 10–200 characters.', vi: 'Sử dụng từ 10–200 ký tự.' },
  currentRequired: { en: 'Enter your current password.', vi: 'Nhập mật khẩu hiện tại của bạn.' },
  currentTooLong: { en: 'The current password must not exceed 200 characters.', vi: 'Mật khẩu hiện tại không được vượt quá 200 ký tự.' },
  newPasswordLength: { en: 'The new password must be 10–200 characters.', vi: 'Mật khẩu mới phải có từ 10–200 ký tự.' },
  passwordMismatch: { en: 'The new passwords do not match.', vi: 'Mật khẩu mới không khớp.' },
  submit: { en: 'Update password', vi: 'Cập nhật mật khẩu' },
  saving: { en: 'Updating password…', vi: 'Đang cập nhật mật khẩu…' },
  sessionHint: {
    en: 'You will stay signed in here. Other sessions will be signed out after your password changes.',
    vi: 'Bạn sẽ vẫn đăng nhập tại đây. Các phiên khác sẽ bị đăng xuất sau khi đổi mật khẩu.',
  },
  success: {
    en: 'Password updated. You are still signed in here; all other sessions have been revoked.',
    vi: 'Đã cập nhật mật khẩu. Bạn vẫn đăng nhập tại đây; tất cả phiên khác đã bị thu hồi.',
  },
} as const

export type AccountSettingsCatalogKey = keyof typeof accountSettingsCatalog
