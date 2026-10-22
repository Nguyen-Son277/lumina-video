import { expect, test, type Page } from '@playwright/test'

// Exercise the real shared viewer and production styles without generating paid
// images. Large fixtures catch intrinsic grid rows that 1×1 mock images cannot.
const dimensions = [
  { width: 1080, height: 1920 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 1024 },
  { width: 600, height: 6000 },
  { width: 6000, height: 600 },
  { width: 120, height: 200 },
]

async function mountViewer(page: Page, editable = false) {
  await page.route('**/__lightbox-fit', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head></head><body><div id="fit-fixture"></div></body></html>',
  }))
  await page.goto('/__lightbox-fit')
  await page.evaluate(async (editable) => {
    const load = (path: string) => import(path)
    const refresh = await load('/@react-refresh')
    refresh.default.injectIntoGlobalHook(window)
    const w = window as any
    w.$RefreshReg$ = () => {}; w.$RefreshSig$ = () => (type: unknown) => type
    w.__vite_plugin_react_preamble_installed__ = true

    const source = await (await fetch('/src/components/Lightbox.tsx')).text()
    const reactUrl = source.match(/"([^" ]*\/react\.js\?v=[^" ]+)"/)?.[1]
    if (!reactUrl) throw new Error('Cannot resolve viewer React dependency URL')
    const hash = new URL(reactUrl, location.origin).search
    const [React, ReactDOM, { ImageLightbox }] = await Promise.all([
      load(reactUrl), load(`/node_modules/.vite/deps/react-dom_client.js${hash}`), load('/src/components/Lightbox.tsx'),
    ])
    for (const path of ['/src/styles.css', '/src/styles/entity-card.css', '/src/locations.css', '/src/styles/scene-results.css']) {
      await new Promise<void>((resolve, reject) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'; link.href = `${path}?direct`
        link.onload = () => resolve(); link.onerror = () => reject(new Error(`Cannot load ${path}`))
        document.head.appendChild(link)
      })
    }
    const R = React.default ?? React, h = R.createElement
    const root = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(document.getElementById('fit-fixture'))
    function Fixture() {
      const [src, setSrc] = R.useState(''), [open, setOpen] = R.useState(false)
      w.setFitImage = (url: string) => { setSrc(url); setOpen(true) }
      // Thumbnail crop/transform rules must never affect the portalled viewer.
      return h('article', { className: 'creation-card' },
        h('div', { className: 'creation-image' },
          h('button', { id: 'fit-opener', type: 'button', onClick: () => setOpen(true) }, 'Open image'),
          open && h(ImageLightbox, { src, alt: 'Fit fixture', downloadHref: src,
            editableSource: editable ? { kind: 'upload', id: 'lightbox-layout-fixture' } : undefined,
            onClose: () => setOpen(false) })))
    }
    root.render(h(Fixture))
  }, editable)
  await expect(page.locator('#fit-opener')).toBeVisible()
  await page.locator('#fit-opener').focus()
}

async function showImage(page: Page, width: number, height: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#8760b0"/><path d="M0 0H${width}V${height}H0Z" fill="none" stroke="#fff" stroke-width="12"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#ffa500"/></svg>`
  const src = `data:image/svg+xml,${encodeURIComponent(svg)}`
  await page.evaluate(url => (window as any).setFitImage(url), src)
  await expect(page.locator('.lightbox-image')).toHaveAttribute('src', src)
  await page.locator('.lightbox-image').evaluate(async image => { await (image as HTMLImageElement).decode() })
  return src
}

async function expectFitted(page: Page, width: number, height: number) {
  await expect(page.locator('.lightbox-percent')).toHaveText('100%')
  await expect.poll(async () => page.locator('.lightbox-image').evaluate((element, size) => {
    const image = element as HTMLImageElement
    const rect = image.getBoundingClientRect(), stage = image.parentElement!
    const bounds = stage.getBoundingClientRect(), style = getComputedStyle(stage)
    const left = bounds.left + parseFloat(style.paddingLeft), right = bounds.right - parseFloat(style.paddingRight)
    const top = bounds.top + parseFloat(style.paddingTop), bottom = bounds.bottom - parseFloat(style.paddingBottom)
    const fit = Math.min(1, (right - left) / size.width, (bottom - top) / size.height)
    return image.naturalWidth === size.width && image.naturalHeight === size.height
      && Math.abs(rect.width - size.width * fit) < 1 && Math.abs(rect.height - size.height * fit) < 1
      && rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= top - 1 && rect.bottom <= bottom + 1
      && Math.abs((rect.left + rect.right - left - right) / 2) < 1
      && Math.abs((rect.top + rect.bottom - top - bottom) / 2) < 1
  }, { width, height })).toBe(true)
  const toolbar = await page.locator('.lightbox-toolbar').boundingBox()
  expect(toolbar!.y).toBeGreaterThanOrEqual(0)
  expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
}

for (const locale of ['vi', 'en'] as const) {
  test(`edit action stays readable and keyboard accessible in ${locale}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('lumina.locale', value), locale)
    await mountViewer(page, true)
    await showImage(page, 1080, 1920)
    const edit = page.getByRole('button', { name: locale === 'vi' ? 'Chỉnh sửa ảnh' : 'Edit image', exact: true })
    for (const viewport of [
      { width: 320, height: 640 }, { width: 390, height: 844 },
      { width: 1280, height: 720 }, { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport)
      await expect(edit).toBeVisible()
      await expectFitted(page, 1080, 1920)
      expect(await edit.evaluate(button => {
        const bounds = button.getBoundingClientRect()
        const label = button.querySelector('span')!
        const text = label.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(label)
        return bounds.height >= 44 && range.getClientRects().length === 1
          && text.left >= bounds.left && text.right <= bounds.right
          && text.top >= bounds.top && text.bottom <= bounds.bottom
          && button.scrollWidth <= button.clientWidth
      })).toBe(true)
      const controls = await page.locator('.lightbox-toolbar button, .lightbox-toolbar a').evaluateAll(elements =>
        elements.map(element => {
          const { left, right, top, bottom } = element.getBoundingClientRect()
          return { left, right, top, bottom }
        }))
      for (const [index, bounds] of controls.entries()) {
        expect(bounds.left).toBeGreaterThanOrEqual(0)
        expect(bounds.right).toBeLessThanOrEqual(viewport.width)
        expect(bounds.top).toBeGreaterThanOrEqual(0)
        expect(bounds.bottom).toBeLessThanOrEqual(viewport.height)
        for (const other of controls.slice(index + 1)) {
          expect(bounds.right <= other.left || other.right <= bounds.left
            || bounds.bottom <= other.top || other.bottom <= bounds.top).toBe(true)
        }
      }
    }
    await page.locator('.lightbox-zoom button').first().focus()
    for (let index = 0; index < 3; index++) await page.keyboard.press('Tab')
    await expect(edit).toBeFocused()
    expect(await edit.evaluate(button => getComputedStyle(button).outlineStyle)).toBe('solid')
  })
}

test('view-only images do not offer the edit action', async ({ page }) => {
  await mountViewer(page)
  await showImage(page, 1024, 1024)
  await expect(page.locator('.lightbox-edit-button')).toHaveCount(0)
})

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`shared lightbox fits natural image ratios at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await mountViewer(page)
    for (const size of dimensions) {
      await test.step(`${size.width}×${size.height}`, async () => {
        await showImage(page, size.width, size.height)
        await expectFitted(page, size.width, size.height)
      })
    }
  })
}

test('portrait remains fitted after zoom, pan, reset, resize, source change and reopening', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await mountViewer(page)
  const src = await showImage(page, 1080, 1920)
  await expectFitted(page, 1080, 1920)
  await expect(page.locator('.lightbox-actions a')).toHaveAttribute('href', src)
  const viewer = page.locator('.lightbox-backdrop')
  await viewer.getByRole('button', { name: 'Phóng to', exact: true }).click()
  await expect(page.locator('.lightbox-percent')).toHaveText('125%')
  await viewer.getByRole('button', { name: 'Thu nhỏ', exact: true }).click()
  await expectFitted(page, 1080, 1920)

  await page.locator('.lightbox-image').dblclick()
  await expect(page.locator('.lightbox-percent')).toHaveText('200%')
  const stage = (await page.locator('.lightbox-stage').boundingBox())!
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await page.mouse.down()
  await page.mouse.move(stage.x + stage.width / 2 + 50, stage.y + stage.height / 2 + 80, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => page.locator('.lightbox-image').evaluate(image => new DOMMatrix(getComputedStyle(image).transform).m42)).not.toBe(0)
  await viewer.getByRole('button', { name: 'Về kích thước vừa khung', exact: true }).click()
  await expectFitted(page, 1080, 1920)

  await page.locator('.lightbox-stage').hover()
  await page.mouse.wheel(0, -100)
  await expect(page.locator('.lightbox-percent')).toHaveText('125%')
  await page.keyboard.press('0')
  await expectFitted(page, 1080, 1920)
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    await expectFitted(page, 1080, 1920)
  }
  await page.keyboard.press('+')
  await expect(page.locator('.lightbox-percent')).toHaveText('125%')
  await showImage(page, 1920, 1080)
  await expectFitted(page, 1920, 1080)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(page.locator('#fit-opener')).toBeFocused()
  await page.locator('#fit-opener').click()
  await expectFitted(page, 1920, 1080)
  await viewer.getByRole('button', { name: 'Đóng', exact: true }).click()
  await expect(viewer).toHaveCount(0)
})
