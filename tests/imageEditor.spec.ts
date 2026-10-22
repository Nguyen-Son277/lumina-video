import { expect, test, type Page } from '@playwright/test'
import { IMAGE_EDITOR_LIMITS } from '../shared/imageEditor'

const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#676090"/></svg>')

type Calls = { prepares: number; submits: number; polls: number; requests: any[]; jobStatus: 'queued' | 'succeeded' | 'unknown' }

async function mountEditor(page: Page, editable = true): Promise<Calls> {
  const calls: Calls = { prepares: 0, submits: 0, polls: 0, requests: [], jobStatus: 'succeeded' }
  await page.route('**/api/image-editor/**', async route => {
    const path = new URL(route.request().url()).pathname
    let body: unknown
    if (path.endsWith('/sources')) body = { source: { uploadId: `prepared-${++calls.prepares}`, url: image, width: 800, height: 600, mimeType: 'image/png', lineage: route.request().postDataJSON().source } }
    else if (path.endsWith('/capabilities')) body = { limits: IMAGE_EDITOR_LIMITS, local: { pad: true, backgroundRemoval: false }, operations: ['region', 'reframe', 'background'], models: [{ id: 'model', label: 'Test model', maskSupport: 'yes', transparentBackgroundSupport: 'yes', region: true, regionPromptOnly: false, reframe: true, background: true, backgroundRemoval: true }, { id: 'advisory', label: 'Advisory model', maskSupport: 'unknown', transparentBackgroundSupport: 'unknown', region: false, regionPromptOnly: true, reframe: true, background: true, backgroundRemoval: false }, { id: 'unsupported', label: 'Unsupported model', maskSupport: 'no', transparentBackgroundSupport: 'no', region: false, regionPromptOnly: false, reframe: false, background: false, backgroundRemoval: false }] }
    else if (path.endsWith('/preview')) { calls.requests.push(route.request().postDataJSON()); body = { prompt: 'Server exact compiled prompt', warnings: ['Server warning'], width: 800, height: 600, ...(calls.requests[calls.requests.length - 1].modelId === 'advisory' ? { promptDirected: true } : {}) } }
    else {
      const method = route.request().method()
      if (method === 'POST') calls.submits++; else calls.polls++
      const status = method === 'POST' ? 'queued' : calls.jobStatus
      body = {
        generation: {
          id: 'job', status, progress: null,
          errorCode: status === 'unknown' ? 'PROVIDER_INCOMPATIBLE' : null,
          errorMessage: status === 'unknown' ? 'Provider stopped reporting this job' : null,
          assets: method === 'POST' || status !== 'succeeded' ? [] : [{ id: 'result', url: image, mimeType: 'image/png' }],
        },
        reused: false,
      }
    }
    await route.fulfill({ json: body })
  })
  await page.route('**/__image-editor', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="fixture"></div></body></html>' }))
  await page.goto('/__image-editor')
  await page.evaluate(async ({ image, editable }) => {
    localStorage.setItem('lumina.locale', 'en')
    const load = (path: string) => import(path)
    const refresh = await load('/@react-refresh'); refresh.default.injectIntoGlobalHook(window)
    const w = window as any
    w.$RefreshReg$ = () => {}; w.$RefreshSig$ = () => (type: unknown) => type; w.__vite_plugin_react_preamble_installed__ = true
    const source = await (await fetch('/src/components/Lightbox.tsx')).text()
    const reactUrl = source.match(/"([^" ]*\/react\.js\?v=[^" ]+)"/)?.[1]
    if (!reactUrl) throw new Error('Cannot resolve React URL')
    const hash = new URL(reactUrl, location.origin).search
    const [React, ReactDOM, { ImageLightbox }] = await Promise.all([load(reactUrl), load(`/node_modules/.vite/deps/react-dom_client.js${hash}`), load('/src/components/Lightbox.tsx')])
    const R = React.default ?? React
    const root = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(document.getElementById('fixture'))
    w.characterSource = null
    function Fixture() {
      const [open, setOpen] = R.useState(true)
      return open && R.createElement(ImageLightbox, { src: image, alt: 'Test', editableSource: editable ? { kind: 'asset', id: 'original' } : undefined, onUseAsCharacter: (source: unknown) => { w.characterSource = source }, onClose: () => setOpen(false) })
    }
    root.render(R.createElement(Fixture))
  }, { image, editable })
  await expect(page.getByRole('dialog')).toBeVisible()
  if (editable) {
    await page.getByRole('button', { name: 'Edit image', exact: true }).click()
    await expect(page.getByTestId('editor-image-surface')).toBeVisible()
  }
  return calls
}

/** Draws one stroke and returns the normalized rectangle the UI must report. */
async function stroke(page: Page, start = { x: .2, y: .2 }, end = { x: .6, y: .6 }) {
  const box = (await page.getByTestId('editor-image-surface').boundingBox())!
  const from = { x: box.x + box.width * start.x, y: box.y + box.height * start.y }
  const to = { x: box.x + box.width * end.x, y: box.y + box.height * end.y }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
  }
}

test('normalized regions, region-scoped eraser, server preview gate and result actions', async ({ page }) => {
  const calls = await mountEditor(page)
  await page.getByRole('combobox', { name: 'AI model' }).selectOption('model')
  const first = await stroke(page)
  await page.getByLabel('Instructions for selected region').fill('First region')
  await page.getByRole('button', { name: 'Add region', exact: true }).click()
  await page.getByRole('button', { name: 'Brush', exact: true }).click()
  await stroke(page, { x: .3, y: .3 }, { x: .7, y: .7 })
  await page.getByLabel('Instructions for selected region').fill('Second region')
  await page.getByRole('button', { name: 'Eraser (selected region only)', exact: true }).click()
  await stroke(page, { x: .4, y: .4 }, { x: .5, y: .5 })
  // Zoom and pan must not change the normalized source coordinates.
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.getByRole('button', { name: 'Pan', exact: true }).click()
  const panBox = (await page.getByTestId('editor-image-surface').boundingBox())!
  await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + panBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(panBox.x + panBox.width / 2 + 40, panBox.y + panBox.height / 2 + 25, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await stroke(page, { x: .25, y: .25 }, { x: .5, y: .5 })
  await page.getByRole('button', { name: 'Review server preview', exact: true }).click()
  await expect(page.getByText('Server exact compiled prompt')).toBeVisible()
  expect(calls.submits).toBe(0)
  const request = calls.requests[0]
  expect(request.source).toEqual({ kind: 'upload', id: 'prepared-1' })
  expect(request.regions).toHaveLength(2)
  expect(request.regions[0].shapes).toHaveLength(1)
  expect(request.regions[0].shapes[0]).toMatchObject({ kind: 'rect', x: expect.closeTo(first.x, 2), y: expect.closeTo(first.y, 2), width: expect.closeTo(first.width, 2) })
  expect(request.regions[0].comment).toBe('First region')
  // The eraser stroke belongs to the second region only.
  expect(request.regions[1].shapes).toHaveLength(3)
  expect(request.regions[1].shapes[0]).toMatchObject({ kind: 'brush' })
  expect(request.regions[1].shapes[0].erase).toBeUndefined()
  expect(request.regions[1].shapes[1]).toMatchObject({ kind: 'brush', erase: true })
  expect(request.regions[1].shapes[1].radius).toBeGreaterThan(0)
  expect(request.regions[1].shapes[2]).toMatchObject({ kind: 'rect', x: expect.closeTo(.25, 2), y: expect.closeTo(.25, 2), width: expect.closeTo(.25, 2) })
  await page.getByRole('button', { name: 'Confirm & submit to provider', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Use as next source', exact: true })).toBeVisible()
  expect(calls.submits).toBe(1)
  expect(calls.polls).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Before', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Before', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Use image for character', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).characterSource)).toEqual({ kind: 'upload', id: 'prepared-2' })
  await page.getByRole('button', { name: 'Use as next source', exact: true }).click()
  await expect(page.getByTestId('editor-image-surface')).toBeVisible()
  expect(calls.prepares).toBe(3)
})

test('lasso, undo/redo, typing isolation and dirty close confirmation', async ({ page }) => {
  await mountEditor(page)
  await page.getByRole('button', { name: 'Lasso', exact: true }).click()
  const box = (await page.getByTestId('editor-image-surface').boundingBox())!
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .2, { steps: 3 })
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .7, { steps: 3 })
  await page.mouse.up()
  await expect(page.locator('.ie-overlay polygon')).toHaveCount(1)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('.ie-overlay polygon')).toHaveCount(0)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(page.locator('.ie-overlay polygon')).toHaveCount(1)
  const comment = page.getByLabel('Instructions for selected region')
  await comment.fill('Zoom + - 0 must remain text')
  await comment.press('0')
  await expect(page.locator('.ie-zoom output')).toHaveText('100%')
  await page.getByRole('button', { name: 'Close editor', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Discard image edits?' })
  await expect(confirmation).toBeVisible()
  await expect(confirmation.getByRole('button', { name: 'Keep editing' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirmation).toHaveCount(0)
  await page.getByRole('button', { name: 'Close editor', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Discard & close' }).click()
  await expect(page.getByRole('button', { name: 'Edit image', exact: true })).toBeVisible()
})

test('local background unavailability stays visible and reframe works without a model on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const calls = await mountEditor(page)
  await page.getByRole('button', { name: 'Background', exact: true }).click()
  await expect(page.getByText('Local removal unavailable: service is not configured or healthy.')).toBeVisible()
  await expect(page.getByRole('option', { name: 'Local (no provider charge)' })).toHaveAttribute('disabled', '')
  await page.getByRole('button', { name: 'Reframe', exact: true }).click()
  await page.getByRole('combobox', { name: 'Processing engine' }).selectOption('local')
  await page.getByLabel('Output width (px)').fill('1000')
  await page.getByRole('button', { name: 'Center source', exact: true }).click()
  await page.getByRole('button', { name: 'Review server preview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply local operation', exact: true })).toBeVisible()
  const frame = calls.requests[0].frame
  expect(calls.requests[0]).toMatchObject({ engine: 'local', operation: 'reframe' })
  expect(frame.width).toBe(1000)
  expect(frame.height).toBe(600)
  expect(Number.isInteger(frame.offsetX)).toBe(true)
  expect(frame.offsetX).toBe(100)
  expect(frame.offsetY).toBe(0)
  expect(calls.requests[0]).not.toHaveProperty('modelId')
  const overflow = await page.getByRole('dialog').evaluate(element => element.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('an unverified mask model offers advisory region edits instead of blocking them', async ({ page }) => {
  const calls = await mountEditor(page)
  const modelSelect = page.getByRole('combobox', { name: 'AI model' })
  await modelSelect.selectOption('advisory')
  await expect(page.getByText('Advisory regions only: this model cannot guarantee exact boundaries, so the whole image may change.')).toBeVisible()
  // A model that cannot carry the source image stays disabled with a reason.
  await expect(modelSelect.locator('option', { hasText: 'Unsupported model' })).toHaveAttribute('disabled', '')
  await stroke(page)
  await page.getByLabel('Instructions for selected region').fill('Advisory edit')
  await page.getByRole('button', { name: 'Review server preview', exact: true }).click()
  await expect(page.getByText('This submission is prompt-directed: no exact mask is sent and the whole image may change.')).toBeVisible()
  expect(calls.requests[0].modelId).toBe('advisory')
})

test('the selected region reports source pixel bounds and clear-all empties every region', async ({ page }) => {
  const calls = await mountEditor(page)
  await page.getByRole('combobox', { name: 'AI model' }).selectOption('model')
  const readout = page.getByTestId('editor-region-coordinates')
  await expect(readout).toContainText('Draw a shape to see the region bounds in source pixels.')
  // 20%..60% of an 800×600 source is about x 160..480, y 120..360.
  await stroke(page, { x: .2, y: .2 }, { x: .6, y: .6 })
  await expect(readout).toContainText('y 120')
  await expect(readout).toContainText('320 × 240 px')
  await page.getByRole('button', { name: 'Add region', exact: true }).click()
  await page.getByRole('button', { name: 'Brush', exact: true }).click()
  await stroke(page, { x: .1, y: .1 }, { x: .2, y: .2 })
  await page.getByLabel('Instructions for selected region').fill('Second')
  await page.getByRole('button', { name: 'Clear all selections', exact: true }).click()
  await expect(readout).toContainText('Draw a shape to see the region bounds in source pixels.')
  // Every region survived but no shape is left, so the request is refused locally.
  await expect(page.getByRole('button', { name: 'Review server preview', exact: true })).toBeDisabled()
  expect(calls.requests).toHaveLength(0)
})

test('an unknown job status stops polling, shows the stored error and returns to editing', async ({ page }) => {
  const calls = await mountEditor(page)
  calls.jobStatus = 'unknown'
  await page.getByRole('combobox', { name: 'AI model' }).selectOption('model')
  await stroke(page)
  await page.getByLabel('Instructions for selected region').fill('Unknown flow')
  await page.getByRole('button', { name: 'Review server preview', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm & submit to provider', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('Queued')
  await expect(page.getByRole('status').first()).toContainText('Status unknown')
  await expect(page.getByRole('alert')).toContainText('The AI provider returned data we cannot use.')
  // Polling stopped: no further job request after the unknown status.
  const polls = calls.polls
  await page.waitForTimeout(2500)
  expect(calls.polls).toBe(polls)
  await page.getByRole('button', { name: 'Back to editing', exact: true }).click()
  await expect(page.getByTestId('editor-image-surface')).toBeVisible()
})

test('a double click on submit never sends the same reviewed request twice', async ({ page }) => {
  const calls = await mountEditor(page)
  await page.getByRole('combobox', { name: 'AI model' }).selectOption('model')
  await stroke(page)
  await page.getByLabel('Instructions for selected region').fill('Double submit')
  await page.getByRole('button', { name: 'Review server preview', exact: true }).click()
  const submit = page.getByRole('button', { name: 'Confirm & submit to provider', exact: true })
  await submit.dblclick()
  await expect(page.getByRole('button', { name: 'Use as next source', exact: true })).toBeVisible()
  expect(calls.submits).toBe(1)
})

test('the reframe ratio presets keep the whole source and never crop', async ({ page }) => {
  const calls = await mountEditor(page)
  await page.getByRole('button', { name: 'Reframe', exact: true }).click()
  // Reframe runs locally by default, so no model is needed for a local frame.
  await page.getByRole('combobox', { name: 'Processing engine' }).selectOption('local')
  const ratio = page.getByRole('combobox', { name: 'Aspect ratio' })
  await ratio.selectOption('9:16')
  // The source is 800×600, so a 9:16 frame grows the long edge and pads the rest.
  const width = Number(await page.getByLabel('Output width (px)').inputValue())
  const height = Number(await page.getByLabel('Output height (px)').inputValue())
  expect(width).toBeGreaterThanOrEqual(800)
  expect(height).toBeGreaterThanOrEqual(600)
  expect(width / height).toBeCloseTo(9 / 16, 1)
  await page.getByRole('button', { name: 'Review server preview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply local operation', exact: true })).toBeVisible()
  const frame = calls.requests[0].frame
  expect(frame.width).toBe(width)
  expect(frame.height).toBe(height)
  // The whole source is inside the frame, so nothing is cropped.
  expect(frame.offsetX).toBeGreaterThanOrEqual(0)
  expect(frame.offsetY).toBeGreaterThanOrEqual(0)
  expect(frame.scale).toBeLessThanOrEqual(1)
})

test('the editor renders on desktop and mobile without overflowing the viewport', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800, name: 'desktop' }, { width: 390, height: 844, name: 'mobile' }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await mountEditor(page)
    await page.getByRole('combobox', { name: 'AI model' }).selectOption('model')
    await stroke(page, { x: .2, y: .2 }, { x: .55, y: .55 })
    await page.getByLabel('Instructions for selected region').fill('Make the sky warmer')
    await expect(page.getByTestId('editor-region-coordinates')).toContainText('x 160, y 120')
    // Artifacts only: the repository screenshots folder is never touched.
    await page.screenshot({ path: test.info().outputPath(`image-editor-${viewport.name}.png`), fullPage: false })
    const overflow = await page.getByRole('dialog').evaluate(element => element.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    // Every control stays fully inside the dialog, including on a narrow screen.
    const clipped = await page.evaluate(() => {
      const dialog = document.querySelector('.ie-modal') as HTMLElement
      const bounds = dialog.getBoundingClientRect()
      return [...dialog.querySelectorAll('button, select, input, textarea')]
        .filter(element => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && (rect.right > bounds.right + 1 || rect.left < bounds.left - 1)
        })
        .map(element => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName)
    })
    expect(clipped).toEqual([])
  }
})

test('a draw after an eraser re-adds the area, matching the sequential server mask', async ({ page }) => {
  const calls = await mountEditor(page)
  await page.getByRole('combobox', { name: 'AI model' }).selectOption('model')
  // draw -> erase -> draw on the same spot: the last draw wins, like the server.
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await stroke(page, { x: .2, y: .2 }, { x: .6, y: .6 })
  await page.getByRole('button', { name: 'Eraser (selected region only)', exact: true }).click()
  await stroke(page, { x: .3, y: .3 }, { x: .5, y: .5 })
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await stroke(page, { x: .3, y: .3 }, { x: .5, y: .5 })
  await page.getByLabel('Instructions for selected region').fill('Sequential strokes')
  // The overlay paints the shapes in order: the last white shape covers the black one.
  const painted = await page.evaluate(() => [...document.querySelectorAll('.ie-overlay mask > *')]
    .map(node => {
      const stroke = node.getAttribute('stroke')
      const fill = node.getAttribute('fill')
      return stroke && stroke !== 'none' ? stroke : fill
    })
    .filter(value => value && value !== 'none'))
  expect(painted.slice(-3)).toEqual(['#ffffff', '#000000', '#ffffff'])
  await page.getByRole('button', { name: 'Review server preview', exact: true }).click()
  await expect(page.getByText('Server exact compiled prompt')).toBeVisible()
  const shapes = calls.requests[0].regions[0].shapes
  expect(shapes).toHaveLength(3)
  // The wire format keeps the order, so the server replays the same sequence.
  expect(shapes.map((shape: { erase?: boolean }) => Boolean(shape.erase))).toEqual([false, true, false])
})

test('missing editable source keeps the lightbox view-only', async ({ page }) => {
  const calls = await mountEditor(page, false)
  await expect(page.getByRole('button', { name: 'Edit image', exact: true })).toHaveCount(0)
  expect(calls.prepares).toBe(0)
})
