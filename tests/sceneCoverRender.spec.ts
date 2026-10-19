import { expect, test } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5202'

test('SceneCover renders video, falls back to illustration and placeholder, and resets on URL change', async ({ page }) => {
  // The shell may fail while its unrelated Usage modules are unavailable. Vite can
  // still transform and serve this isolated component directly from the browser.
  await page.goto(BASE)
  await page.setContent('<!doctype html><html><body></body></html>')
  // Hold each media request so native loading cannot race our explicit errors.
  let releaseMedia!: () => void
  const mediaGate = new Promise<void>((resolve) => { releaseMedia = resolve })
  const heldMedia: import('@playwright/test').Route[] = []
  const holdMedia = async (route: import('@playwright/test').Route) => {
    heldMedia.push(route)
    await mediaGate
    await route.abort().catch(() => {})
  }
  await page.route('**/first.mp4', holdMedia)
  await page.route('**/second.mp4', holdMedia)
  await page.route('**/*.jpg', async (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'),
  }))
  await page.addStyleTag({ content: '#scene-cover-test-root img { width: 100px; height: 60px; }' })

  try {
  await page.evaluate(async () => {
    const [reactDom, React, { default: SceneCover }] = await Promise.all([
      import('/node_modules/.vite/deps/react-dom_client.js'),
      import('/node_modules/.vite/deps/react.js'),
      import('/src/components/SceneCover.tsx'),
    ])
    const createRoot = (reactDom as any).createRoot ?? (reactDom as any).default?.createRoot
    const react = (React as any).default ?? React
    if (typeof createRoot !== 'function') throw new Error(`ReactDOM exports: ${Object.keys(reactDom).join(',')}`)
    const target = document.createElement('div')
    target.id = 'scene-cover-test-root'
    target.style.cssText = 'width: 160px; height: 90px; display: block;'
    document.body.appendChild(target)
    const root = createRoot(target)
    ;(window as any).__sceneCoverRoot = root
    ;(window as any).__SceneCover = SceneCover
    ;(window as any).__React = react
    root.render(react.createElement(SceneCover, { videoUrl: '/first.mp4', illustrationUrl: '/first.jpg', alt: 'Scene one', badge: 'Cover' }))
  })

  const cover = page.locator('#scene-cover-test-root')
  const video = cover.locator('video')
  await expect(video).toBeVisible()
  await expect(video).toHaveAttribute('src', '/first.mp4')
  await video.evaluate((el: HTMLVideoElement) => el.dispatchEvent(new Event('error')))

  const image = cover.locator('img')
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute('src', '/first.jpg')
  await expect(cover.getByText('Cover')).toBeVisible()
  await image.evaluate((el: HTMLImageElement) => el.dispatchEvent(new Event('error')))
  await expect(cover.locator('.project-scene-cover-placeholder')).toBeVisible()

  const renderCover = (videoUrl: string, illustrationUrl = '/first.jpg') => page.evaluate(({ url, imageUrl }) => {
    const w = window as any
    w.__sceneCoverRoot.render(w.__React.createElement(w.__SceneCover, { videoUrl: url, illustrationUrl: imageUrl, alt: 'Scene one', badge: 'Cover' }))
  }, { url: videoUrl, imageUrl: illustrationUrl })
  await renderCover('/second.mp4', '/second.jpg')
  await expect(cover.locator('video')).toBeVisible()
  await expect(cover.locator('video')).toHaveAttribute('src', '/second.mp4')

  // A should retry its video after switching A -> B -> A.
  await renderCover('/first.mp4')
  await expect(cover.locator('video')).toBeVisible()
  await expect(cover.locator('video')).toHaveAttribute('src', '/first.mp4')
  } finally {
    releaseMedia()
    await Promise.all(heldMedia.map((route) => route.abort().catch(() => {})))
  }
})
