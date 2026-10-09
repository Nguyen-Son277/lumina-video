import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { plannerCatalog } from '../../i18n/catalogs/planner'
import { useTranslation } from '../../i18n/useTranslation'

/**
 * Trạng thái đang chờ AI.
 *
 * Khoá nút là chưa đủ để người dùng biết ứng dụng đang chạy: overlay này nói rõ
 * đang làm gì và đếm thời gian đã chờ, tránh cảm giác bấm không có phản hồi.
 * `label` do nơi gọi truyền vào đã được dịch sẵn.
 */
export function AsyncOverlay({ label }: { label: string }) {
  const [seconds, setSeconds] = useState(0)
  const { t } = useTranslation(plannerCatalog)

  useEffect(() => {
    setSeconds(0)
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [label])

  return (
    <div className="planner-loading" role="status" aria-live="polite">
      <LoaderCircle size={18} className="spin" />
      <div>
        <strong>{label}</strong>
        <span>{t('waitedSeconds', { seconds })}</span>
      </div>
    </div>
  )
}

/** Nội dung nút: spinner + nhãn riêng khi đang chạy. */
export function ActionLabel({
  busy,
  idle,
  working,
}: {
  busy: boolean
  idle: string
  working: string
}) {
  if (!busy) return <>{idle}</>
  return (
    <>
      <LoaderCircle size={15} className="spin" /> {working}
    </>
  )
}

/** Khung xương cho danh sách đang được AI tạo. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="planner-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  )
}
