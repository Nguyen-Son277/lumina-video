import type { ReactNode } from 'react'
import { Layers3, LoaderCircle, Search, Sparkles, Trash2 } from 'lucide-react'
import type { Project } from '../../api/projectTypes'
import { formatDate, useTranslation } from '../../i18n'
import { studioCatalog } from '../../i18n/catalogs/studio'
import { studioBeginnerCatalog } from '../../i18n/catalogs/studioBeginner'
import { EmptyState, LoadingState, PageHeading } from '../ui'

type ProjectCover = { url: string; kind: 'image' | 'video' }

type Props = {
  projectCount: number
  projects: Project[]
  covers: Record<string, ProjectCover>
  loading: boolean
  busy: string
  search: string
  showTrash: boolean
  showArchived: boolean
  headerActions: ReactNode
  modelNotice?: ReactNode
  onSearchChange: (value: string) => void
  onToggleTrash: () => void
  onShowArchivedChange: (value: boolean) => void
  onClearFilters: () => void
  onOpenProject: (project: Project) => void
  onCreateProject: () => void
  onRestoreProject: (project: Project) => void
  onTrashProject: (project: Project) => void
  onOpenTrash?: () => void
}

/** Dashboard presentation only; the Studio owner keeps requests and mutations. */
export function ProjectBrowser({
  projectCount, projects, covers, loading, busy, search, showTrash, showArchived,
  headerActions, modelNotice, onSearchChange, onToggleTrash, onShowArchivedChange,
  onClearFilters, onOpenProject, onCreateProject, onRestoreProject, onTrashProject, onOpenTrash,
}: Props) {
  const { t, locale } = useTranslation(studioCatalog)
  const { t: help } = useTranslation(studioBeginnerCatalog)

  return <>
    <PageHeading
      as="div"
      className="project-section-header"
      intro={<div>
        <div className="eyebrow">{t('projectStudioEyebrow')}</div>
        <h1>{t('projectStudioTitle')}</h1>
        <p>{t('projectStudioIntro')}</p>
      </div>}
      actions={headerActions}
    />

    {!showTrash && !loading && <details className="studio-start-guide" key={projectCount ? 'existing' : 'first'} open={projectCount === 0 || undefined}>
      <summary>{help(projectCount ? 'guide' : 'welcome')}</summary>
      <p>{help('intro')}</p>
      <ol className="studio-start-steps"><li>{help('step1')}</li><li>{help('step2')}</li><li>{help('step3')}</li></ol>
    </details>}

    {modelNotice}

    <div className="project-dashboard-toolbar">
      <label className="project-search">
        <Search size={16} />
        <input
          value={search}
          placeholder={t('searchProjectsPlaceholder')}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>
      <button className="secondary-button project-trash-filter" aria-pressed={showTrash} disabled={!!busy} onClick={onToggleTrash}><Trash2 size={15} /> {showTrash ? t('projectsTab') : t('trashTab')}</button>
      {!showTrash && <label className="project-archive-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => onShowArchivedChange(event.target.checked)}
        />
        {t('showArchivedLabel')}
      </label>}
    </div>
    {!showTrash && !loading && projectCount > 0 && projects.length === 0 && <div className="studio-no-matches" role="status"><p>{help('noMatches')}</p><button type="button" className="secondary-button" onClick={onClearFilters}>{help('clearFilters')}</button></div>}
    {showTrash && <p className="project-trash-summary">{t('trashSummary')} {onOpenTrash && <button type="button" className="text-button" onClick={onOpenTrash}>{t('openUnifiedTrash')}</button>}</p>}

    {loading ? (
      <LoadingState className="empty-state" announce={false}>
        <LoaderCircle size={26} className="spin" />
        <h3>{t('loadingProjects')}</h3>
      </LoadingState>
    ) : (
      <div className="project-dashboard-grid">
        {projects.map((item) => {
          const cover = covers[item.id]
          return (
            <article key={item.id} className="project-dashboard-card project-trash-card" data-project-id={item.id}>
              {showTrash ? <div className="project-card-body"><h3>{item.name}</h3><p>{item.description}</p></div> : <button
                className="project-card-open"
                onClick={() => onOpenProject(item)}
              >
              <div className="project-cover">
                {cover ? (
                  cover.kind === 'video' ? (
                    <video src={cover.url} muted preload="metadata" />
                  ) : (
                    <img src={cover.url} alt="" loading="lazy" />
                  )
                ) : (
                  <div className="project-cover-placeholder">
                    <Layers3 />
                    <span>{t('noContent')}</span>
                  </div>
                )}
              </div>
              <div className="project-card-body">
                <h3>{item.name}</h3>
                <div className="project-card-meta">
                  <span>{item.language || 'vi'}</span>
                  {item.style && <span>{item.style.slice(0, 24)}</span>}
                  {item.archived && <span className="not-connected-pill">{t('archivedBadge')}</span>}
                </div>
              </div>
              </button>}
              {showTrash && <p className="project-trash-expiry">{t('permanentDeleteAt', { date: item.purgeAfter ? formatDate(item.purgeAfter, { dateStyle: 'short', timeStyle: 'short' }, locale) : t('after30Days') })}<br />{item.deleteResults ? t('purgeDeletesResults') : t('purgeKeepsResults')}</p>}
              <div className="project-trash-card-actions">
                {showTrash ? <button className="secondary-button" disabled={!!busy} onClick={() => onRestoreProject(item)}>
                  {busy === `restore:${item.id}` && <LoaderCircle size={14} className="spin" />} {t('restore')}
                </button> : <button className="secondary-button project-trash-danger" disabled={!!busy} onClick={() => onTrashProject(item)}><Trash2 size={14} /> {t('deleteAction')}</button>}
              </div>
            </article>
          )
        })}
        {showTrash && projects.length === 0 && <EmptyState className="empty-state"><Trash2 size={26} /><h3>{t('trashEmptyTitle')}</h3><p>{t('trashEmptyHint')}</p></EmptyState>}

        {!showTrash && projectCount > 0 && <button className="project-start-card" onClick={onCreateProject}>
          <Sparkles size={28} />
          <strong>{t('createNewProject')}</strong>
          <span className="project-hint">
            {t('startProjectHint')}
          </span>
        </button>}
      </div>
    )}
  </>
}
