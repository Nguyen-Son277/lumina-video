import { expect, test, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'
import type { Generation } from '../src/api/types'

async function setup(page: Page) {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'logo-image-test', kind: 'image' })
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Logo output session' } })
  const { session } = await response.json()
  const now = Date.now()
  const original = { id: 'original', variant: 'original', url: '/logo-test-original.png', mimeType: 'image/png', byteSize: 80 }
  const derived = { id: 'derived', variant: 'logo_overlay', sourceAssetId: original.id, url: '/logo-test-derived.png', mimeType: 'image/png', byteSize: 96 }
  const job: Generation = {
    id: 'logo-output', kind: 'image', quickSessionId: session.id, modelId, prompt: 'A branded product',
    provider: 'Test', model: 'logo-image-test', params: {}, status: 'succeeded', progress: 100,
    createdAt: now, updatedAt: now, completedAt: now, errorCode: null, errorMessage: null,
    providerJobId: null, postprocessStatus: 'succeeded', assets: [derived, original],
  }
  await page.route('**/logo-test-*.png*', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64') }))
  return { job, session, original, derived }
}

test('failed library publication can retry without a new provider request', async ({ page }) => {
  const { job, session, original } = await setup(page)
  job.imagePurpose = { kind: 'item', name: 'Product', description: '' }
  job.libraryPublishStatus = 'failed'
  job.libraryPublishError = 'private diagnostic'
  job.assets = [original]
  let retries = 0
  await page.route('**/api/generations**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/retry-library-publication')) {
      retries += 1
      job.libraryPublishStatus = 'queued'
      job.libraryPublishError = null
      job.updatedAt += 1
      await route.fulfill({ json: { generation: job } })
      return
    }
    if (path.endsWith(`/${job.id}`)) return route.fulfill({ json: { generation: job } })
    if (route.request().method() === 'GET') return route.fulfill({ json: { generations: [job] } })
    await route.continue()
  })
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  const card = page.locator('.page-content.studio-page:not(.quick-home) .creation-card').filter({ hasText: job.prompt })
  await expect(card).toContainText('Chưa lưu được ảnh vào thư viện')
  await expect(card).not.toContainText('private diagnostic')
  await card.getByRole('button', { name: /Thử lưu thư viện lại/ }).click()
  await expect(card).toContainText('Đang chờ lưu ảnh hoàn chỉnh')
  expect(retries).toBe(1)
})

test('result variants select matching preview, download and lightbox without changing plain cards', async ({ page }) => {
  const { job, session, original, derived } = await setup(page)
  const plain = { ...job, id: 'plain-output', prompt: 'An unbranded product', postprocessStatus: null, assets: [original] }
  await page.route('**/api/generations**', route => route.fulfill({ json: { generations: [job, plain] } }))
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  const card = page.locator('.creation-card').filter({ hasText: job.prompt })
  const other = page.locator('.creation-card').filter({ hasText: plain.prompt })
  await expect(card.locator('.creation-zoom img')).toHaveAttribute('src', derived.url)
  await expect(card.getByRole('button', { name: 'Bản ghép logo', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(other.getByRole('button', { name: 'Bản gốc', exact: true })).toHaveCount(0)
  await expect(other.getByRole('progressbar')).toHaveCount(0)
  await card.getByRole('button', { name: 'Bản gốc', exact: true }).click()
  await expect(card.locator('.creation-zoom img')).toHaveAttribute('src', original.url)
  await expect(card.getByRole('link', { name: 'Tải xuống', exact: true })).toHaveAttribute('href', `${original.url}?download=1`)
  await card.locator('.creation-zoom').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('img')).toHaveAttribute('src', original.url)
  await expect(dialog.getByRole('link', { name: 'Tải xuống', exact: true })).toHaveAttribute('href', `${original.url}?download=1`)
  await page.keyboard.press('Escape')
  await card.getByRole('button', { name: 'Bản ghép logo', exact: true }).click()
  await expect(card.getByRole('link', { name: 'Tải xuống', exact: true })).toHaveAttribute('href', `${derived.url}?download=1`)
  await page.locator('.topbar select').selectOption('en')
  await expect(card.getByRole('button', { name: 'Logo-composited', exact: true })).toBeVisible()
})

test('failed local overlay keeps original, retries only overlay and polls after provider completion', async ({ page }) => {
  const { job, session, original, derived } = await setup(page)
  job.postprocessStatus = 'failed'
  job.postprocessError = 'Private diagnostic must not appear'
  job.assets = [original]
  let retries = 0
  let polls = 0
  let providerCreates = 0
  await page.route('**/api/generations**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/retry-overlay')) {
      retries++
      job.postprocessStatus = 'queued'; job.updatedAt += 1
      await route.fulfill({ json: { generation: job } })
    } else if (path.endsWith(`/${job.id}`)) {
      polls++
      job.updatedAt += 1
      job.postprocessStatus = polls === 1 ? 'running' : 'succeeded'
      if (polls > 1) job.assets = [derived, original]
      await route.fulfill({ json: { generation: job } })
    } else if (route.request().method() === 'POST') {
      providerCreates++
      await route.fulfill({ status: 500, json: {} })
    } else await route.fulfill({ json: { generations: [job] } })
  })
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  const card = page.locator('.creation-card').filter({ hasText: job.prompt })
  await expect(card.locator('.card-error')).toContainText('Bản gốc vẫn được giữ')
  await expect(card).not.toContainText('Private diagnostic')
  await expect(card.locator('.creation-zoom img')).toHaveAttribute('src', original.url)
  await expect(card.getByRole('button', { name: 'Tải lại kết quả', exact: true })).toHaveCount(0)
  await card.getByRole('button', { name: 'Thử ghép logo lại', exact: true }).click()
  await expect(card).toContainText('Đang chờ ghép logo')
  await expect(card.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  await expect(card).toContainText('Đang ghép logo trên máy chủ', { timeout: 8000 })
  await expect(card.getByRole('button', { name: 'Bản ghép logo', exact: true })).toBeVisible({ timeout: 8000 })
  await expect(card.locator('.creation-zoom img')).toHaveAttribute('src', derived.url)
  await expect(card.getByRole('progressbar')).toHaveCount(0)
  await expect(card.locator('.card-error')).toHaveCount(0)
  expect(retries).toBe(1)
  expect(polls).toBe(2)
  expect(providerCreates).toBe(0)
})
