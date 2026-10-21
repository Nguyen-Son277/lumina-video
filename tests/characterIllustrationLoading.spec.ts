import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const generation = (status = 'running', progress: unknown = null) => ({ id: 'loading-generation', status, progress, assets: status === 'succeeded' ? [{ id: 'asset', url: '/loading-preview.svg' }] : [] })
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

async function mount(page: Page, modal = true) {
  await signUpFresh(page)
  const modelId = await seedModel(page, await seedProvider(page))
  const preferences = await (await page.request.get(`${BASE}/api/entity-library/preferences`)).json()
  expect((await page.request.patch(`${BASE}/api/entity-library/preferences`, { data: { version: 1, expectedUserId: preferences.userId, settings: { imageModelId: modelId } } })).ok()).toBe(true)
  await page.route('**/__illustration-loading', route => route.fulfill({ contentType: 'text/html', body: '<html><head></head><body><div id="fixture"></div></body></html>' }))
  await page.route('**/*preview.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="purple"/></svg>' }))
  await page.goto(`${BASE}/__illustration-loading`)
  await page.evaluate(async ({ modelId, modal }) => {
    const load = (path: string) => import(path)
    const refresh = await load('/@react-refresh'); refresh.default.injectIntoGlobalHook(window)
    const w = window as any
    w.$RefreshReg$ = () => {}; w.$RefreshSig$ = () => (type: unknown) => type; w.__vite_plugin_react_preamble_installed__ = true
    const source = await (await fetch('/src/components/CharacterIllustrate.tsx')).text()
    const reactUrl = source.match(/"([^" ]*\/react\.js\?v=[^" ]+)"/)![1]
    const [React, ReactDOM, component] = await Promise.all([load(reactUrl), load(`/node_modules/.vite/deps/react-dom_client.js${new URL(reactUrl, location.origin).search}`), load(modal ? '/src/components/CharacterIllustrateModal.tsx' : '/src/components/CharacterIllustrate.tsx')])
    for (const path of ['/src/styles.css', '/src/styles/character-illustration-loading.css']) {
      await new Promise<void>((resolve, reject) => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = `${path}?direct`; link.onload = () => resolve(); link.onerror = () => reject(new Error(path)); document.head.appendChild(link) })
    }
    const R = React.default ?? React, character = { id: 'loading-character', name: 'Loading actor', appearance: 'Blue coat', referenceUrl: '/old-preview.svg' }
    w.loadingAttached = 0; w.loadingClosed = 0
    const props = { character, models: [{ id: modelId, displayName: 'Loading image', kind: 'image', enabled: true }], onClose() { w.loadingClosed++ }, onAttached() { w.loadingAttached++ }, onNotify() {}, initial: { generationId: 'old', assetUrl: '/old-preview.svg' } }
    w.loadingRoot = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(document.getElementById('fixture'))
    w.loadingRoot.render(R.createElement(modal ? component.CharacterIllustrateModal : component.IllustrationPanel, props))
  }, { modelId, modal })
  const panel = page.locator('.illustration-panel')
  await expect(panel.locator('.illustration-button')).toBeEnabled()
  return panel
}

test('sending, generating and awaited attaching keep one visible loading status and one paid request', async ({ page }) => {
  const sending = gate(), polling = gate(), attaching = gate()
  let posts = 0, gets = 0, attaches = 0
  await page.route('**/api/shared-characters/illustrations', async route => { posts++; await sending.promise; await route.fulfill({ json: { generation: generation('queued') } }) })
  await page.route('**/api/generations/loading-generation', async route => { gets++; await polling.promise; await route.fulfill({ json: { generation: generation('succeeded', 100) } }) })
  await page.route('**/api/shared-characters/loading-character/reference/from-generation', async route => { attaches++; await attaching.promise; await route.fulfill({ json: { character: { id: 'loading-character', name: 'Loading actor', appearance: 'Blue coat', referenceUrl: '/loading-preview.svg' } } }) })
  try {
    const panel = await mount(page)
    await panel.locator('.illustration-button').click()
    await expect(panel).toHaveAttribute('aria-busy', 'true')
    await expect(panel).toHaveAttribute('data-illustration-phase', 'sending')
    await expect(panel.getByRole('status')).toHaveCount(1)
    await expect(panel.locator('.character-illustration-loading')).toContainText('Đang gửi yêu cầu')
    await expect(panel.locator('.illustration-button')).toHaveText('Đang gửi yêu cầu…')
    await expect(panel.locator('.illustration-image')).toHaveAttribute('src', '/old-preview.svg')
    await expect(panel.locator('progress')).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(panel.locator('.character-illustration-loading svg')).toHaveCSS('animation-name', 'none')
    sending.release()
    await expect(panel).toHaveAttribute('data-illustration-phase', 'generating')
    await expect(panel.locator('.illustration-button')).toHaveText('Đang tạo ảnh…')
    polling.release()
    await expect(panel).toHaveAttribute('data-illustration-phase', 'attaching')
    await expect(panel.locator('.illustration-button')).toHaveText('Đang gắn ảnh vào nhân vật…')
    await expect(page.getByRole('status')).toHaveCount(1)
    await expect(panel.locator('.illustration-button')).toBeDisabled()
    await expect(page.locator('.modal-header .close-button')).toBeDisabled()
    expect(posts).toBe(1); expect(gets).toBe(1); expect(attaches).toBe(1)
    attaching.release()
    await expect(panel).toHaveAttribute('aria-busy', 'false')
    await expect(panel.locator('.character-illustration-loading')).toHaveCount(0)
    await expect(panel.locator('.illustration-button')).toHaveText('Tạo ảnh khác')
    expect(await page.evaluate(() => (window as any).loadingAttached)).toBe(1)
  } finally { sending.release(); polling.release(); attaching.release() }
})

test('only finite in-range progress is shown and generation failure clears loading without retry', async ({ page }) => {
  let progress: unknown = 37, failed = false, posts = 0, gets = 0
  await page.route('**/api/shared-characters/illustrations', route => { posts++; return route.fulfill({ json: { generation: generation('queued') } }) })
  await page.route('**/api/generations/loading-generation', route => { gets++; return route.fulfill({ json: { generation: failed ? { ...generation('failed'), errorMessage: 'Image failed' } : generation('running', progress) } }) })
  const panel = await mount(page, false)
  await panel.locator('.illustration-button').click()
  await expect(panel.locator('progress')).toHaveAttribute('value', '37')
  await expect(panel.locator('.illustration-button')).toContainText('37%')
  for (const invalid of [-1, 101, '42', null]) {
    progress = invalid
    const before = gets
    await expect.poll(() => gets).toBeGreaterThan(before)
    await expect(panel.locator('progress')).toHaveCount(0)
    await expect(panel.locator('.illustration-button')).toHaveText('Đang tạo ảnh…')
  }
  failed = true
  await expect(panel.getByRole('alert')).toBeVisible()
  await expect(panel).toHaveAttribute('aria-busy', 'false')
  await expect(panel.locator('.character-illustration-loading')).toHaveCount(0)
  await expect(panel.locator('.illustration-image')).toHaveAttribute('src', '/old-preview.svg')
  expect(posts).toBe(1)
})

for (const phase of ['sending', 'attaching']) {
  test(`${phase} failure stops overlay and leaves retry available without another paid request`, async ({ page }) => {
    let posts = 0
    const failure = gate()
    await page.route('**/api/shared-characters/illustrations', async route => { posts++; if (phase === 'sending') { await failure.promise; await route.fulfill({ status: 500, json: { error: 'Sending failed' } }) } else await route.fulfill({ json: { generation: generation('queued') } }) })
    await page.route('**/api/generations/loading-generation', route => route.fulfill({ json: { generation: generation('succeeded') } }))
    await page.route('**/api/shared-characters/loading-character/reference/from-generation', async route => { await failure.promise; await route.fulfill({ status: 500, json: { error: 'Attachment failed' } }) })
    try {
      const panel = await mount(page)
      await panel.locator('.illustration-button').click()
      await expect(panel).toHaveAttribute('data-illustration-phase', phase)
      failure.release()
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(panel).toHaveAttribute('aria-busy', 'false')
      await expect(panel.locator('.illustration-button')).toBeEnabled()
      await expect(panel.locator('.character-illustration-loading')).toHaveCount(0)
      expect(posts).toBe(1)
      expect(await page.evaluate(() => (window as any).loadingAttached)).toBe(0)
    } finally { failure.release() }
  })
}
