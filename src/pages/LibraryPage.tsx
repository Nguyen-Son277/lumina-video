import { useMemo, useState } from 'react'
import { Film, Image as ImageIcon, LoaderCircle, Plus, Sparkles } from 'lucide-react'
import type { Generation, Mode } from '../api/types'
import { CreationCard } from '../components/Common'

export function LibraryPage({ generations, loading, onDelete, onRetry, onCreate, busyId }: {
  generations: Generation[]
  loading: boolean
  onDelete: (id: string) => void
  onRetry: (id: string) => void
  onCreate: () => void
  busyId: string | null
}) {
  const [filter, setFilter] = useState<'all' | Mode>('all')

  const visible = useMemo(
    () => (filter === 'all' ? generations : generations.filter((item) => item.kind === filter)),
    [generations, filter],
  )

  return (
    <div className="page-content library-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> Your canvas</div>
          <h1>Thư viện <em>sáng tạo.</em></h1>
          <p>Mọi hình ảnh và video của bạn, được lưu trữ ở một nơi.</p>
        </div>
        <button className="primary-small-button" onClick={onCreate}>
          <Plus size={16} /> Tạo mới
        </button>
      </section>

      <div className="library-toolbar">
        <div className="library-tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            Tất cả <span>{generations.length}</span>
          </button>
          <button className={filter === 'image' ? 'active' : ''} onClick={() => setFilter('image')}>
            <ImageIcon size={14} /> Ảnh
          </button>
          <button className={filter === 'video' ? 'active' : ''} onClick={() => setFilter('video')}>
            <Film size={14} /> Video
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state"><LoaderCircle size={26} className="spin" /><h3>Đang tải...</h3></div>
      ) : visible.length ? (
        <div className="library-grid">
          {visible.map((generation) => (
            <CreationCard
              key={generation.id}
              generation={generation}
              onDelete={() => onDelete(generation.id)}
              onRetry={() => onRetry(generation.id)}
              busy={busyId === generation.id}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Sparkles size={28} />
          <h3>Chưa có kết quả nào</h3>
          <p>Bắt đầu với một ý tưởng nhỏ trong Studio.</p>
          <button className="primary-small-button" onClick={onCreate}>Tạo creation đầu tiên</button>
        </div>
      )}
    </div>
  )
}
