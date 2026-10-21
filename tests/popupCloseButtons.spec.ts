import { expect, test, type Locator, type Page } from '@playwright/test'
import { BASE, seedLlmModel, signUpFresh } from './helpers/auth'

// Real components + production styles, no screenshots, image uploads or paid jobs.
const title = 'Tiêu đề popup dài không được ép nút đóng ' + 'VeryLongUnbrokenTitle'.repeat(4)
const shells = ['provider', 'creation', 'details', 'scene', 'scene-actions', 'quick', 'results', 'export', 'trash', 'timeline', 'drawer', 'surface-chat', 'artifact', 'layout', 'lightbox']

async function geometry(button: Locator) {
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('type', 'button')
  await expect(button).toHaveAttribute('aria-label', /\S/)
  await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true')
  const metrics = await button.evaluate(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    const svg = element.querySelector('svg')!, icon = svg.getBoundingClientRect()
    const parent = element.parentElement!.getBoundingClientRect()
    return {
      width: rect.width, height: rect.height, padding: style.padding, border: style.borderTopWidth,
      radius: style.borderTopLeftRadius, shrink: style.flexShrink,
      iconWidth: icon.width, iconHeight: icon.height, iconDisplay: getComputedStyle(svg).display,
      dx: (rect.left + rect.right - icon.left - icon.right) / 2,
      dy: (rect.top + rect.bottom - icon.top - icon.bottom) / 2,
      contained: rect.left >= parent.left - 1 && rect.right <= parent.right + 1 && rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1,
      viewport: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1,
    }
  })
  expect(metrics).toMatchObject({ width: 44, height: 44, padding: '0px', border: '1px', radius: '8px', shrink: '0', iconWidth: 20, iconHeight: 20, iconDisplay: 'block', contained: true, viewport: true })
  expect(Math.abs(metrics.dx)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(metrics.dy)).toBeLessThanOrEqual(0.5)
}

async function prepareFixtures(page: Page) {
  page.on('pageerror', error => console.error(`Close fixture browser error: ${error.message}`))
  await page.route('**/__close-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><div id="close-fixture"></div></body></html>' }))
  await page.goto(`${BASE}/__close-fixture`)
  await page.evaluate(async () => {
    const load = (path: string) => import(path)
    const refresh = await load('/@react-refresh')
    refresh.default.injectIntoGlobalHook(window)
    const w = window as any
    w.$RefreshReg$ = () => {}; w.$RefreshSig$ = () => (type: unknown) => type
    w.__vite_plugin_react_preamble_installed__ = true
  })
  await page.route('**/api/projects/close-fixture/exports', route => route.fulfill({ json: { exports: [] } }))
  await page.evaluate(async () => {
    const load = (path: string) => import(path)
    // Use the exact optimized dependency URL that production components import;
    // omitting Vite's hash creates a second React instance and invalid hooks.
    const source = await (await fetch('/src/components/ProviderEditModal.tsx')).text()
    const reactUrl = source.match(/"([^" ]*\/react\.js\?v=[^" ]+)"/)?.[1]
    if (!reactUrl) throw new Error('Cannot resolve component React dependency URL')
    const hash = new URL(reactUrl, location.origin).search
    const [React, ReactDOM] = await Promise.all([load(reactUrl), load(`/node_modules/.vite/deps/react-dom_client.js${hash}`)])
    // Direct production stylesheets make load ordering explicit and exercise the
    // same late-loaded family styles as the real application.
    for (const path of ['/src/styles.css', '/src/styles/entity-creation.css', '/src/styles/entity-card.css', '/src/locations.css', '/src/project-trash.css', '/src/styles/projectExport.css', '/src/components/canvas/canvas.css', '/src/styles/studio-beginner.css', '/src/styles/scene-results.css', '/src/styles/quick-generation-settings.css']) {
      await new Promise<void>((resolve, reject) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'; link.href = `${path}?direct`
        link.onload = () => resolve(); link.onerror = () => reject(new Error(`Cannot load ${path}`))
        document.head.appendChild(link)
      })
    }
    const w = window as any
    w.closeReact = React.default ?? React
    w.closeRoot = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(document.getElementById('close-fixture'))
  })
}

async function mountShell(page: Page, family: string) {
  await page.evaluate(async ({ family, title }) => {
    const w = window as any, R = w.closeReact, h = R.createElement
    const load = (path: string) => import(path)
    const paths: Record<string, [string, string]> = {
      provider: ['/src/components/ProviderEditModal.tsx', 'ProviderEditModal'],
      creation: ['/src/components/entities/EntityEditorDialog.tsx', 'CreationModal'],
      details: ['/src/components/entities/EntityDetailsDialog.tsx', 'EntityDetailsDialog'],
      scene: ['/src/components/SceneEditorModal.tsx', 'SceneEditorModal'],
      export: ['/src/components/ProjectExportModal.tsx', 'ProjectExportModal'],
      trash: ['/src/components/ProjectTrashDialog.tsx', 'ProjectTrashDialog'],
      timeline: ['/src/components/planner/TimelineOverlay.tsx', 'TimelineOverlay'],
      'surface-chat': ['/src/components/planner/SurfaceChatDrawer.tsx', 'SurfaceChatDrawer'],
      artifact: ['/src/components/planner/ArtifactDrawer.tsx', 'ArtifactDrawer'],
      layout: ['/src/components/canvas/LayoutEditor.tsx', 'LayoutEditor'],
      lightbox: ['/src/components/Lightbox.tsx', 'ImageLightbox'],
    }
    const kind = ['scene-actions', 'quick', 'results'].includes(family) ? 'scene' : family === 'drawer' ? 'timeline' : family
    const [path, name] = paths[kind], Component = (await load(path))[name]
    function Fixture() {
      const [open, setOpen] = R.useState(false), [busy, setBusy] = R.useState(false)
      w.setCloseFixtureBusy = setBusy
      const onClose = () => { w.closeCalls++; setOpen(false) }
      const child = h('div', { className: family === 'quick' ? 'quick-config-modal' : family === 'results' ? 'scene-results' : undefined }, h('button', { type: 'button' }, 'Last fixture control'))
      let props: any = { title, onClose, children: child }
      if (kind === 'provider') props = { onClose, onSave() {}, busy: false, error: null, provider: { id: 'p', name: title, baseUrl: 'https://mock.invalid/v1', imageApiStyle: 'images', videoReferenceStyle: 'auto' } }
      if (kind === 'creation') props.testId = 'close-creation'
      if (kind === 'details') props = { onClose, data: { id: 'd', kind: 'item', name: title, description: title } }
      if (kind === 'scene') props = { ...props, closeLabel: 'Đóng', closeDisabled: busy, ...(['scene-actions', 'results'].includes(family) ? { headerActions: h('button', { type: 'button', className: 'secondary-button' }, 'Header action') } : {}) }
      if (kind === 'export') props = { onClose, projectId: 'close-fixture' }
      if (kind === 'trash') props = { onClose, project: { id: 'p', name: title }, onConfirm: () => new Promise(resolve => { w.releaseCloseFixture = resolve }) }
      if (kind === 'timeline') props = { ...props, drawer: family === 'drawer', locked: busy }
      if (kind === 'surface-chat') props = { open: true, surface: 'timeline', title, messages: [], busy: false, blocked: false, draft: '', pending: null, applying: false, errorText: '', onClose, onSurfaceChange() {}, onDraftChange() {}, onSend() {}, onApply() {}, onDiscard() {} }
      if (kind === 'artifact') props = { onClose, artifact: 'script', session: { id: 's', script: { text: '', scenes: [] }, cast: [], locations: [], timeline: { frames: [] } }, busy: '', error: '', onSession() {}, async onReload() {}, onNotify() {}, onError() {}, onSwitch() {}, onOpenTimeline() {} }
      if (kind === 'layout') props = { title, onClose, layout: { aspectRatio: '16:9', instances: [] }, objects: [], onChange() {} }
      // A URL-only image fixture: no uploaded image or screenshot is used as test input.
      if (kind === 'lightbox') props = { onClose, src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', alt: title, downloadHref: '#fixture-download' }
      return h(R.Fragment, null, h('button', { id: 'close-opener', type: 'button', onClick: () => setOpen(true) }, 'Open fixture'), open && h(Component, props))
    }
    w.closeCalls = 0
    w.closeRoot.render(h(Fixture, { key: family }))
  }, { family, title })
  await page.locator('#close-opener').click()
  const button = page.locator('.close-button:visible')
  await geometry(button)
  return button
}

for (const width of [320, 390, 1280]) {
  test(`all production close shells keep canonical computed geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await prepareFixtures(page)
    for (const family of shells) {
      await test.step(family, async () => {
        const button = await mountShell(page, family)
        await button.click()
        await expect(page.locator('.close-button:visible')).toHaveCount(0)
        expect(await page.evaluate(() => (window as any).closeCalls)).toBe(1)
      })
    }
  })
}

test('close retains keyboard focus, busy locks and one callback without submitting forms', async ({ page }) => {
  await prepareFixtures(page)
  for (const family of ['scene', 'creation', 'details', 'timeline', 'drawer', 'lightbox']) {
    const button = await mountShell(page, family)
    await page.keyboard.press('Tab')
    await button.focus()
    await expect(button).toBeFocused()
    await expect(button).toHaveCSS('outline-style', 'solid')
    if (['scene', 'timeline', 'drawer'].includes(family)) {
      await page.evaluate(() => (window as any).setCloseFixtureBusy(true))
      await expect(button).toBeDisabled()
      await geometry(button)
      const disabledBackground = await button.evaluate(element => getComputedStyle(element).backgroundColor)
      await button.hover()
      await expect(button).toHaveCSS('background-color', disabledBackground)
      await page.keyboard.press('Escape')
      expect(await page.evaluate(() => (window as any).closeCalls)).toBe(0)
      await page.evaluate(() => (window as any).setCloseFixtureBusy(false))
      await expect(button).toBeEnabled()
    }
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.close-button:visible')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).closeCalls)).toBe(1)
    await expect(page.locator('#close-opener')).toBeFocused()
  }
  const close = await mountShell(page, 'trash')
  await page.locator('.project-trash-dialog form button[type="submit"]').click()
  await expect(close).toBeDisabled()
  await geometry(close)
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => (window as any).closeCalls)).toBe(0)
  await page.evaluate(() => (window as any).releaseCloseFixture())
  await expect(close).toBeEnabled()
  await close.click()
  expect(await page.evaluate(() => (window as any).closeCalls)).toBe(1)
})

for (const width of [320, 390, 1280]) {
  test(`location editor and reference-view close controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await prepareFixtures(page)
    await page.evaluate(async () => {
      const w = window as any, h = w.closeReact.createElement
      const load = (path: string) => import(path)
      const { LocationReferences } = await load('/src/components/LocationReferences.tsx')
      w.closeRoot.render(h(LocationReferences, {
        locations: [{ id: 'loc', name: 'Fixture location', stage: '', description: '', continuityNotes: '', imagePrompt: '', revision: 1, reference: null, referenceViews: [] }],
        imageModels: [{ id: 'model', kind: 'image', displayName: 'Fixture image' }], selectedModelId: 'model', onChanged() {},
        api: { async save(locations: unknown) { return locations }, async generate() {}, async upload() {} },
      }))
    })
    await page.locator('.locations-header .primary-small-button').click()
    await geometry(page.locator('.locations-dialog header .close-button'))
    await page.locator('.locations-dialog header .close-button').click()
    await expect(page.locator('.locations-dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Thêm góc', exact: true }).click()
    await geometry(page.locator('.locations-dialog header .close-button'))
    await page.locator('.locations-dialog header .close-button').click()
    await expect(page.locator('.locations-dialog')).toHaveCount(0)
  })

  test(`route entity editor, canvas inspector and planner popovers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await signUpFresh(page)
    await seedLlmModel(page)
    await page.goto(`${BASE}/?page=entities`)
    const create = page.getByTestId('entity-library-create')
    await create.click()
    const editor = page.getByTestId('entity-editor-dialog')
    await geometry(editor.locator('header .close-button'))
    await editor.locator('header .close-button').click()
    await expect(editor).toHaveCount(0)
    await expect(create).toBeFocused()

    const response = await page.request.post(`${BASE}/api/projects`, { data: { name: 'Close geometry canvas' } })
    expect(response.ok()).toBe(true)
    const { project } = await response.json()
    expect((await page.request.put(`${BASE}/api/projects/${project.id}/canvas`, { data: { baseRevision: 0, graph: { schemaVersion: 1, nodes: [{ id: 'note', kind: 'note', x: 10, y: 10, data: { text: 'Close inspector' } }], edges: [] } } })).ok()).toBe(true)
    await page.goto(`${BASE}/?page=studio`)
    await page.getByRole('button', { name: /Close geometry canvas/ }).click()
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
    await page.locator('.canvas-node.kind-note header strong').click()
    const inspector = page.locator('.canvas-inspector')
    await geometry(inspector.locator('.close-button'))
    await inspector.locator('.canvas-inspector-head strong').evaluate(element => { element.textContent = 'UnbrokenInspectorTitle'.repeat(8) })
    await geometry(inspector.locator('.close-button'))
    await inspector.locator('.close-button').click()
    await expect(inspector).toHaveCount(0)

    await page.goto(`${BASE}/?page=planner`)
    await page.getByRole('button', { name: 'Phiên mới' }).first().click()
    await geometry(page.locator('.planner-popover-setup .close-button'))
    await page.locator('.planner-popover-setup .close-button').click()
    await expect(page.locator('.planner-popover-setup')).toHaveCount(0)
    await page.getByRole('button', { name: /Danh sách phiên/ }).click()
    await geometry(page.locator('.planner-popover-sessions .close-button'))
    await page.locator('.planner-popover-sessions .close-button').click()
    await expect(page.locator('.planner-popover-sessions')).toHaveCount(0)
  })
}
