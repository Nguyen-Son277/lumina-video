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
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react'
import { characterApi } from '../api/endpoints'
import type { CharacterInput, ProjectCharacter } from '../api/projectTypes'
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

  async function remove(character: ProjectCharacter) {
    setBusy(character.id)
    setError(null)
    try {
      await characterApi.remove(character.id)
      setCharacters((current) => current.filter((item) => item.id !== character.id))
      onNotify(notification('characters', 'notifyCharacterDeleted'))
    } catch (cause) {
      setError(describeCharactersError(cause))
    } finally {
      setBusy('')
    }
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
                <p>{character.appearance || t('appearanceEmpty')}</p>
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
