import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { errorMessage } from './api/client'
import { authApi, generationApi, llmApi, modelApi, providerApi } from './api/endpoints'
import type { Generation, ImageApiStyle, LlmConnection, ModelInfo, ModelKind, Mode, Provider, User } from './api/types'
import { AuthPage } from './components/AuthPage'
import { Sidebar, Topbar, type Page } from './components/Sidebar'
import { Toast } from './components/Common'
import { StudioPage } from './pages/StudioPage'
const ProjectStudio = lazy(() => import('./pages/ProjectStudio').then(module => ({ default: module.ProjectStudio })))
const CharactersPage = lazy(() => import('./pages/CharactersPage').then(module => ({ default: module.CharactersPage })))
import { LibraryPage } from './pages/LibraryPage'
import { LlmModal, ModelModal, ProviderModal, SettingsPage } from './pages/SettingsPage'

/** Khoảng thời gian làm mới danh sách khi còn tác vụ đang chạy. */
const ACTIVE_POLL_MS = 2000
const IDLE_POLL_MS = 15000

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [booting, setBooting] = useState(true)
  const [page, setPage] = useState<Page>('studio')
  const [mode, setMode] = useState<Mode>('image')
  const [navOpen, setNavOpen] = useState(false)

  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [llmConnections, setLlmConnections] = useState<LlmConnection[]>([])
  const [generations, setGenerations] = useState<Generation[]>([])
  const [loadingData, setLoadingData] = useState(false)

  const [showProviderModal, setShowProviderModal] = useState(false)
  const [showModelModal, setShowModelModal] = useState(false)
  const [showLlmModal, setShowLlmModal] = useState(false)
  const [modalBusy, setModalBusy] = useState(false)
  const [modalError, setModalError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)

  const notify = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3600)
  }, [])

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  /** Tải provider, model, kết nối LLM và lịch sử tạo nội dung của người dùng hiện tại. */
  const loadAll = useCallback(async () => {
    const [providerResult, modelResult, generationResult, llmResult] = await Promise.all([
      providerApi.list(),
      modelApi.list(),
      generationApi.list(),
      llmApi.list(),
    ])
    setProviders(providerResult.providers)
    setModels(modelResult.models)
    setGenerations(generationResult.generations)
    setLlmConnections(llmResult.connections)
  }, [])

  // Kiểm tra phiên đăng nhập khi mở ứng dụng.
  useEffect(() => {
    let cancelled = false
    authApi
      .me()
      .then((result) => {
        if (!cancelled) setUser(result.user)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setBooting(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Tải dữ liệu sau khi đăng nhập.
  useEffect(() => {
    if (!user) {
      setProviders([])
      setModels([])
      setLlmConnections([])
      setGenerations([])
      return
    }
    let cancelled = false
    setLoadingData(true)
    loadAll()
      .catch((cause: unknown) => {
        if (!cancelled) notify(errorMessage(cause))
      })
      .finally(() => {
        if (!cancelled) setLoadingData(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, loadAll, notify])

  const hasActive = useMemo(
    () =>
      generations.some(
        (item) => item.status === 'queued' || item.status === 'running' || item.status === 'downloading',
      ),
    [generations],
  )

  // Làm mới danh sách để cập nhật tiến trình; nhanh hơn khi có tác vụ đang chạy.
  useEffect(() => {
    if (!user) return
    let cancelled = false

    const interval = window.setInterval(
      () => {
        generationApi
          .list()
          .then((result) => {
            if (!cancelled) setGenerations(result.generations)
          })
          .catch(() => {
            // Bỏ qua lỗi tạm thời khi làm mới nền.
          })
      },
      hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    )

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [user, hasActive])

  async function handleLogout() {
    try {
      await authApi.logout()
    } catch {
      // Dù lỗi vẫn đưa người dùng về trạng thái chưa đăng nhập.
    }
    setUser(null)
    setPage('studio')
  }

  async function createProvider(draft: {
    name: string
    baseUrl: string
    apiKey: string
    imageApiStyle: ImageApiStyle
  }) {
    setModalBusy(true)
    setModalError('')
    try {
      const result = await providerApi.create(draft)
      setProviders((current) => [...current, result.provider])
      setShowProviderModal(false)
      notify('Đã thêm provider. Hãy bấm Đồng bộ hoặc thêm model thủ công.')
    } catch (cause) {
      setModalError(errorMessage(cause))
    } finally {
      setModalBusy(false)
    }
  }

  async function createModel(draft: {
    providerId: string
    modelId: string
    displayName: string
    kind: ModelKind
  }) {
    setModalBusy(true)
    setModalError('')
    try {
      const result = await modelApi.create({
        providerId: draft.providerId,
        modelId: draft.modelId,
        displayName: draft.displayName || undefined,
        kind: draft.kind,
      })
      setModels((current) => [...current, result.model])
      setProviders((current) =>
        current.map((provider) =>
          provider.id === draft.providerId
            ? { ...provider, modelCount: provider.modelCount + 1 }
            : provider,
        ),
      )
      setShowModelModal(false)
      notify('Đã thêm model.')
    } catch (cause) {
      setModalError(errorMessage(cause))
    } finally {
      setModalBusy(false)
    }
  }

  async function updateProvider(id: string, patch: { imageApiStyle: ImageApiStyle }) {
    setBusyId(id)
    try {
      const result = await providerApi.update(id, patch)
      setProviders((current) =>
        current.map((provider) => (provider.id === id ? result.provider : provider)),
      )
      notify(
        patch.imageApiStyle === 'extra_body'
          ? 'Đã đổi sang kiểu ảnh nguồn trong extra_body (Agnes).'
          : 'Đã đổi sang kiểu API ảnh chuẩn OpenAI.',
      )
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function removeProvider(id: string) {
    setBusyId(id)
    try {
      await providerApi.remove(id)
      setProviders((current) => current.filter((provider) => provider.id !== id))
      setModels((current) => current.filter((model) => model.providerId !== id))
      notify('Đã xóa provider và các model liên quan.')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function removeModel(id: string) {
    setBusyId(id)
    try {
      await modelApi.remove(id)
      setModels((current) => current.filter((model) => model.id !== id))
      notify('Đã xóa model.')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function updateModel(id: string, patch: { kind?: ModelKind; enabled?: boolean }) {
    setBusyId(id)
    try {
      const result = await modelApi.update(id, patch)
      setModels((current) => current.map((model) => (model.id === id ? result.model : model)))
      notify('Đã cập nhật phân loại model.')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function testProvider(id: string) {
    setBusyId(id)
    try {
      const result = await providerApi.test(id)
      setProviders((current) =>
        current.map((provider) =>
          provider.id === id ? { ...provider, status: 'connected', lastError: null } : provider,
        ),
      )
      notify(`Kết nối thành công. Provider có ${result.modelCount} model.`)
    } catch (cause) {
      const message = errorMessage(cause)
      setProviders((current) =>
        current.map((provider) =>
          provider.id === id ? { ...provider, status: 'error', lastError: message } : provider,
        ),
      )
      notify(message)
    } finally {
      setBusyId(null)
    }
  }

  async function syncModels(id: string) {
    setBusyId(id)
    try {
      const result = await providerApi.syncModels(id)
      const [modelResult, providerResult] = await Promise.all([modelApi.list(), providerApi.list()])
      setModels(modelResult.models)
      setProviders(providerResult.providers)
      notify(`Đồng bộ xong: thêm ${result.added} model mới, bỏ qua ${result.skipped} model đã có.`)
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  /** Kết nối LLM dùng cho chat và tạo kịch bản ở giai đoạn sau. */
  async function createLlmConnection(draft: {
    name?: string
    baseUrl: string
    modelId: string
    apiKey: string
  }) {
    setModalBusy(true)
    setModalError('')
    try {
      const result = await llmApi.create(draft)
      setLlmConnections((current) => [...current, result.connection])
      setShowLlmModal(false)
      notify('Đã lưu kết nối LLM. Bấm Kiểm tra để xác nhận key hoạt động.')
    } catch (cause) {
      setModalError(errorMessage(cause))
    } finally {
      setModalBusy(false)
    }
  }

  async function removeLlmConnection(id: string) {
    setBusyId(id)
    try {
      await llmApi.remove(id)
      setLlmConnections((current) => current.filter((connection) => connection.id !== id))
      notify('Đã xóa kết nối LLM.')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function updateLlmModel(id: string, modelId: string) {
    setBusyId(id)
    try {
      const result = await llmApi.update(id, { modelId })
      setLlmConnections((current) =>
        current.map((connection) => (connection.id === id ? result.connection : connection)),
      )
      notify(`Đã đặt model chat: ${modelId}`)
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function testLlmConnection(id: string) {
    setBusyId(id)
    try {
      const result = await llmApi.test(id)
      setLlmConnections((current) =>
        current.map((connection) =>
          connection.id === id ? { ...connection, status: 'connected', lastError: null } : connection,
        ),
      )
      notify(`Kết nối LLM thành công. Provider có ${result.modelCount} model.`)
    } catch (cause) {
      const message = errorMessage(cause)
      setLlmConnections((current) =>
        current.map((connection) =>
          connection.id === id
            ? { ...connection, status: 'error', lastError: message }
            : connection,
        ),
      )
      notify(message)
    } finally {
      setBusyId(null)
    }
  }

  async function removeGeneration(id: string) {
    setBusyId(id)
    try {
      await generationApi.remove(id)
      setGenerations((current) => current.filter((item) => item.id !== id))
      notify('Đã xóa khỏi thư viện.')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function retryDownload(id: string) {
    setBusyId(id)
    try {
      const result = await generationApi.retryDownload(id)
      setGenerations((current) => current.map((item) => (item.id === id ? result.generation : item)))
      notify('Đang thử tải lại kết quả từ provider.')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  if (booting) {
    return (
      <div className="boot-screen">
        <LoaderCircle size={26} className="spin" />
        <span>Đang kiểm tra phiên đăng nhập...</span>
      </div>
    )
  }

  if (!user) {
    return <AuthPage onAuthenticated={setUser} />
  }

  return (
    <div className="app-shell">
      <Sidebar
        page={page}
        user={user}
        creationCount={generations.length}
        open={navOpen}
        onNavigate={(next) => {
          setPage(next)
          setNavOpen(false)
        }}
        onLogout={handleLogout}
      />

      <main className="main-area">
        <Topbar page={page} onToggleNav={() => setNavOpen((open) => !open)} onNotify={notify} />

        {page === 'studio' && (
          <Suspense fallback={<div className="empty-state">Đang tải Studio dự án…</div>}>
            <ProjectStudio
              models={models}
              onOpenSettings={() => setPage('settings')}
              onNotify={notify}
              onCreated={(generation) => setGenerations((current) => [generation, ...current])}
            />
          </Suspense>
        )}

        {page === 'characters' && (
          <Suspense fallback={<div className="empty-state">Đang tải thư viện nhân vật…</div>}>
            <CharactersPage onNotify={notify} />
          </Suspense>
        )}

        {page === 'quick' && (
          <StudioPage
            mode={mode}
            onModeChange={setMode}
            models={models}
            creations={generations}
            loading={loadingData}
            onCreated={(generation) => setGenerations((current) => [generation, ...current])}
            onDelete={removeGeneration}
            busyId={busyId}
            onNavigate={setPage}
            onNotify={notify}
          />
        )}

        {page === 'library' && (
          <LibraryPage
            generations={generations}
            loading={loadingData}
            onDelete={removeGeneration}
            onRetry={retryDownload}
            onCreate={() => setPage('studio')}
            busyId={busyId}
          />
        )}

        {page === 'settings' && (
          <SettingsPage
            providers={providers}
            models={models}
            llmConnections={llmConnections}
            onAddProvider={() => {
              setModalError('')
              setShowProviderModal(true)
            }}
            onAddModel={() => {
              setModalError('')
              setShowModelModal(true)
            }}
            onAddLlm={() => {
              setModalError('')
              setShowLlmModal(true)
            }}
            onRemoveProvider={removeProvider}
            onUpdateProvider={updateProvider}
            onRemoveModel={removeModel}
            onUpdateModel={updateModel}
            onTest={testProvider}
            onSync={syncModels}
            onRemoveLlm={removeLlmConnection}
            onTestLlm={testLlmConnection}
            onUpdateLlmModel={updateLlmModel}
            onNotifyLlm={notify}
            busyId={busyId}
          />
        )}
      </main>

      {showProviderModal && (
        <ProviderModal
          onClose={() => setShowProviderModal(false)}
          onSave={createProvider}
          busy={modalBusy}
          error={modalError}
        />
      )}

      {showModelModal && (
        <ModelModal
          providers={providers}
          onClose={() => setShowModelModal(false)}
          onSave={createModel}
          onNeedProvider={() => {
            setShowModelModal(false)
            setShowProviderModal(true)
          }}
          busy={modalBusy}
          error={modalError}
        />
      )}

      {showLlmModal && (
        <LlmModal
          onClose={() => setShowLlmModal(false)}
          onSave={createLlmConnection}
          busy={modalBusy}
          error={modalError}
        />
      )}

      <Toast message={toast} />
    </div>
  )
}
