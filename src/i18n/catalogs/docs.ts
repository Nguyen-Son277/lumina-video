import type { Catalog } from '../types'

export const docsCatalog = {
  title: { en: 'Your guide to creating.', vi: 'Hướng dẫn sáng tạo của bạn.' },
  description: { en: 'From your first image to a complete video. Explore every part of Lumina, one step at a time.', vi: 'Từ bức ảnh đầu tiên đến video hoàn chỉnh. Khám phá từng chức năng Lumina qua hướng dẫn từng bước.' },
  search: { en: 'Search documentation', vi: 'Tìm trong hướng dẫn' },
  searchPlaceholder: { en: 'Search guides, features, or questions…', vi: 'Tìm hướng dẫn, chức năng hoặc câu hỏi…' },
  loading: { en: 'Loading documentation…', vi: 'Đang tải hướng dẫn…' },
} as const satisfies Catalog
