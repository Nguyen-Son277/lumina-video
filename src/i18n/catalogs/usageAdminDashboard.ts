import type { Catalog } from '../types'

export const usageAdminDashboardCatalog = {
  intro: { en: 'System-wide activity across accounts, images, videos and LLM calls.', vi: 'Hoạt động toàn hệ thống theo tài khoản, ảnh, video và lượt gọi LLM.' },
  advanced: { en: 'Advanced filters', vi: 'Bộ lọc nâng cao' },
  reset: { en: 'Reset filters', vi: 'Đặt lại bộ lọc' },
  completed: { en: 'Completed calls', vi: 'Lượt hoàn tất' },
  pendingNote: { en: '{count} pending calls', vi: '{count} lượt đang chờ' },
  accountUnknown: { en: 'Unknown account', vi: 'Tài khoản chưa xác định' },
  modelUnknown: { en: 'Unknown model', vi: 'Model chưa xác định' },
} satisfies Catalog
