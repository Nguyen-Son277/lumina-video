import type { Catalog } from '../types'

export const usageChartsCatalog = {
  title: { en: 'Usage charts', vi: 'Biểu đồ sử dụng' },
  timeline: { en: 'Calls over time', vi: 'Lượt gọi theo thời gian' },
  breakdown: { en: 'Calls by type', vi: 'Lượt gọi theo loại' },
  description: { en: 'Stacked counts of image, video and AI text calls. Dates use UTC. Open the data table for exact values.', vi: 'Số lượt gọi ảnh, video và AI văn bản xếp chồng. Ngày theo UTC. Mở bảng dữ liệu để xem giá trị chính xác.' },
  day: { en: 'Daily · UTC', vi: 'Theo ngày · UTC' },
  week: { en: 'Weekly · UTC', vi: 'Theo tuần · UTC' },
  month: { en: 'Monthly · UTC', vi: 'Theo tháng · UTC' },
  groupedMonths: { en: 'Every {step} months · UTC', vi: 'Mỗi {step} tháng · UTC' },
  image: { en: 'Images', vi: 'Ảnh' },
  video: { en: 'Videos', vi: 'Video' },
  llm: { en: 'AI text', vi: 'AI văn bản' },
  legend: { en: 'Chart legend', vi: 'Chú giải biểu đồ' },
  total: { en: 'Total calls', vi: 'Tổng lượt gọi' },
  period: { en: 'Period (UTC)', vi: 'Khoảng thời gian (UTC)' },
  type: { en: 'Type', vi: 'Loại' },
  count: { en: 'Calls', vi: 'Lượt gọi' },
  percent: { en: 'Share', vi: 'Tỷ lệ' },
  details: { en: 'View chart data tables', vi: 'Xem bảng dữ liệu biểu đồ' },
  loading: { en: 'Loading usage charts…', vi: 'Đang tải biểu đồ sử dụng…' },
  empty: { en: 'No calls in this range.', vi: 'Không có lượt gọi trong khoảng này.' },
} as const satisfies Catalog

export type UsageChartsCatalog = typeof usageChartsCatalog
export type UsageChartsCatalogKey = keyof UsageChartsCatalog
