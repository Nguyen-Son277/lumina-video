import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { LoaderCircle } from 'lucide-react'
import { errorMessage } from './api/client'
import { authApi, generationApi, modelApi, providerApi } from './api/endpoints'
import type { EntityLibraryEntity } from './api/entityLibrary'
import { readEntityLibraryLocation, writeEntityLibraryLocation, type EntityLibraryFilter, type SelectedEntityRef } from './entityLibraryLocation'
import type { Generation, ImageApiStyle, ModelInfo, ModelKind, Mode, Provider, User, VideoReferenceStyle } from './api/types'
import { AuthPage } from './components/AuthPage'
import { ImageCharacterProvider } from './components/ImageCharacterBridge'
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
import { LoadingState } from './components/ui'
import { QuickPage } from './pages/QuickPage'
import { resolveDocsArticle } from './docs/navigation'
// Fetch the renderer and bilingual content together only when Docs is opened.
const DocsContent = lazy(async () => {
  const [{ DocsPage }, { docsArticles }] = await Promise.all([import('./pages/DocsPage'), import('./docs/content')])
  return { default: (props: Omit<ComponentProps<typeof DocsPage>, 'articles'>) => <DocsPage {...props} articles={docsArticles} /> }
})
const ProjectStudio = lazy(() => import('./pages/ProjectStudio').then(module => ({ default: module.ProjectStudio })))
const PlannerCharactersPage = lazy(() => import('./pages/PlannerCharactersPage').then(module => ({ default: module.PlannerCharactersPage })))
const PlannerPage = lazy(() => import('./pages/PlannerPage').then(module => ({ default: module.PlannerPage })))
const TimelineBoardPage = lazy(() => import('./pages/TimelineBoardPage').then(module => ({ default: module.TimelineBoardPage })))
const UsagePage = lazy(() => import('./pages/UsagePage').then(module => ({ default: module.UsagePage })))
const TrashPage = lazy(() => import('./pages/TrashPage').then(module => ({ default: module.TrashPage })))
const EntityLibraryPage = lazy(() => import('./pages/EntityLibraryPage').then(module => ({ default: module.EntityLibraryPage })))
import { LibraryPage } from './pages/LibraryPage'
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(module => ({ default: module.SettingsPage })))
const ProviderModal = lazy(() => import('./pages/SettingsPage').then(module => ({ default: module.ProviderModal })))
const ModelModal = lazy(() => import('./pages/SettingsPage').then(module => ({ default: module.ModelModal })))
const AdminUsersPage = lazy(() => import('./pages/AdminUsersPage').then(module => ({ default: module.AdminUsersPage })))
const AdminUsagePanel = lazy(() => import('./components/AdminUsagePanel').then(module => ({ default: module.AdminUsagePanel })))
const AccountSettingsPage = lazy(() => import('./pages/AccountSettingsPage').then(module => ({ default: module.AccountSettingsPage })))

/** Các trang hợp lệ trong URL; dùng để khôi phục sau khi tải lại. */
const PAGES: Page[] = ['quick', 'studio', 'characters', 'entities', 'library', 'planner', 'planner-characters', 'timeline', 'usage', 'trash', 'settings', 'account-settings', 'admin-accounts', 'admin-usage', 'docs']

/** Đọc trang + phiên kịch bản đang xem từ URL (màn hình Timeline là trang riêng). */
function readLocation(): { page: Page; session: string } {
  try {
    const params = new URLSearchParams(window.location.search)
    const page = params.get('page')
    return {
      page: page === 'characters' ? 'entities' : PAGES.includes(page as Page) ? (page as Page) : 'studio',
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
  const [libraryLocation, setLibraryLocation] = useState(() => readEntityLibraryLocation(window.location.search))
  const libraryLocationRef = useRef(libraryLocation)
  libraryLocationRef.current = libraryLocation
  const changeLibraryLocation = useCallback((kind: EntityLibraryFilter, selectedEntity: SelectedEntityRef | null) => {
    setLibraryLocation({ kind, selectedEntity })
  }, [])
  const [docsArticleId, setDocsArticleId] = useState(() => resolveDocsArticle(new URLSearchParams(window.location.search).get('article')))
  const navigateFromDocs = (next: Page) => guardedNavigate(() => {
    if (next === 'settings') setSettingsTab('providers')
    setPage(next)
    closeNav()
  })
  useEffect(() => {
    if (!user) return
    if (user.role === 'admin' && !['admin-accounts', 'admin-usage', 'account-settings', 'docs'].includes(page)) setPage('admin-accounts')
    if (user.role !== 'admin' && page.startsWith('admin-')) setPage('studio')
  }, [user, page])
  /** Phiên Tạo kịch bản AI đang mở ở trang Timeline. */
  const [planSessionId, setPlanSessionId] = useState(() => readLocation().session)
  const [studioTarget, setStudioTarget] = useState<{ projectId: string; tab: 'canvas' } | null>(null)
  /**
   * Phiên "Tạo nội dung đơn lẻ" đang mở.
   *
   * `session` trên URL là tham số dùng chung cho cả hai loại phiên, nên state được
   * tách riêng và chỉ nạp đúng loại theo trang đang mở (tránh mở nhầm id của trang kia).
   */
  const [quickSessionId, setQuickSessionId] = useState(() =>
    readLocation().page === 'quick' ? readLocation().session : '',
  )
  const [quickGenerationId, setQuickGenerationId] = useState(() => readLocation().page === 'quick' ? new URLSearchParams(window.location.search).get('generation') ?? '' : '')
  const selectQuickSession = useCallback((id: string) => { setQuickSessionId(id); setQuickGenerationId('') }, [])
  const [quickView, setQuickView] = useState<'form' | 'canvas'>(() =>
    new URLSearchParams(window.location.search).get('view') === 'canvas' ? 'canvas' : 'form',
  )
  /**
   * Tab đang mở của API & Models.
   *
   * Mặc định là Providers; lối tắt từ trang Nhật ký sử dụng mở thẳng Model catalog
   * vì đơn giá model được nhập ở đó.
   */
  const [settingsTab, setSettingsTab] = useState<'providers' | 'models'>('providers')
  const quickViewRef = useRef(quickView)
  quickViewRef.current = quickView
  const pageRef = useRef(page)
  const sessionIdRef = useRef(planSessionId)
  pageRef.current = page
  sessionIdRef.current = page === 'quick' ? quickSessionId : planSessionId
  const [mode, setMode] = useState<Mode>('image')
  const [navOpen, setNavOpen] = useState(false)
  /** Đóng drawer sidebar di động; ổn định tham chiếu để effect trong Sidebar không chạy lại. */
  const closeNav = useCallback(() => setNavOpen(false), [])
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
    if (page === 'docs') params.set('article', resolveDocsArticle(docsArticleId, user?.role))
    if (page === 'quick' && quickSessionId) params.set('session', quickSessionId)
    if (page === 'quick' && quickView === 'canvas') params.set('view', 'canvas')
    if (page === 'quick' && quickSessionId && quickGenerationId) params.set('generation', quickGenerationId)
    if (['planner', 'timeline', 'planner-characters'].includes(page) && planSessionId) {
      params.set('session', planSessionId)
    }
    const previousParams = new URLSearchParams(window.location.search)
    if (page === 'entities') {
      const libraryUrl = new URL(window.location.href)
      libraryUrl.search = params.toString()
      writeEntityLibraryLocation(libraryUrl, libraryLocation.kind, libraryLocation.selectedEntity)
      libraryUrl.searchParams.forEach((value, key) => params.set(key, value))
    }
    if (page === 'studio' && previousParams.get('page') === 'studio' && previousParams.get('project')) params.set('project',previousParams.get('project')!)
    const keepDocsHash = page === 'docs' && previousParams.get('page') === 'docs'
      && resolveDocsArticle(previousParams.get('article'), user?.role) === resolveDocsArticle(docsArticleId, user?.role)
    const url = `${window.location.pathname}?${params.toString()}${keepDocsHash ? window.location.hash : ''}`
    if (!urlSynced.current) {
      urlSynced.current = true
      window.history.replaceState({}, '', url)
      return
    }
    if (window.location.search !== `?${params.toString()}`) window.history.pushState({}, '', url)
  }, [page, planSessionId, quickSessionId, quickGenerationId, quickView, docsArticleId, user?.role, libraryLocation])

  useEffect(() => {
    function onPopState(): void {
      const next = readLocation()
      const nextQuickView = new URLSearchParams(window.location.search).get('view') === 'canvas' ? 'canvas' : 'form'
      const apply = () => {
        setPage(next.page)
        if (next.page === 'entities') setLibraryLocation(readEntityLibraryLocation(window.location.search))
        if (next.page === 'docs') setDocsArticleId(resolveDocsArticle(new URLSearchParams(window.location.search).get('article')))
        // `session` chỉ thuộc một loại phiên tại một thời điểm.
        if (next.page === 'quick') {
          setQuickSessionId(next.session)
          setQuickGenerationId(new URLSearchParams(window.location.search).get('generation') ?? '')
          setQuickView(nextQuickView)
        }
        else setPlanSessionId(next.session)
      }
      if (characterNavigationGuard.current) {
        const destination = window.location.href
        const current = new URLSearchParams(window.location.search)
        current.set('page', pageRef.current)
        if (pageRef.current === 'entities') {
          const currentUrl = new URL(window.location.href)
          currentUrl.search = current.toString()
          writeEntityLibraryLocation(currentUrl, libraryLocationRef.current.kind, libraryLocationRef.current.selectedEntity)
          currentUrl.searchParams.forEach((value, key) => current.set(key, value))
        }
        if (sessionIdRef.current) current.set('session', sessionIdRef.current)
        else current.delete('session')
        if (pageRef.current === 'quick' && quickViewRef.current === 'canvas') current.set('view', 'canvas')
        else current.delete('view')
        // Temporarily retain the current URL while saving, without adding a
        // history entry that would destroy the browser's Forward destination.
        window.history.replaceState({}, '', `${window.location.pathname}?${current}`)
        characterNavigationGuard.current(() => {
          window.history.replaceState({}, '', destination)
          apply()
        })
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

  const catalogRevision = useRef(0)
  const catalogRequests = useRef(new Set<AbortController>())
  const loggingOut = useRef(false)
  const accountId = useRef(user?.id ?? null)
  accountId.current = loggingOut.current ? null : user?.id ?? null
  const invalidateCatalog = useCallback(() => {
    catalogRevision.current++
    for (const controller of catalogRequests.current) controller.abort()
    catalogRequests.current.clear()
  }, [])
  /** Catalog requests belong to one account lifetime, never to the next login. */
  const loadAll = useCallback(async () => {
    const owner = accountId.current
    if (!owner) return
    const revision = ++catalogRevision.current
    const controller = new AbortController()
    catalogRequests.current.add(controller)
    try {
      const [providerResult, modelResult, generationResult] = await Promise.all([
        providerApi.list(controller.signal),
        modelApi.list(undefined, controller.signal),
        generationApi.list({}, controller.signal),
      ])
      if (controller.signal.aborted || owner !== accountId.current || revision !== catalogRevision.current) return
      setProviders(providerResult.providers)
      setModels(modelResult.models)
      setGenerations(generationResult.generations)
    } catch (cause) {
      if (!controller.signal.aborted) throw cause
    } finally {
      catalogRequests.current.delete(controller)
    }
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
    invalidateCatalog()
    setProviders([])
    setModels([])
    setGenerations([])
    if (!user) {
      setLoadingData(false)
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
      invalidateCatalog()
    }
  }, [user, loadAll, notifyError, invalidateCatalog])

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
    let inFlight = false
    const owner = user.id
    const controller = new AbortController()

    const interval = window.setInterval(
      () => {
        if (inFlight || owner !== accountId.current) return
        inFlight = true
        generationApi
          .list({}, controller.signal)
          .then((result) => {
            if (!cancelled && owner === accountId.current) setGenerations(result.generations)
          })
          .catch(() => {
            // Bỏ qua lỗi tạm thời khi làm mới nền.
          })
          .finally(() => { inFlight = false })
      },
      hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    )

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(interval)
    }
  }, [user, hasActive])

  async function handleLogout() {
    // Invalidate before the network request; even a slow logout cannot revive a catalog.
    loggingOut.current = true
    accountId.current = null
    invalidateCatalog()
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
    videoReferenceStyle?: VideoReferenceStyle
    authScheme?: 'bearer' | 'higgsfield'
  }) {
    setModalBusy(true)
    setModalError(null)
    try {
      const result = await providerApi.create(draft)
      const revision = ++catalogRevision.current
      setProviders((current) => [...current.filter(item => item.id !== result.provider.id), result.provider])
      setShowProviderModal(false)
      notifyKey('toastProviderAdded')
      if (draft.authScheme === 'higgsfield') {
        try {
          const refreshed = await modelApi.list()
          if (revision === catalogRevision.current) setModels(refreshed.models)
        } catch {
          // A refresh failure must never invite resubmitting a successful POST.
          if (revision === catalogRevision.current) notifyKey('toastProviderSavedRefreshFailed')
        }
      }
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

  async function updateProvider(id: string, patch: { imageApiStyle?: ImageApiStyle; videoReferenceStyle?: VideoReferenceStyle }) {
    setBusyId(id)
    try {
      const result = await providerApi.update(id, patch)
      setProviders((current) =>
        current.map((provider) => (provider.id === id ? result.provider : provider)),
      )
      // Đổi kiểu ảnh thì báo riêng; đổi kiểu ảnh tham chiếu video dùng thông báo chung.
      if (patch.imageApiStyle) {
        notifyKey(
          patch.imageApiStyle === 'extra_body'
            ? 'toastImageStyleExtraBody'
            : 'toastImageStyleOpenai',
        )
      } else {
        notifyKey('toastVideoRefStyleUpdated')
      }
    } catch (cause) {
      notifyError(cause)
    } finally {
      setBusyId(null)
    }
  }

  async function removeProvider(id: string): Promise<boolean> {
    setBusyId(id)
    try {
      await providerApi.remove(id)
      setProviders((current) => current.filter((provider) => provider.id !== id))
      setModels((current) => current.filter((model) => model.providerId !== id))
      notifyKey('toastProviderRemoved')
      return true
    } catch (cause) {
      notifyError(cause)
      return false
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
      videoApiStyle?: 'openai' | 'agnes' | 'higgsfield'
      enabled?: boolean
      priceUnit?: number | null
      priceInput1k?: number | null
      priceOutput1k?: number | null
      priceCurrency?: string
      imageSize?: string | null
      imageReferenceSupport?: 'unknown' | 'yes' | 'no'
      imageMaskSupport?: 'unknown' | 'yes' | 'no'
      imageTransparentBackgroundSupport?: 'unknown' | 'yes' | 'no'
      imageReferenceTransport?: 'provider_default' | 'generations_images'
      imageMaxReferences?: number | null
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
    const generation = generations.find((item) => item.id === id)
    const acknowledgeUnknown = generation?.status === 'unknown' && !generation.providerJobId
    if (acknowledgeUnknown && !window.confirm(t(generation.kind === 'video' ? 'confirmTrashUnknownVideo' : 'confirmTrashUnknownImage'))) return
    setBusyId(id)
    try {
      await generationApi.remove(id, acknowledgeUnknown ? { acknowledgeUnknown: true } : undefined)
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
      <LoadingState className="boot-screen">
        <LoaderCircle size={26} className="spin" aria-hidden="true" />
        <span>{t('bootCheckingSession')}</span>
      </LoadingState>
    )
  }

  if (!user) {
    return <AuthPage onAuthenticated={nextUser => { loggingOut.current = false; setUser(nextUser) }} />
  }

  // Chỉ cho phép điều hướng trong phạm vi vai trò, kể cả URL nhập trực tiếp.
  const visiblePage: Page = user.role === 'admin'
    ? (['admin-accounts', 'admin-usage', 'account-settings', 'docs'].includes(page) ? page : 'admin-accounts')
    : (page.startsWith('admin-') ? 'studio' : page)

  if (user.role === 'admin') {
    return (
      <div className="app-shell">
        <Sidebar page={visiblePage} user={user} creationCount={0} open={navOpen} collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(current => !current)}
          onNavigate={next => { setPage(next); closeNav() }} onLogout={handleLogout} onClose={closeNav} />
        <main className="main-area">
          <Topbar page={visiblePage} navOpen={navOpen} onToggleNav={() => setNavOpen(open => !open)} onOpenDocs={() => navigateFromDocs('docs')} />
          {visiblePage === 'docs' ? <Suspense fallback={<LoadingState label={t('loadingDocs')} />}>
            <DocsContent articleId={resolveDocsArticle(docsArticleId, user.role)} onSelectArticle={setDocsArticleId} onNavigate={navigateFromDocs} role="admin" />
          </Suspense>
            : <Suspense fallback={<LoadingState label={t('bootCheckingSession')} />}>
              {visiblePage === 'account-settings' ? <AccountSettingsPage user={user} />
                : visiblePage === 'admin-usage' ? <div className="page-content"><AdminUsagePanel /></div>
                  : <AdminUsersPage />}
            </Suspense>}
        </main>
      </div>
    )
  }

  return (
    <ImageCharacterProvider models={models} onOpenSettings={() => setPage('settings')} onNotify={notify}>
    <div className="app-shell">
      <Sidebar
        page={page}
        user={user}
        creationCount={generations.length}
        open={navOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
        onClose={closeNav}
        onNavigate={(next) => {
          // Release the mobile focus scope before a dirty-draft guard opens its dialog.
          closeNav()
          guardedNavigate(() => {
            // Bấm thẳng mục API & Models thì vào tab Providers như trước.
            if (next === 'settings') setSettingsTab('providers')
            // Mỗi lần mở tab tạo nội dung đơn lẻ, bắt đầu từ danh sách phiên.
            // Phiên chỉ được mở khi người dùng chọn nó trong browser.
            if (next === 'quick') setQuickSessionId('')
            setPage(next)
            closeNav()
          })
        }}
        onLogout={handleLogout}
      />

      <main className="main-area">
        <Topbar page={page} navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} onOpenDocs={() => navigateFromDocs('docs')} />

        {page === 'docs' && (
          <Suspense fallback={<LoadingState label={t('loadingDocs')} />}>
            <DocsContent articleId={resolveDocsArticle(docsArticleId, user.role)} onSelectArticle={setDocsArticleId} onNavigate={navigateFromDocs} role="user" />
          </Suspense>
        )}

        {page === 'studio' && (
          <Suspense fallback={<LoadingState label={t('loadingProjectStudio')} />}>
            <ProjectStudio
              models={models}
              initialProjectId={studioTarget?.projectId ?? (new URLSearchParams(window.location.search).get('project') ?? '')}
              initialTab={studioTarget?.tab}
              onOpenSettings={() => setPage('settings')}
              onOpenTrash={() => setPage('trash')}
              onNotify={notify}
              onCreated={(generation) => setGenerations((current) => [generation, ...current])}
            />
          </Suspense>
        )}

        {page === 'entities' && (
          <Suspense fallback={<LoadingState label={t('loadingEntities')} />}>
            <EntityLibraryPage llmModels={llmModels} models={models} onNotify={notify}
              onOpenSettings={() => setPage('settings')}
              filter={libraryLocation.kind} selectedEntity={libraryLocation.selectedEntity}
              onLocationChange={changeLibraryLocation} onRegisterNavigationGuard={registerCharacterGuard} />
          </Suspense>
        )}

        {page === 'planner' && (
          <Suspense fallback={<LoadingState label={t('loadingPlanner')} />}>
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
          <Suspense fallback={<LoadingState className="empty-state" label={t('loadingCharacters')} />}>
            <PlannerCharactersPage onRegisterNavigationGuard={registerCharacterGuard} sessionId={planSessionId} onSelectSession={setPlanSessionId} onNotify={notify}
              onBackToChat={(id) => { setPlanSessionId(id); setPage('planner') }}
              onOpenTimeline={(id) => { setPlanSessionId(id); setPage('timeline') }} />
          </Suspense>
        )}

        {page === 'timeline' && (
          <Suspense fallback={<LoadingState className="empty-state" label={t('loadingTimeline')} />}>
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
              onOpenProject={(projectId) => { setStudioTarget({ projectId, tab: 'canvas' }); setPage('studio') }}
              onProjectsChanged={loadAll}
            />
          </Suspense>
        )}

        {page === 'usage' && (
          <Suspense fallback={<LoadingState className="empty-state" label={translate(usageCatalog, 'loading', undefined, locale)} />}>
            <UsagePage onOpenModelCatalog={() => { setSettingsTab('models'); setPage('settings') }} />
          </Suspense>
        )}

        {page === 'trash' && (
          <Suspense fallback={<LoadingState className="empty-state" label={t('loadingTrash')} />}>
            <TrashPage onNotify={notify} onChanged={loadAll} />
          </Suspense>
        )}

        {page === 'quick' && (
          <QuickPage
            mode={mode}
            onModeChange={setMode}
            models={models}
            onCreated={(generation) => setGenerations((current) => [generation, ...current])}
            onDelete={removeGeneration}
            onRetry={retryDownload}
            busyId={busyId}
            onNavigate={setPage}
            onNotify={notify}
            sessionId={quickSessionId}
            onSelectSession={selectQuickSession}
            selectedGenerationId={quickGenerationId}
            onOpenGeneration={(session, generation) => { setQuickSessionId(session); setQuickGenerationId(generation) }}
            view={quickView}
            onViewChange={setQuickView}
            onRegisterNavigationGuard={registerCharacterGuard}
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

        {page === 'account-settings' && <Suspense fallback={<LoadingState label={t('bootCheckingSession')} />}><AccountSettingsPage user={user} /></Suspense>}

        {page === 'settings' && (
          <Suspense fallback={<LoadingState label={t('bootCheckingSession')} />}><SettingsPage
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
          /></Suspense>
        )}
      </main>

      {showProviderModal && (
        <Suspense fallback={<LoadingState label={t('bootCheckingSession')} />}><ProviderModal
          onClose={() => setShowProviderModal(false)}
          onSave={createProvider}
          busy={modalBusy}
          error={modalError}
        /></Suspense>
      )}

      {showModelModal && (
        <Suspense fallback={<LoadingState label={t('bootCheckingSession')} />}><ModelModal
          providers={providers}
          onClose={() => setShowModelModal(false)}
          onSave={createModel}
          onNeedProvider={() => {
            setShowModelModal(false)
            setShowProviderModal(true)
          }}
          busy={modalBusy}
          error={modalError}
        /></Suspense>
      )}


      <Toast message={toastText} tone={toast?.kind === 'error' ? 'error' : 'success'} />
    </div>
    </ImageCharacterProvider>
  )
}
