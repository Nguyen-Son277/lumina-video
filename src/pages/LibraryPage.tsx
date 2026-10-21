import { useMemo, useState } from 'react'
import { Film, Image as ImageIcon, LoaderCircle, Plus, Sparkles } from 'lucide-react'
import type { Generation, Mode } from '../api/types'
import { CreationCard } from '../components/Common'
import { Button, EmptyState, LoadingState, PageHeading } from '../components/ui'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'

export function LibraryPage({ generations, loading, onDelete, onRetry, onCreate, busyId }: {
  generations: Generation[]
  loading: boolean
  onDelete: (id: string) => void
  onRetry: (id: string) => void
  onCreate: () => void
  busyId: string | null
}) {
  const { t } = useTranslation(studioCatalog)
  const [filter, setFilter] = useState<'all' | Mode>('all')

  const visible = useMemo(
    () => (filter === 'all' ? generations : generations.filter((item) => item.kind === filter)),
    [generations, filter],
  )

  return (
    <div className="page-content library-page">
      <PageHeading
        title={<>{t('libraryHeadingLead')}<em>{t('libraryHeadingEmphasis')}</em></>}
        eyebrow={t('canvasEyebrow')}
        description={t('libraryIntro')}
        actions={<Button type="submit" className="primary-small-button" onClick={onCreate}>
          <Plus size={16} /> {t('createNew')}
        </Button>}
      />

      <div className="library-toolbar">
        <div className="library-tabs">
          <Button type="submit" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            {t('filterAll')} <span>{generations.length}</span>
          </Button>
          <Button type="submit" className={filter === 'image' ? 'active' : ''} onClick={() => setFilter('image')}>
            <ImageIcon size={14} /> {t('filterImages')}
          </Button>
          <Button type="submit" className={filter === 'video' ? 'active' : ''} onClick={() => setFilter('video')}>
            <Film size={14} /> {t('filterVideos')}
          </Button>
        </div>
      </div>

      {loading ? (
        <LoadingState className="empty-state" announce={false}><LoaderCircle size={26} className="spin" /><h3>{t('loadingShort')}</h3></LoadingState>
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
        <EmptyState
          icon={<Sparkles size={28} />}
          title={t('noResultsYet')}
          description={t('libraryEmptyHint')}
          actions={<Button type="submit" className="primary-small-button" onClick={onCreate}>{t('createFirst')}</Button>}
        />
      )}
    </div>
  )
}
