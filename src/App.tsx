import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { errorMessage } from './api/client'
import { authApi, generationApi, modelApi, providerApi } from './api/endpoints'
import type { Generation, ImageApiStyle, ModelInfo, ModelKind, Mode, Provider, User } from './api/types'
import { AuthPage } from './components/AuthPage'
import { Sidebar, Topbar, type Page } from './components/Sidebar'

/** Khoá localStorage cho trạng thái thu gọn của sidebar desktop. */
const SIDEBAR_KEY = 'lumina.sidebar'
import { Toast } from './components/Common'
import { StudioPage } from './pages/StudioPage'
const ProjectStudio = lazy(() => import('./pages/ProjectStudio').then(module => ({ default: module.ProjectStudio })))
const CharactersPage = lazy(() => import('./pages/CharactersPage').then(module => ({ default: module.CharactersPage })))
const PlannerPage = lazy(() => import('./pages/PlannerPage').then(module => ({ default: module.PlannerPage })))
const TimelineBoardPage = lazy(() => import('./pages/TimelineBoardPage').then(module => ({ default: module.TimelineBoardPage })))
import { LibraryPage } from './pages/LibraryPage'
import { ModelModal, ProviderModal, SettingsPage } from './pages/SettingsPage'

/** Các trang hợp lệ trong URL; dùng để khôi phục sau khi tải lại. */
const PAGES: Page[] = ['quick', 'studio', 'characters', 'library', 'planner', 'timeline', 'settings']

/** Đọc trang + phiên kịch bản đang xem từ URL (màn hình Timeline là trang riêng). */
function readLocation(): { page: Page; session: string } {
  try {
    const params = new URLSearchParams(window.location.search)
    const page = params.get('page')
    return {
      page: PAGES.includes(page as Page) ? (page as Page) : 'studio',
      session: params.get('session') ?? '',
    }
  } catch {
    return { page: 'studio', session: '' }
  }
}

/** Khoảng thời gian làm mới danh sách khi còn tác vụ đang chạy. */
const ACTIVE_POLL_MS = 2000
const IDLE_POLL_MS = 15000

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [booting, setBooting] = useState(true)
  const [page, setPage] = useState<Page>(() => readLocation().page)
  /** Phiên Tạo kịch bản AI đang mở ở trang Timeline. */
  const [planSessionId, setPlanSessionId] = useState(() => readLocation().session)
  const [mode, setMode] = useState<Mode>('image')
  const [navOpen, setNavOpen] = useState(false)
  // Sidebar desktop thu gọn thành rail icon; nhớ lựa chọn giữa các lần tải trang.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? 'collapsed' : 'open')
    } catch {
      // Không lưu được (chế độ riêng tư) cũng không ảnh hưởng gì.
    }
  }, [sidebarCollapsed])

  // Đồng bộ trang + phiên lên URL: tải lại hoặc Back vẫn về đúng màn hình đang xem.
  const urlSynced = useRef(false)
  useEffect(() => {
    const params = new URLSearchParams()
    params.set('page', page)
    if (page === 'timeline' && planSessionId) params.set('session', planSessionId)
    const url = `${window.location.pathname}?${params.toString()}`
    if (!urlSynced.current) {
      urlSynced.current = true
      window.history.replaceState({}, '', url)
      return
    }
    window.history.pushState({}, '', url)
  }, [page, planSessionId])

  useEffect(() => {
    function onPopState(): void {
      const next = readLocation()
      setPage(next.page)
      if (next.session) setPlanSessionId(next.session)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [generations, setGenerations] = useState<Generation[]>([])
  const [loadingData, setLoadingData] = useState(false)

  const [showProviderModal, setShowProviderModal] = useState(false)
  const [showModelModal, setShowModelModal] = useState(false)
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
    const [providerResult, modelResult, generationResult] = await Promise.all([
      providerApi.list(),
      modelApi.list(),
      generationApi.list(),
    ])
    setProviders(providerResult.providers)
    setModels(modelResult.models)
    setGenerations(generationResult.generations)
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

  /** Model văn bản đang bật, dùng cho Tạo kịch bản AI và tạo nhân vật bằng AI. */
  const llmModels = useMemo(
    () => models.filter((model) => model.kind === 'llm' && model.enabled),
    [models],
  )

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
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
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
            <CharactersPage
              llmModels={llmModels}
              models={models}
              onNotify={notify}
              onOpenSettings={() => setPage('settings')}
            />
          </Suspense>
        )}

        {page === 'planner' && (
          <Suspense fallback={<div className="empty-state">Đang tải Tạo kịch bản AI…</div>}>
            <PlannerPage
              llmModels={llmModels}
              models={models}
              onNotify={notify}
              onOpenSettings={() => setPage('settings')}
              onOpenProject={() => setPage('studio')}
              onProjectsChanged={loadAll}
              onOpenTimeline={(sessionId) => {
                setPlanSessionId(sessionId)
                setPage('timeline')
              }}
            />
          </Suspense>
        )}

        {page === 'timeline' && (
          <Suspense fallback={<div className="empty-state">Đang tải Timeline…</div>}>
            <TimelineBoardPage
              sessionId={planSessionId}
              llmModels={llmModels}
              models={models}
              onNotify={notify}
              onSelectSession={setPlanSessionId}
              onBackToChat={(sessionId) => {
                setPlanSessionId(sessionId)
                setPage('planner')
              }}
              onOpenSettings={() => setPage('settings')}
              onOpenProject={() => setPage('studio')}
              onProjectsChanged={loadAll}
            />
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
            onAddProvider={() => {
              setModalError('')
              setShowProviderModal(true)
            }}
            onAddModel={() => {
              setModalError('')
              setShowModelModal(true)
            }}
            onRemoveProvider={removeProvider}
            onUpdateProvider={updateProvider}
            onRemoveModel={removeModel}
            onUpdateModel={updateModel}
            onTest={testProvider}
            onSync={syncModels}
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


      <Toast message={toast} />
    </div>
  )
}
