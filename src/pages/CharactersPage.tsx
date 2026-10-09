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
import { errorMessage } from '../api/client'
import { characterApi } from '../api/endpoints'
import type { CharacterInput, ProjectCharacter } from '../api/projectTypes'
import type { LlmConnection, ModelInfo } from '../api/types'
import { CharacterAiModal } from '../components/CharacterAiModal'
import { CharacterForm } from '../components/CharacterForm'
import { CharacterIllustrateModal } from '../components/CharacterIllustrateModal'
import { CharacterPromptModal } from '../components/CharacterPromptModal'
import { ImageLightbox } from '../components/Lightbox'

const VOICE_SUMMARY: Array<{ key: keyof ProjectCharacter['voice']; label: string }> = [
  { key: 'accent', label: 'Giọng' },
  { key: 'pitch', label: 'Cao độ' },
  { key: 'timbre', label: 'Âm sắc' },
  { key: 'pace', label: 'Tốc độ' },
]

/**
 * Thư viện nhân vật dùng chung.
 *
 * Nhân vật tạo ở đây thuộc tài khoản, không thuộc dự án nào, nên dùng được cho
 * cả "Tạo nội dung đơn lẻ" lẫn mọi dự án trong Studio.
 */
export function CharactersPage({ llmConnections, models, onNotify, onOpenSettings }: {
  llmConnections: LlmConnection[]
  /** Model tạo ảnh hiện có, dùng cho minh hoạ nhân vật. */
  models: ModelInfo[]
  onNotify: (message: string) => void
  onOpenSettings: () => void
}) {
  const [characters, setCharacters] = useState<ProjectCharacter[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<ProjectCharacter | 'new' | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [illustrateFor, setIllustrateFor] = useState<ProjectCharacter | null>(null)
  const [promptFor, setPromptFor] = useState<ProjectCharacter | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
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
        if (alive) setError(errorMessage(cause))
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
    setError('')
    try {
      await load()
      onNotify('Đã làm mới thư viện nhân vật.')
    } catch (cause) {
      setError(errorMessage(cause))
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

    onNotify(editing ? 'Đã cập nhật nhân vật.' : 'Đã thêm nhân vật vào thư viện.')
  }

  async function remove(character: ProjectCharacter) {
    setBusy(character.id)
    setError('')
    try {
      await characterApi.remove(character.id)
      setCharacters((current) => current.filter((item) => item.id !== character.id))
      onNotify('Đã xóa nhân vật khỏi thư viện.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="page-content characters-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> Character library</div>
          <h1>Nhân vật <em>dùng chung.</em></h1>
          <p>
            Tạo nhân vật và ảnh tham chiếu một lần, rồi dùng lại ở mọi dự án và ở trang tạo
            nội dung đơn lẻ.
          </p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" disabled={!!busy || loading} onClick={() => void refresh()}>
            <RefreshCw size={15} /> Làm mới
          </button>
          <button className="secondary-button" onClick={() => setAiOpen(true)}>
            <BrainCircuit size={15} /> AI tạo nhân vật
          </button>
          <button className="primary-small-button" onClick={() => setModal('new')}>
            <Plus size={16} /> Tạo nhân vật
          </button>
        </div>
      </section>

      {error && <div className="form-error" role="alert">{error}</div>}

      {loading ? (
        <div className="empty-state"><LoaderCircle size={24} className="spin" /><h3>Đang tải nhân vật…</h3></div>
      ) : characters.length ? (
        <div className="character-library-grid">
          {characters.map((character) => (
            <article className="character-library-card" key={character.id}>
              <div className="character-library-media">
                {character.referenceUrl ? (
                  <button
                    type="button"
                    className="creation-zoom"
                    aria-label={`Xem ảnh tham chiếu của ${character.name}`}
                    title="Bấm để xem chi tiết"
                    onClick={() =>
                      setZoom({ url: character.referenceUrl!, name: character.name })
                    }
                  >
                    <img src={character.referenceUrl} alt={`Ảnh tham chiếu của ${character.name}`} loading="lazy" />
                  </button>
                ) : (
                  <div className="character-library-placeholder">
                    <ImageIcon size={24} />
                    <span>Chưa có ảnh tham chiếu</span>
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
                <p>{character.appearance || 'Chưa mô tả ngoại hình.'}</p>
                <div className="character-library-tags">
                  {VOICE_SUMMARY.filter(({ key }) => character.voice?.[key]).map(({ key, label }) => (
                    <span key={key}>{label}: {character.voice[key]}</span>
                  ))}
                  {!VOICE_SUMMARY.some(({ key }) => character.voice?.[key]) && (
                    <span>Chưa có hồ sơ giọng</span>
                  )}
                </div>
              </div>

              <div className="character-library-actions">
                <button
                  className="secondary-button"
                  disabled={busy === character.id}
                  onClick={() => setModal(character)}
                >
                  <Pencil size={14} /> Sửa
                </button>
                <button
                  className="secondary-button"
                  disabled={busy === character.id}
                  onClick={() => setIllustrateFor(character)}
                  title="Tạo ảnh tham chiếu bằng model tạo ảnh"
                >
                  <ImagePlus size={14} /> Minh hoạ
                </button>
                <button
                  className="secondary-button"
                  disabled={busy === character.id}
                  onClick={() => setPromptFor(character)}
                  title="Xem và sao chép prompt của nhân vật"
                >
                  <Copy size={14} /> Prompt
                </button>
                <button
                  className="row-more"
                  disabled={busy === character.id}
                  onClick={() => void remove(character)}
                  aria-label={`Xóa ${character.name}`}
                  title="Xóa nhân vật"
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
          <h3>Thư viện nhân vật đang trống</h3>
          <p>Thêm nhân vật kèm ảnh tham chiếu để giữ nhận diện nhất quán giữa các lần tạo.</p>
          <button className="primary-small-button" onClick={() => setModal('new')}>
            <Sparkles size={15} /> Tạo nhân vật đầu tiên
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
          connections={llmConnections}
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
          alt={`Ảnh tham chiếu của ${zoom.name}`}
          downloadHref={zoom.url}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  )
}
