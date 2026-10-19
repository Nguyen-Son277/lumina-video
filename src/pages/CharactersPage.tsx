import { useCallback, useEffect, useState } from 'react'
import {
  BrainCircuit,
  Copy,
  ImagePlus,
  Image as ImageIcon,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  X,
  Sparkles,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { ApiError } from '../api/client'
import { characterApi } from '../api/endpoints'
import type { CharacterInput, CharacterProjectState, CharacterUsage, ProjectCharacter } from '../api/projectTypes'
import type { ModelInfo } from '../api/types'
import { CharacterAiModal } from '../components/CharacterAiModal'
import {
  CharacterForm,
  charactersErrorMessage,
  describeCharactersError,
  type CharactersUiError,
} from '../components/CharacterForm'
import { CharacterIllustrateModal } from '../components/CharacterIllustrateModal'
import { CharacterPromptModal } from '../components/CharacterPromptModal'
import { ImageLightbox } from '../components/Lightbox'
import { useTranslation } from '../i18n'
import { charactersCatalog } from '../i18n/catalogs/characters'
import { notification, type Notification } from '../i18n/messages'

/**
 * Nhãn rút gọn của hồ sơ giọng trên thẻ nhân vật.
 *
 * Chỉ giữ KHOÁ catalog ở cấp module: bản dịch được tra trong lúc render nên đổi
 * ngôn ngữ là đổi ngay, không bị "đóng băng" theo ngôn ngữ lúc import.
 */
const VOICE_SUMMARY = [
  { key: 'accent', labelKey: 'voiceSummaryAccent' },
  { key: 'pitch', labelKey: 'voiceSummaryPitch' },
  { key: 'timbre', labelKey: 'voiceSummaryTimbre' },
  { key: 'pace', labelKey: 'voiceSummaryPace' },
] as const satisfies ReadonlyArray<{
  key: keyof ProjectCharacter['voice']
  labelKey: keyof typeof charactersCatalog
}>

/** Shorten only the library-card display, preserving Unicode code points. */
function shortenAppearance(text: string): string {
  const codepoints = Array.from(text)
  return codepoints.length <= 200 ? text : `${codepoints.slice(0, 197).join('')}...`
}

/**
 * Thư viện nhân vật dùng chung.
 *
 * Nhân vật tạo ở đây thuộc tài khoản, không thuộc dự án nào, nên dùng được cho
 * cả "Tạo nội dung đơn lẻ" lẫn mọi dự án trong Studio.
 */
export function CharactersPage({ llmModels, models, onNotify, onOpenSettings }: {
  /** Model văn bản (kind = 'llm') đang bật, dùng cho AI tạo nhân vật. */
  llmModels: ModelInfo[]
  /** Model tạo ảnh hiện có, dùng cho minh hoạ nhân vật. */
  models: ModelInfo[]
  onNotify: (message: Notification) => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation(charactersCatalog)
  const [characters, setCharacters] = useState<ProjectCharacter[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<ProjectCharacter | 'new' | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [illustrateFor, setIllustrateFor] = useState<ProjectCharacter | null>(null)
  const [promptFor, setPromptFor] = useState<ProjectCharacter | null>(null)
  const [busy, setBusy] = useState('')
  // Giữ descriptor lỗi thay vì câu đã dịch: đổi ngôn ngữ là câu lỗi đổi theo.
  const [error, setError] = useState<CharactersUiError | null>(null)
  /** Nhân vật bị chặn xoá vì còn được dùng, kèm danh sách nơi đang dùng. */
  const [inUse, setInUse] = useState<{ character: ProjectCharacter; usage: CharacterUsage } | null>(null)
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null)

  const load = useCallback(async () => {
    const result = await characterApi.list()
    setCharacters(result.characters)
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    load()
      .catch((cause: unknown) => {
        if (alive) setError(describeCharactersError(cause))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [load])

  async function refresh() {
    setBusy('refresh')
    setError(null)
    try {
      await load()
      onNotify(notification('characters', 'notifyLibraryRefreshed'))
    } catch (cause) {
      setError(describeCharactersError(cause))
    } finally {
      setBusy('')
    }
  }

  /** Lưu nhân vật, sau đó tải lên hoặc xóa ảnh tham chiếu nếu người dùng đổi. */
  async function save(
    input: CharacterInput,
    changes: { file?: File; removeReference?: boolean } = {},
  ) {
    const editing = modal && modal !== 'new' ? modal : null
    let saved = editing
      ? (await characterApi.update(editing.id, input)).character
      : (await characterApi.create(input)).character

    if (changes.file) {
      saved = (await characterApi.uploadReference(saved.id, changes.file)).character
    } else if (changes.removeReference) {
      saved = (await characterApi.removeReference(saved.id)).character
    }

    setCharacters((current) => {
      const exists = current.some((item) => item.id === saved.id)
      return exists
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved]
    })

    onNotify(
      editing
        ? notification('characters', 'notifyCharacterUpdated')
        : notification('characters', 'notifyCharacterCreated'),
    )
  }

  /**
   * Server từ chối xoá vì nhân vật còn được dùng: đọc danh sách nơi đang dùng để
   * mở hộp thoại xác nhận thay vì chỉ hiện một dòng lỗi.
   */
  function usageFromError(cause: unknown): CharacterUsage | null {
    if (!(cause instanceof ApiError) || cause.messageKey !== 'characters.in_use') return null
    const usage = (cause.details as { usage?: CharacterUsage } | undefined)?.usage
    return usage && Array.isArray(usage.scenes) && Array.isArray(usage.canvas) ? usage : null
  }

  async function remove(character: ProjectCharacter, options: { detach?: boolean } = {}) {
    setBusy(character.id)
    setError(null)
    try {
      const result = await characterApi.remove(character.id, options)
      setCharacters((current) => current.filter((item) => item.id !== character.id))
      setInUse(null)
      const detached = result?.detached
      if (detached && detached.scenes + detached.canvasNodes > 0) {
        onNotify(notification('characters', 'notifyCharacterDetached', {
          scenes: detached.scenes,
          canvas: detached.canvasNodes,
        }))
      } else {
        onNotify(notification('characters', 'notifyCharacterDeleted'))
      }
    } catch (cause) {
      const usage = usageFromError(cause)
      if (usage) {
        setInUse({ character, usage })
        return
      }
      setError(describeCharactersError(cause))
    } finally {
      setBusy('')
    }
  }

  /** Gom nơi đang dùng theo dự án để hộp thoại đọc được nhanh. */
  function usageGroups(usage: CharacterUsage) {
    const groups = new Map<string, { name: string; state: CharacterProjectState; scenes: string[]; canvas: number }>()
    const entry = (projectId: string, projectName: string, projectState: CharacterProjectState) =>
      groups.get(projectId) ?? (groups.set(projectId, { name: projectName, state: projectState, scenes: [], canvas: 0 }).get(projectId)!)
    for (const scene of usage.scenes) entry(scene.projectId, scene.projectName, scene.projectState).scenes.push(scene.sceneTitle)
    for (const node of usage.canvas) entry(node.projectId, node.projectName, node.projectState).canvas += 1
    return [...groups.entries()].map(([id, value]) => ({ id, ...value }))
  }

  const usageStateKey: Record<CharacterProjectState, 'inUseStateActive' | 'inUseStateArchived' | 'inUseStateTrashed'> = {
    active: 'inUseStateActive',
    archived: 'inUseStateArchived',
    trashed: 'inUseStateTrashed',
  }

  return (
    <div className="page-content characters-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> {t('pageEyebrow')}</div>
          <h1>{t('pageTitleLead')} <em>{t('pageTitleAccent')}</em></h1>
          <p>{t('pageDescription')}</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" disabled={!!busy || loading} onClick={() => void refresh()}>
            <RefreshCw size={15} /> {t('refresh')}
          </button>
          <button className="secondary-button" onClick={() => setAiOpen(true)}>
            <BrainCircuit size={15} /> {t('aiCreate')}
          </button>
          <button className="primary-small-button" onClick={() => setModal('new')}>
            <Plus size={16} /> {t('createCharacter')}
          </button>
        </div>
      </section>

      {error && <div className="form-error" role="alert">{charactersErrorMessage(error)}</div>}

      {loading ? (
        <div className="empty-state" role="status"><LoaderCircle size={24} className="spin" /><h3>{t('loadingCharacters')}</h3></div>
      ) : characters.length ? (
        <div className="character-library-grid">
          {characters.map((character) => (
            <article className="character-library-card" key={character.id}>
              <div className="character-library-media">
                {character.referenceUrl ? (
                  <button
                    type="button"
                    className="creation-zoom"
                    aria-label={t('viewReferenceImageAria', { name: character.name })}
                    title={t('clickToZoomHint')}
                    onClick={() =>
                      setZoom({ url: character.referenceUrl!, name: character.name })
                    }
                  >
                    <img src={character.referenceUrl} alt={t('referenceImageAlt', { name: character.name })} loading="lazy" />
                  </button>
                ) : (
                  <div className="character-library-placeholder">
                    <ImageIcon size={24} />
                    <span>{t('noReferenceImage')}</span>
                  </div>
                )}
              </div>

              <div className="character-library-body">
                <div className="character-library-title">
                  <div className="project-character-avatar">
                    {character.name.slice(0, 1).toUpperCase()}
                  </div>
                  <h3>{character.name}</h3>
                </div>
                <p>{character.appearance ? shortenAppearance(character.appearance) : t('appearanceEmpty')}</p>
                <div className="character-library-tags">
                  {VOICE_SUMMARY.filter(({ key }) => character.voice?.[key]).map(({ key, labelKey }) => (
                    <span key={key}>{t(labelKey)}: {character.voice[key]}</span>
                  ))}
                  {!VOICE_SUMMARY.some(({ key }) => character.voice?.[key]) && (
                    <span>{t('voiceSummaryEmpty')}</span>
                  )}
                </div>
              </div>

              <div className="character-library-actions">
                <button
                  className="secondary-button"
                  disabled={busy === character.id}
                  onClick={() => setModal(character)}
                >
                  <Pencil size={14} /> {t('edit')}
                </button>
                <button
                  className="secondary-button"
                  disabled={busy === character.id}
                  onClick={() => setIllustrateFor(character)}
                  title={t('illustrateHint')}
                >
                  <ImagePlus size={14} /> {t('illustrate')}
                </button>
                <button
                  className="secondary-button"
                  disabled={busy === character.id}
                  onClick={() => setPromptFor(character)}
                  title={t('promptHint')}
                >
                  <Copy size={14} /> {t('promptLabel')}
                </button>
                <button
                  className="row-more"
                  disabled={busy === character.id}
                  onClick={() => void remove(character)}
                  aria-label={t('deleteCharacterAria', { name: character.name })}
                  title={t('deleteCharacterHint')}
                >
                  {busy === character.id
                    ? <LoaderCircle size={15} className="spin" />
                    : <Trash2 size={15} />}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Users size={28} />
          <h3>{t('libraryEmptyTitle')}</h3>
          <p>{t('libraryEmptyDescription')}</p>
          <button className="primary-small-button" onClick={() => setModal('new')}>
            <Sparkles size={15} /> {t('createFirstCharacter')}
          </button>
        </div>
      )}

      {inUse && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setInUse(null) }}
        >
          <div className="modal-card character-in-use" role="dialog" aria-modal="true" aria-label={t('inUseTitle')}>
            <div className="modal-header">
              <div>
                <div className="eyebrow"><span className="eyebrow-dot" /> {t('deleteCharacterHint')}</div>
                <h2>{t('inUseTitle')}</h2>
              </div>
              <button className="close-button" onClick={() => setInUse(null)} aria-label={t('inUseCancel')}><X size={18} /></button>
            </div>
            <p className="modal-description">
              {t('inUseBody', { count: usageGroups(inUse.usage).length })}
            </p>
            <ul className="character-usage-list">
              {usageGroups(inUse.usage).map((group) => (
                <li key={group.id}>
                  <div className="character-usage-head">
                    <strong>{group.name}</strong>
                    <span className={`character-usage-state is-${group.state}`}>{t(usageStateKey[group.state])}</span>
                  </div>
                  <p>
                    {group.scenes.length ? t('inUseScenes', { count: group.scenes.length }) : ''}
                    {group.scenes.length && group.canvas ? ' · ' : ''}
                    {group.canvas ? t('inUseCanvas', { count: group.canvas }) : ''}
                  </p>
                  {group.scenes.length > 0 && (
                    <small>{t('inUseSceneList', { titles: group.scenes.slice(0, 5).join(', ') })}</small>
                  )}
                </li>
              ))}
            </ul>
            <div className="modal-warning">
              <TriangleAlert size={14} /> {t('inUseNote')}
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setInUse(null)}>{t('inUseCancel')}</button>
              <button
                className="primary-small-button"
                disabled={busy === inUse.character.id}
                onClick={() => void remove(inUse.character, { detach: true })}
              >
                {busy === inUse.character.id ? <LoaderCircle size={15} className="spin" /> : null} {t('inUseConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <CharacterForm
          character={modal === 'new' ? undefined : modal}
          language="vi"
          onSave={save}
          onClose={() => setModal(null)}
        />
      )}

      {aiOpen && (
        <CharacterAiModal
          llmModels={llmModels}
          models={models}
          onClose={() => setAiOpen(false)}
          onAdded={() => void load().catch(() => undefined)}
          onOpenSettings={onOpenSettings}
          onNotify={onNotify}
        />
      )}

      {illustrateFor && (
        <CharacterIllustrateModal
          character={illustrateFor}
          models={models}
          onClose={() => setIllustrateFor(null)}
          onAttached={(updated) => {
            setCharacters((current) =>
              current.map((item) => (item.id === updated.id ? updated : item)),
            )
            setIllustrateFor(null)
          }}
          onNotify={onNotify}
        />
      )}

      {promptFor && (
        <CharacterPromptModal
          character={promptFor}
          onClose={() => setPromptFor(null)}
          onNotify={onNotify}
        />
      )}

      {zoom && (
        <ImageLightbox
          src={zoom.url}
          alt={t('referenceImageAlt', { name: zoom.name })}
          downloadHref={zoom.url}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  )
}
