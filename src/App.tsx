import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { errorMessage } from './api/client'
import { authApi, generationApi, modelApi, providerApi } from './api/endpoints'
import type { Generation, ImageApiStyle, ModelInfo, ModelKind, Mode, Provider, User } from './api/types'
import { AuthPage } from './components/AuthPage'
import { Sidebar, Topbar, type Page } from './components/Sidebar'
import { useTranslation, translate, type MessageParams } from './i18n'
import { shellCatalog, type ShellCatalogKey } from './i18n/catalogs/shell'
import { usageCatalog } from './i18n/catalogs/usage'
import {
  notification,
  notificationText,
  type Notification,
} from './i18n/messages'

/** Khoá localStorage cho trạng thái thu gọn của sidebar desktop. */
const SIDEBAR_KEY = 'lumina.sidebar'
import { Toast } from './components/Common'
import { StudioPage } from './pages/StudioPage'
const ProjectStudio = lazy(() => import('./pages/ProjectStudio').then(module => ({ default: module.ProjectStudio })))
const CharactersPage = lazy(() => import('./pages/CharactersPage').then(module => ({ default: module.CharactersPage })))
const PlannerCharactersPage = lazy(() => import('./pages/PlannerCharactersPage').then(module => ({ default: module.PlannerCharactersPage })))
const PlannerPage = lazy(() => import('./pages/PlannerPage').then(module => ({ default: module.PlannerPage })))
const TimelineBoardPage = lazy(() => import('./pages/TimelineBoardPage').then(module => ({ default: module.TimelineBoardPage })))
const UsagePage = lazy(() => import('./pages/UsagePage').then(module => ({ default: module.UsagePage })))
import { LibraryPage } from './pages/LibraryPage'
import { ModelModal, ProviderModal, SettingsPage } from './pages/SettingsPage'
import { AdminUsersPage } from './pages/AdminUsersPage'

/** Các trang hợp lệ trong URL; dùng để khôi phục sau khi tải lại. */
const PAGES: Page[] = ['quick', 'studio', 'characters', 'library', 'planner', 'planner-characters', 'timeline', 'usage', 'settings']

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

/**
 * Nội dung toast:
 * - `notification`: descriptor do ứng dụng sở hữu (dịch lại theo ngôn ngữ hiện tại)
 *   hoặc chuỗi thô từ AI/người dùng/provider (luôn giữ nguyên văn).
 * - `error`: lỗi gốc chưa dịch — `errorMessage` chỉ được gọi lúc render nên đổi ngôn ngữ
 *   là câu lỗi đổi theo.
 */
type ToastContent =
  | { kind: 'notification'; message: Notification }
  | { kind: 'error'; error: unknown }

export default function App() {
  const { t, locale } = useTranslation(shellCatalog)
  const [user, setUser] = useState<User | null>(null)
  const [booting, setBooting] = useState(true)
  const characterNavigationGuard = useRef<((action: () => void) => void) | null>(null)
  const registerCharacterGuard = useCallback((guard: ((action: () => void) => void) | null) => { characterNavigationGuard.current = guard }, [])
  const guardedNavigate = useCallback((action: () => void) => { if (characterNavigationGuard.current) characterNavigationGuard.current(action); else action() }, [])
  const [page, setPage] = useState<Page>(() => readLocation().page)
  /** Phiên Tạo kịch bản AI đang mở ở trang Timeline. */
  const [planSessionId, setPlanSessionId] = useState(() => readLocation().session)
  /**
   * Tab đang mở của API & Models.
   *
   * Mặc định là Providers; lối tắt từ trang Nhật ký sử dụng mở thẳng Model catalog
   * vì đơn giá model được nhập ở đó.
   */
  const [settingsTab, setSettingsTab] = useState<'providers' | 'models'>('providers')
  const pageRef = useRef(page)
  const sessionIdRef = useRef(planSessionId)
  pageRef.current = page; sessionIdRef.current = planSessionId
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
    if (['planner', 'timeline', 'planner-characters'].includes(page) && planSessionId) params.set('session', planSessionId)
    const url = `${window.location.pathname}?${params.toString()}`
    if (!urlSynced.current) {
      urlSynced.current = true
      window.history.replaceState({}, '', url)
      return
    }
    if (window.location.search !== `?${params.toString()}`) window.history.pushState({}, '', url)
  }, [page, planSessionId])

  useEffect(() => {
    function onPopState(): void {
      const next = readLocation()
      const apply = () => { setPage(next.page); setPlanSessionId(next.session) }
      if (characterNavigationGuard.current) {
        const current = new URLSearchParams(); current.set('page', pageRef.current); if (sessionIdRef.current) current.set('session', sessionIdRef.current)
        window.history.pushState({}, '', `${window.location.pathname}?${current}`)
        characterNavigationGuard.current(apply)
      } else apply()
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
  /** Lỗi gốc (chưa dịch) của modal; dịch ở bước render để đổi ngôn ngữ là đổi ngay. */
  const [modalError, setModalError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [toast, setToast] = useState<ToastContent | null>(null)
  const toastTimer = useRef<number | null>(null)

  const showToast = useCallback((next: ToastContent) => {
    setToast(next)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3600)
  }, [])

  /**
   * Thông báo từ component con: descriptor tường minh (câu do ứng dụng sở hữu) hoặc
   * chuỗi thô (AI/người dùng/provider). Chuỗi luôn giữ nguyên văn — không đoán ngược
   * thành khoá catalog, kể cả khi trùng khít một câu dịch.
   */
  const notify = useCallback(
    (message: Notification) => showToast({ kind: 'notification', message }),
    [showToast],
  )

  /** Lỗi do App sở hữu: giữ nguyên đối tượng lỗi, chỉ dịch khi render theo ngôn ngữ hiện tại. */
  const notifyError = useCallback(
    (error: unknown) => showToast({ kind: 'error', error }),
    [showToast],
  )

  /** Thông báo do App sở hữu bằng khoá shell: lưu namespace + khoá + tham số để dịch lại. */
  const notifyKey = useCallback(
    (key: ShellCatalogKey, params?: MessageParams) =>
      showToast({ kind: 'notification', message: notification('shell', key, params) }),
    [showToast],
  )

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
        if (!cancelled) notifyError(cause)
      })
      .finally(() => {
        if (!cancelled) setLoadingData(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, loadAll, notifyError])

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
    setModalError(null)
    try {
      const result = await providerApi.create(draft)
      setProviders((current) => [...current, result.provider])
      setShowProviderModal(false)
      notifyKey('toastProviderAdded')
    } catch (cause) {
      setModalError(cause)
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
    setModalError(null)
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
      notifyKey('toastModelAdded')
    } catch (cause) {
      setModalError(cause)
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
      notifyKey(
        patch.imageApiStyle === 'extra_body'
          ? 'toastImageStyleExtraBody'
          : 'toastImageStyleOpenai',
      )
    } catch (cause) {
      notifyError(cause)
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
      notifyKey('toastProviderRemoved')
    } catch (cause) {
      notifyError(cause)
    } finally {
      setBusyId(null)
    }
  }

  async function removeModel(id: string) {
    setBusyId(id)
    try {
      await modelApi.remove(id)
      setModels((current) => current.filter((model) => model.id !== id))
      notifyKey('toastModelRemoved')
    } catch (cause) {
      notifyError(cause)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Cập nhật model: phân loại và/hoặc đơn giá.
   *
   * Trả `true` khi lưu xong để hàng model trong Model catalog biết mà hiện trạng
   * thái "Đã lưu" thay vì đoán theo state; lỗi vẫn báo toast như trước.
   */
  async function updateModel(
    id: string,
    patch: {
      kind?: ModelKind
      enabled?: boolean
      priceUnit?: number | null
      priceInput1k?: number | null
      priceOutput1k?: number | null
      priceCurrency?: string
    },
  ): Promise<boolean> {
    setBusyId(id)
    try {
      const result = await modelApi.update(id, patch)
      setModels((current) => current.map((model) => (model.id === id ? result.model : model)))
      notifyKey('toastModelUpdated')
      return true
    } catch (cause) {
      notifyError(cause)
      return false
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
      notifyKey('toastProviderConnected', { count: result.modelCount })
    } catch (cause) {
      const message = errorMessage(cause)
      setProviders((current) =>
        current.map((provider) =>
          provider.id === id ? { ...provider, status: 'error', lastError: message } : provider,
        ),
      )
      notifyError(cause)
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
      notifyKey('toastSyncDone', { added: result.added, skipped: result.skipped })
    } catch (cause) {
      notifyError(cause)
    } finally {
      setBusyId(null)
    }
  }

  async function removeGeneration(id: string) {
    setBusyId(id)
    try {
      await generationApi.remove(id)
      setGenerations((current) => current.filter((item) => item.id !== id))
      notifyKey('toastGenerationRemoved')
    } catch (cause) {
      notifyError(cause)
    } finally {
      setBusyId(null)
    }
  }

  async function retryDownload(id: string) {
    setBusyId(id)
    try {
      const result = await generationApi.retryDownload(id)
      setGenerations((current) => current.map((item) => (item.id === id ? result.generation : item)))
      notifyKey('toastRetryingDownload')
    } catch (cause) {
      notifyError(cause)
    } finally {
      setBusyId(null)
    }
  }

  // Dịch nội dung toast theo ngôn ngữ hiện tại: descriptor tra catalog, chuỗi thô giữ
  // nguyên; lỗi gọi `errorMessage` tại chỗ.
  const toastText =
    toast === null
      ? ''
      : toast.kind === 'error'
        ? errorMessage(toast.error)
        : notificationText(toast.message, locale)

  if (booting) {
    return (
      <div className="boot-screen">
        <LoaderCircle size={26} className="spin" />
        <span>{t('bootCheckingSession')}</span>
      </div>
    )
  }

  if (!user) {
    return <AuthPage onAuthenticated={setUser} />
  }

  // Super admin dùng vỏ riêng: chỉ duyệt tài khoản, không có tính năng tạo nội dung.
  // Kiểm ở đây (không phải theo `page`) nên URL `?page=studio` cũng không mở được Studio.
  if (user.role === 'admin') {
    return <AdminUsersPage user={user} onLogout={handleLogout} />
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
          guardedNavigate(() => {
            // Bấm thẳng mục API & Models thì vào tab Providers như trước.
            if (next === 'settings') setSettingsTab('providers')
            setPage(next)
            setNavOpen(false)
          })
        }}
        onLogout={handleLogout}
      />

      <main className="main-area">
        <Topbar page={page} onToggleNav={() => setNavOpen((open) => !open)} onNotify={notify} />

        {page === 'studio' && (
          <Suspense fallback={<div className="empty-state">{t('loadingProjectStudio')}</div>}>
            <ProjectStudio
              models={models}
              onOpenSettings={() => setPage('settings')}
              onNotify={notify}
              onCreated={(generation) => setGenerations((current) => [generation, ...current])}
            />
          </Suspense>
        )}

        {page === 'characters' && (
          <Suspense fallback={<div className="empty-state">{t('loadingCharacters')}</div>}>
            <CharactersPage
              llmModels={llmModels}
              models={models}
              onNotify={notify}
              onOpenSettings={() => setPage('settings')}
            />
          </Suspense>
        )}

        {page === 'planner' && (
          <Suspense fallback={<div className="empty-state">{t('loadingPlanner')}</div>}>
            <PlannerPage
              sessionId={planSessionId}
              onSelectSession={setPlanSessionId}
              onOpenCharacters={(id) => { setPlanSessionId(id); setPage('planner-characters') }}
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

        {page === 'planner-characters' && (
          <Suspense fallback={<div className="empty-state">{t('loadingCharacters')}</div>}>
            <PlannerCharactersPage onRegisterNavigationGuard={registerCharacterGuard} sessionId={planSessionId} onSelectSession={setPlanSessionId} onNotify={notify}
              onBackToChat={(id) => { setPlanSessionId(id); setPage('planner') }}
              onOpenTimeline={(id) => { setPlanSessionId(id); setPage('timeline') }} />
          </Suspense>
        )}

        {page === 'timeline' && (
          <Suspense fallback={<div className="empty-state">{t('loadingTimeline')}</div>}>
            <TimelineBoardPage
              onOpenCharacters={(id) => { setPlanSessionId(id); setPage('planner-characters') }}
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

        {page === 'usage' && (
          <Suspense fallback={<div className="empty-state">{translate(usageCatalog, 'loading', undefined, locale)}</div>}>
            <UsagePage onOpenModelCatalog={() => { setSettingsTab('models'); setPage('settings') }} />
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
              setModalError(null)
              setShowProviderModal(true)
            }}
            onAddModel={() => {
              setModalError(null)
              setShowModelModal(true)
            }}
            onRemoveProvider={removeProvider}
            onUpdateProvider={updateProvider}
            onRemoveModel={removeModel}
            onUpdateModel={updateModel}
            onTest={testProvider}
            onSync={syncModels}
            onProvidersChanged={() => { void loadAll() }}
            onNotify={notify}
            onNotifyError={notifyError}
            busyId={busyId}
            initialTab={settingsTab}
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


      <Toast message={toastText} />
    </div>
  )
}
