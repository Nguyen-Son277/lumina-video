import { expect, test, type Locator, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import type { Generation } from '../src/api/types'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

// Large, differently shaped assets expose fixed-height/cropped previews that 1×1 mocks miss.
// The tiny, silent VP9 fixtures were generated with ffmpeg's color source at 2fps for 1s.
const shapes = [
  { name: 'landscape', width: 1920, height: 1080 },
  { name: 'square', width: 1080, height: 1080 },
  { name: 'portrait', width: 1080, height: 1920 },
] as const
const sessionRoot = (page: Page) => page.locator('.studio-page:not(.quick-home):not(.quick-home-composer)')

async function openFixtureSession(page: Page, kind: 'image' | 'video') {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: `natural-${kind}`, kind })
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Natural media geometry' } })
  expect(response.status()).toBe(201)
  const { session } = await response.json()
  const now = Date.now()
  const jobs: Generation[] = shapes.map((shape, index) => ({
    id: `natural-${shape.name}`, kind, quickSessionId: session.id, modelId,
    prompt: `Natural ${shape.name} ${kind}`, params: {}, provider: 'Test', model: `natural-${kind}`,
    status: 'succeeded', progress: 100, errorCode: null, errorMessage: null, errorMessageKey: 'errors.unknown',
    providerJobId: null, createdAt: now - index, updatedAt: now, completedAt: now,
    assets: [{ id: `asset-${shape.name}`, url: `/__quick-media/${shape.name}.${kind === 'image' ? 'svg' : 'webm'}`,
      byteSize: 1500, mimeType: kind === 'image' ? 'image/svg+xml' : 'video/webm' }],
  }))
  jobs.push({ ...jobs[0]!, id: 'natural-pending', prompt: 'Pending media placeholder', status: 'queued', progress: 0, assets: [], completedAt: null })

  await page.route('**/__quick-media/*', async route => {
    const shape = shapes.find(item => new URL(route.request().url()).pathname.includes(item.name))!
    if (kind === 'video') {
      await route.fulfill({ contentType: 'video/webm', path: fileURLToPath(new URL(`./fixtures/quick-${shape.name}.webm`, import.meta.url)) })
    } else {
      await route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${shape.width}" height="${shape.height}"><rect width="100%" height="100%" fill="#8760b0"/><circle cx="50%" cy="50%" r="200" fill="#ffa500"/></svg>` })
    }
  })
  await page.route('**/api/generations?**', route => route.fulfill({ json: { generations: jobs } }))
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  if (kind === 'video') await sessionRoot(page).locator('.mode-tabs button').nth(1).click()
  await expect(sessionRoot(page).locator('.quick-results-list .creation-card')).toHaveCount(4)
}

async function expectNaturalGeometry(card: Locator, kind: 'image' | 'video', shape: typeof shapes[number], wide: boolean) {
  const media = card.locator(kind === 'image' ? '.creation-image img' : '.creation-image > video')
  await media.scrollIntoViewIfNeeded()
  await expect.poll(() => media.evaluate(element => {
    if (element instanceof HTMLImageElement) return element.complete ? [element.naturalWidth, element.naturalHeight] : [0, 0]
    const video = element as HTMLVideoElement
    return video.readyState >= 1 ? [video.videoWidth, video.videoHeight] : [0, 0]
  })).toEqual([shape.width, shape.height])

  await expect.poll(() => media.evaluate((element, expected) => {
    const rect = element.getBoundingClientRect()
    const wrapper = element.closest('.creation-image')!.getBoundingClientRect()
    const zoom = element.closest('.creation-zoom')?.getBoundingClientRect()
    const naturalHeight = rect.width * expected.height / expected.width
    return rect.width > 0 && rect.height > 0
      && (!expected.wide || rect.width > 500)
      && (!expected.wide || expected.width >= expected.height || rect.height > 500)
      && Math.abs(rect.height - naturalHeight) <= 2
      && Math.abs(rect.width - wrapper.width) <= 1
      && Math.abs(rect.height - wrapper.height) <= 1
      && Math.abs(rect.left - wrapper.left) <= 1
      && Math.abs(rect.top - wrapper.top) <= 1
      && (!zoom || (Math.abs(zoom.height - rect.height) <= 1 && Math.abs(zoom.width - rect.width) <= 1))
  }, { width: shape.width, height: shape.height, wide }), {
    message: `${kind} ${shape.name} must fill its slot without a 500px cap, distortion or wrapper cropping`,
  }).toBe(true)
}

for (const kind of ['image', 'video'] as const) {
  test(`quick session ${kind} previews use natural landscape, square and portrait geometry at desktop and mobile sizes`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFixtureSession(page, kind)
    const root = sessionRoot(page)
    const results = root.locator('.quick-session-results')
    const desktopWidths: Record<number, number[]> = {}
    for (const width of [1440, 1920, 1201, 1200, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await page.mouse.move(0, 0)
      await expect.poll(() => root.locator('.studio-grid:visible').evaluate(element =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length,
      )).toBe(width > 1200 ? 2 : 1)
      for (const shape of shapes) {
        const card = results.locator(`[data-generation-id="natural-${shape.name}"]`)
        await expectNaturalGeometry(card, kind, shape, width >= 1440)
      }
      if (width >= 1440) desktopWidths[width] = await results.locator('.creation-image img, .creation-image > video').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
      const pending = results.locator('[data-generation-id="natural-pending"] .creation-image')
      await expect(pending.locator('.creation-placeholder')).toBeVisible()
      await expect.poll(() => pending.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return Math.abs(rect.height - rect.width * 9 / 16)
      })).toBeLessThanOrEqual(1)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
      if (width === 1440) {
        await expectNaturalGeometry(results.locator('[data-generation-id="natural-landscape"]'), kind, shapes[0], true)
        const screenshot = testInfo.outputPath(`quick-natural-${kind}-1440.png`)
        await page.screenshot({ path: screenshot, animations: 'disabled' })
        await testInfo.attach(`quick-natural-${kind}-1440`, { path: screenshot, contentType: 'image/png' })
      }
    }
    expect(desktopWidths[1440]).toHaveLength(3)
    expect(desktopWidths[1920]).toHaveLength(3)
    for (let index = 0; index < shapes.length; index++) {
      expect(desktopWidths[1920]![index]! - desktopWidths[1440]![index]!, 'media should grow with the available desktop result column').toBeGreaterThan(100)
    }
    // Shared card hover rules must not reintroduce zoom/cropping for session images.
    if (kind === 'image') {
      await page.setViewportSize({ width: 1440, height: 900 })
      const card = results.locator('[data-generation-id="natural-portrait"]')
      await card.hover()
      await expectNaturalGeometry(card, kind, shapes[2], true)
    }
  })
}
