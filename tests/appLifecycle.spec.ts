import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { BASE, seedModel, seedProvider, signInViaApi, signUpFresh } from './helpers/auth'
import type { Generation } from '../src/api/types'
import { shellCatalog } from '../src/i18n/catalogs/shell'
import { plannerCharactersCatalog } from '../src/i18n/catalogs/plannerCharacters'

// Uses Playwright's isolated mock server and real auth helpers. No generation job,
// provider call, fixed Vite dependency hash, or developer server is involved.
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

const catalogPaths = ['/api/providers', '/api/models', '/api/generations'] as const
type CatalogPath = typeof catalogPaths[number]
type Catalog = Record<CatalogPath, unknown>

function generationFor(account: string): Generation {
  return {
    id: `lifecycle-${account}`, kind: 'image', prompt: `${account} private generation`,
    status: 'failed', progress: null, provider: `${account} provider`, model: `${account} model`,
    params: {}, errorCode: 'FIXTURE_ONLY', errorMessage: 'Local fixture, no provider request',
    providerJobId: null, createdAt: 1, updatedAt: 1, completedAt: 1, assets: [],
  }
}

async function seedCatalog(page: Page, account: string): Promise<Catalog> {
  const provider = await seedProvider(page, { name: `${account} private provider` })
  await seedModel(page, provider, { modelId: `${account}-image`, displayName: `${account} private model`, kind: 'image' })
  const [providers, models] = await Promise.all([
    page.request.get(`${BASE}/api/providers`), page.request.get(`${BASE}/api/models`),
  ])
  expect(providers.ok()).toBe(true)
  expect(models.ok()).toBe(true)
  return {
    '/api/providers': await providers.json(), '/api/models': await models.json(),
    '/api/generations': { generations: [generationFor(account)] },
  }
}

async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

for (const releaseAt of ['signed-out', 'second-account-loaded'] as const) {
  test(`old account catalog cannot commit when delayed responses finish ${releaseAt}`, async ({ page }) => {
    const firstAccount = await signUpFresh(page)
    const firstCatalog = await seedCatalog(page, 'First account')
    const secondAccount = await signUpFresh(page)
    const secondCatalog = await seedCatalog(page, 'Second account')
    await signInViaApi(page, firstAccount.email, firstAccount.password)

    const firstGate = gate(), secondGate = gate()
    let account: 'first' | 'second' = 'first'
    const requests: Record<'first' | 'second', Set<Request>> = { first: new Set(), second: new Set() }
    const started: Record<'first' | 'second', Set<string>> = { first: new Set(), second: new Set() }
    const terminal = new Set<Request>()
    page.on('requestfinished', request => terminal.add(request))
    page.on('requestfailed', request => terminal.add(request))
    const intercept = async (route: Route) => {
      const request = route.request(), path = new URL(request.url()).pathname as CatalogPath
      if (request.method() !== 'GET' || !catalogPaths.includes(path)) { await route.continue(); return }
      const owner = account
      requests[owner].add(request)
      started[owner].add(path)
      await (owner === 'first' ? firstGate.promise : secondGate.promise)
      // Account cleanup may abort this request before the server gate opens.
      // Cancellation is a valid defense and must not make the fixture itself fail.
      if (terminal.has(request)) return
      try {
        await route.fulfill({ json: (owner === 'first' ? firstCatalog : secondCatalog)[path] })
      } catch (error) {
        // Chromium may report requestfailed just after fulfill rejects. Only the
        // intentionally ended first-account lifetime permits this cancellation.
        if (owner !== 'first' && !terminal.has(request) && !request.failure() && !page.isClosed()) throw error
      }
    }
    await page.route('**/api/**', intercept)
    try {
      await page.goto(`${BASE}/?page=settings`)
      await expect(page.locator('.sidebar .user-info')).toContainText(firstAccount.email)
      await expect.poll(() => started.first.size).toBe(3)
      await page.getByRole('button', { name: shellCatalog.logout.vi, exact: true }).click()
      await expect(page.getByPlaceholder('ban@example.com')).toBeVisible()
      if (releaseAt === 'signed-out') {
        firstGate.release()
        await expect.poll(() => [...requests.first].every(request => terminal.has(request))).toBe(true)
        await nextPaint(page)
      }

      account = 'second'
      // Stay in this App instance: navigating with a login helper here would hide
      // the stale-response bug by throwing away the first account's React state.
      await page.getByPlaceholder('ban@example.com').fill(secondAccount.email)
      await page.getByPlaceholder('Nhập mật khẩu').fill(secondAccount.password)
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
      await expect(page.locator('.sidebar .user-info')).toContainText(secondAccount.email)
      await expect.poll(() => started.second.size).toBe(3)
      await page.locator('.sidebar').getByRole('button', { name: shellCatalog.navApiModels.vi, exact: true }).click()
      await expect(page.locator('.settings-page')).toBeVisible()
      await nextPaint(page)
      await expect(page.locator('.provider-item')).toHaveCount(0)
      await expect(page.locator('.settings-tabs .tab-count')).toHaveText(['0', '0'])
      await expect(page.locator('.sidebar').getByRole('button', { name: shellCatalog.navLibrary.vi, exact: true }).locator('em')).toHaveText('0')

      secondGate.release()
      await expect(page.locator('.provider-item')).toContainText('Second account private provider')
      if (releaseAt === 'second-account-loaded') {
        firstGate.release()
        await expect.poll(() => [...requests.first].every(request => terminal.has(request))).toBe(true)
        await nextPaint(page)
      }
      await expect(page.locator('.provider-item')).toHaveCount(1)
      await expect(page.locator('.settings-page')).not.toContainText('First account private provider')
      await page.locator('.settings-tabs').getByRole('button', { name: /Model catalog/ }).click()
      await expect(page.locator('.model-catalog')).toContainText('Second account private model')
      await expect(page.locator('.model-catalog')).not.toContainText('First account private model')
      await page.locator('.sidebar').getByRole('button', { name: shellCatalog.navLibrary.vi, exact: true }).click()
      await expect(page.locator('.creation-card')).toHaveCount(1)
      await expect(page.locator('.creation-card')).toContainText('Second account private generation')
      await expect(page.locator('.library-page')).not.toContainText('First account private generation')
    } finally {
      firstGate.release()
      secondGate.release()
      await page.unroute('**/api/**', intercept)
    }
  })
}

test('mobile navigation closes its drawer before a dirty character editor confirmation owns focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signUpFresh(page)
  // Seed the existing planner session/cast API, but make no AI or portrait job.
  // A metadata-only edit is sufficient to exercise PlannerCharacters' guard.
  const created = await page.request.post(`${BASE}/api/plans`, { data: { kind: 'planner' } })
  expect(created.ok()).toBe(true)
  const id = (await created.json()).session.id as string
  const cast = await page.request.put(`${BASE}/api/plans/${id}/cast`, {
    data: { cast: [{ id: 'mobile-guard-character', name: 'Mobile guard original', role: 'Main character', appearance: 'Red coat', voice: {}, storage: 'project' }] },
  })
  expect(cast.ok()).toBe(true)
  await page.goto(`${BASE}/?page=planner-characters&session=${encodeURIComponent(id)}`)
  const workshop = page.getByTestId('planner-characters-page')
  const name = workshop.getByRole('textbox', { name: plannerCharactersCatalog.name.vi, exact: true })
  await expect(name).toHaveValue('Mobile guard original')
  await name.fill('Mobile guard unsaved draft')
  await expect(workshop.locator('.pc-save-bar').getByRole('button', { name: plannerCharactersCatalog.save.vi, exact: true })).toBeEnabled()

  const sidebar = page.locator('.sidebar')
  await page.getByRole('button', { name: shellCatalog.openMenu.vi, exact: true }).click()
  await expect(sidebar).toHaveAttribute('role', 'dialog')
  await expect(sidebar.getByRole('button', { name: shellCatalog.closeMenu.vi, exact: true })).toBeFocused()
  await sidebar.getByRole('button', { name: shellCatalog.navPlanner.vi, exact: true }).click()

  const confirmation = page.getByRole('dialog', { name: plannerCharactersCatalog.dirtyTitle.vi, exact: true })
  await expect(confirmation).toBeVisible()
  await expect(sidebar).not.toHaveClass(/sidebar-open/)
  await expect(sidebar).toHaveAttribute('inert', '')
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const save = confirmation.getByRole('button', { name: plannerCharactersCatalog.save.vi, exact: true })
  const cancel = confirmation.getByRole('button', { name: plannerCharactersCatalog.cancel.vi, exact: true })
  await expect(save).toBeFocused()
  // The old shared Sidebar capture trap redirected this focus back into the
  // drawer. The local confirmation must now receive and wrap keyboard focus.
  await page.keyboard.press('Shift+Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(confirmation).toHaveCount(0)
  await expect(name).toHaveValue('Mobile guard unsaved draft')
  await expect(sidebar).toHaveAttribute('inert', '')
  await expect(sidebar).not.toHaveClass(/sidebar-open/)
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('planner-characters')
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(id)
  const persisted = await page.request.get(`${BASE}/api/plans/${id}`)
  expect(persisted.ok()).toBe(true)
  expect((await persisted.json()).session.cast[0].name).toBe('Mobile guard original')
})

function isXyflowDependency(url: string) {
  // Vite's optimized filename and ?v= value are generated; only the package name
  // is stable. Also cover an unoptimized /node_modules/@xyflow/ dependency URL.
  return /xyflow/i.test(decodeURIComponent(new URL(url).pathname))
}

test('a cold form loads Canvas dependencies only on demand and exposes the lazy fallback', async ({ page }) => {
  await signUpFresh(page)
  const xyflowRequests: string[] = []
  const canvasGate = gate()
  let canvasRequested = false
  page.on('request', request => { if (isXyflowDependency(request.url())) xyflowRequests.push(request.url()) })
  const canvasModule = '**/src/components/canvas/CanvasBoard.tsx*'
  const intercept = async (route: Route) => {
    canvasRequested = true
    await canvasGate.promise
    await route.continue()
  }
  await page.route(canvasModule, intercept)
  try {
    const sessionResponse = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Lazy Canvas regression' } })
    expect(sessionResponse.status()).toBe(201)
    const { session } = await sessionResponse.json()
    await page.goto(`${BASE}/?page=quick&session=${session.id}`)
    await expect(page.locator('#prompt')).toBeVisible()
    await nextPaint(page)
    expect(xyflowRequests).toEqual([])
    expect(canvasRequested).toBe(false)
    await page.locator('#prompt').fill('Cold lazy canvas fixture')
    await page.getByTestId('quick-canvas-toggle').filter({ visible: true }).click()
    await expect.poll(() => canvasRequested).toBe(true)
    const loading = page.getByTestId('quick-canvas-loading')
    await expect(loading).toBeVisible()
    await expect(loading).toHaveAttribute('role', 'status')
    await expect(loading).toHaveAttribute('aria-live', 'polite')
    await expect(loading).toContainText(/\S/)
    // The module gate makes this an observable loading state, not a timing race.
    expect(xyflowRequests).toEqual([])
    canvasGate.release()
    await expect(page.getByTestId('quick-canvas-workspace')).toBeVisible()
    await expect(page.locator('.canvas-flow')).toBeVisible()
    await expect(loading).toHaveCount(0)
    await expect(page.locator('.canvas-node.kind-prompt textarea')).toHaveValue('Cold lazy canvas fixture')
    await expect.poll(() => xyflowRequests.length).toBeGreaterThan(0)
  } finally {
    canvasGate.release()
    await page.unroute(canvasModule, intercept)
  }
})

test('deep-linked lazy Canvas keeps its session and draft when browser Back hits the save guard', async ({ page }) => {
  await signUpFresh(page)
  const created = await page.request.post(`${BASE}/api/quick-sessions`, {
    data: { title: 'Lazy lifecycle session', promptDocument: { version: 1, text: 'Deep-linked initial prompt', mentions: [] } },
  })
  expect(created.ok()).toBe(true)
  const id = (await created.json()).session.id as string
  expect((await page.request.post(`${BASE}/api/quick-sessions/${id}/canvas/sync`, { data: { baseRevision: 0 } })).ok()).toBe(true)
  await page.goto(`${BASE}/?page=quick&session=${encodeURIComponent(id)}&view=canvas`)
  const prompt = page.locator('.canvas-node.kind-prompt textarea')
  await expect(prompt).toHaveValue('Deep-linked initial prompt')
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(id)
  await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu')

  // Establish same-document history before testing popstate. A hard navigation
  // would test beforeunload rather than App's registered lazy-Canvas guard.
  await page.getByTestId('quick-canvas-toggle').filter({ visible: true }).click()
  await expect(page.locator('#prompt')).toHaveValue('Deep-linked initial prompt')
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBeNull()
  await page.getByTestId('quick-canvas-toggle').filter({ visible: true }).click()
  await expect(prompt).toHaveValue('Deep-linked initial prompt')
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('canvas')

  const path = `**/api/quick-sessions/${id}/canvas`
  const saveGate = gate()
  let saveStarted = false
  let failSave = true
  const intercept = async (route: Route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    saveStarted = true
    await saveGate.promise
    if (failSave) await route.fulfill({ status: 500, json: { error: 'SAVE_TEST_FAILURE' } })
    else await route.continue()
  }
  await page.route(path, intercept)
  try {
    await prompt.fill('Draft must survive failed browser Back')
    await page.goBack()
    await expect.poll(() => saveStarted).toBe(true)
    await expect(prompt).toHaveValue('Draft must survive failed browser Back')
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('canvas')
    await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(id)
    saveGate.release()
    await expect(page.locator('.canvas-save-state')).toHaveText(/Could not save|Save failed|Không lưu/)
    await expect(prompt).toHaveValue('Draft must survive failed browser Back')
    failSave = false
    await page.getByTestId('quick-canvas-toggle').filter({ visible: true }).click()
    await expect(page.locator('#prompt')).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBeNull()
    await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(id)
    const saved = await page.request.get(`${BASE}/api/quick-sessions/${id}/canvas`)
    expect(saved.ok()).toBe(true)
    expect(JSON.stringify((await saved.json()).canvas.graph)).toContain('Draft must survive failed browser Back')
  } finally {
    saveGate.release()
    await page.unroute(path, intercept)
  }
})
