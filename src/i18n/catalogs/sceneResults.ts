import type { Catalog } from '../types'

export const sceneResultsCatalog = {
  loading: { en: 'Loading scene versions…', vi: 'Đang tải phiên bản của cảnh…' },
  title: { en: 'Scene history: {title}', vi: 'Lịch sử cảnh: {title}' },
  untitled: { en: 'Untitled scene', vi: 'Cảnh chưa có tên' },
  close: { en: 'Close scene history', vi: 'Đóng lịch sử cảnh' },
  edit: { en: 'Edit scene', vi: 'Chỉnh sửa cảnh' },
  intro: {
    en: 'Preview previous versions and select the one to use for this scene. To create a new version, edit the scene.',
    vi: 'Xem trước các phiên bản và chọn bản muốn dùng cho cảnh này. Để tạo phiên bản mới, hãy chỉnh sửa cảnh.',
  },
  versions: { en: 'Scene versions', vi: 'Các phiên bản của cảnh' },
  version: { en: 'Version {number}', vi: 'Phiên bản {number}' },
  selected: { en: 'Selected', vi: 'Đã chọn' },
  select: { en: 'Use this version', vi: 'Dùng phiên bản này' },
  selectAria: { en: 'Use version {number} for this scene', vi: 'Dùng phiên bản {number} cho cảnh này' },
  preview: { en: 'Version {number} preview', vi: 'Xem trước phiên bản {number}' },
  noAsset: { en: 'No preview is available for this version.', vi: 'Phiên bản này chưa có nội dung để xem trước.' },
  emptyTitle: { en: 'No versions yet', vi: 'Chưa có phiên bản nào' },
  emptyDescription: {
    en: 'Edit this scene to create its first video. New versions will appear here.',
    vi: 'Chỉnh sửa cảnh để tạo video đầu tiên. Các phiên bản mới sẽ xuất hiện tại đây.',
  },
  queued: { en: 'Queued', vi: 'Đang chờ' },
  running: { en: 'Generating', vi: 'Đang tạo' },
  downloading: { en: 'Downloading', vi: 'Đang tải về' },
  succeeded: { en: 'Completed', vi: 'Hoàn tất' },
  failed: { en: 'Failed', vi: 'Thất bại' },
  unknown: { en: 'Unknown status', vi: 'Chưa rõ trạng thái' },
  failedDescription: {
    en: 'This version did not complete. Edit the scene to create a new version.',
    vi: 'Phiên bản này chưa hoàn tất. Chỉnh sửa cảnh để tạo phiên bản mới.',
  },
} as const satisfies Catalog
