import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'
import type { Generation } from '../src/api/types'

async function setup(page: import('@playwright/test').Page) {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'video-test', kind: 'video' })
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Progress session' } })
  const { session } = await response.json()
  const job: Generation = {
    id: 'video-progress', kind: 'video', quickSessionId: session.id, modelId,
    prompt: 'A cat runs across the garden', params: {}, provider: 'Test', model: 'video-test',
    status: 'queued', progress: 0, assets: [], errorCode: null, errorMessage: null,
    errorMessageKey: 'errors.unknown', providerJobId: null,
    createdAt: Date.now(), updatedAt: Date.now(), completedAt: null,
  }
  return { job, session }
}

test('video has persistent visible progress from sending to completion and after reload', async ({ page }) => {
  const { job, session } = await setup(page)
  let jobs: Generation[] = []
  let release: (() => void) | undefined
  const sent = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/generations*', async route => {
    if (route.request().method() === 'POST') {
      await sent
      jobs = [job]
      await route.fulfill({ json: { generation: job }, status: 202 })
    } else await route.fulfill({ json: { generations: jobs } })
  })
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('.mode-tabs button').nth(1).click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill(job.prompt)
  await page.locator('.generate-button').click()
  const banner = page.locator('.quick-video-activity')
  await expect(banner).toContainText('Đang gửi yêu cầu tạo video')
  await expect(banner.locator('.spin')).toBeVisible()
  release!()
  await expect(banner).toContainText('1 tác vụ đang chạy')
  const card = page.locator('.quick-results-list .creation-card').first()
  await expect(card.locator('.video-processing-placeholder .spin')).toBeVisible()
  await expect(card.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  await expect(card.locator('.is-indeterminate')).toBeVisible()
  await expect(card.locator('.video-indicator')).toHaveCount(0)
  await expect(card.locator('.card-error')).toHaveCount(0)
  job.status = 'running'; job.progress = 35; job.updatedAt += 1000
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35', { timeout: 8000 })
  await expect(banner).toContainText('35%')
  await page.reload()
  await page.locator('.mode-tabs button').nth(1).click()
  await expect(banner).toContainText('1 tác vụ đang chạy')
  await page.setViewportSize({ width: 390, height: 844 })
  await banner.getByRole('button', { name: 'Xem tiến trình', exact: true }).click()
  await expect(card).toBeInViewport()
  // Evidence goes to gitignored test-results so a normal E2E run never dirties shots/.
  await page.screenshot({ path: 'test-results/video-progress-mobile.png', fullPage: true })
  job.status = 'downloading'; job.progress = 100; job.updatedAt += 1000
  await expect(banner).toContainText('Đang tải kết quả', { timeout: 8000 })
  await expect(card.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  job.status = 'succeeded'; job.updatedAt += 1000
  job.assets = [{ id: 'asset', url: '/fake-result.mp4', byteSize: 32, mimeType: 'video/mp4' }]
  await expect(banner).toHaveCount(0, { timeout: 8000 })
  await expect(card.locator('video')).toBeVisible()
  await expect(card.locator('.spin')).toHaveCount(0)
  await expect(card.locator('.card-error')).toHaveCount(0)
})

test('unknown Agnes submission exposes HTTP reason and request ID without a retry control', async ({ page }) => {
  const { job, session } = await setup(page)
  job.status = 'unknown'; job.errorCode = 'OUTCOME_UNKNOWN'
  job.errorMessageKey = 'agnes.submit_http_unknown'
  job.errorMessageParams = { status: 503, detail: 'Upstream unavailable', requestId: 'req-123' }
  await page.route('**/api/generations*', route => route.fulfill({ json: { generations: [job] } }))
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('.mode-tabs button').nth(1).click()
  const card = page.locator('.quick-results-list .creation-card')
  await expect(card.locator('.card-error')).toContainText('HTTP 503')
  await expect(card.locator('.card-error')).toContainText('Upstream unavailable')
  await expect(card.locator('.card-diagnostic')).toContainText('req-123')
  await expect(card.locator('.card-unknown-hint')).toContainText('Kiểm tra lịch sử tác vụ')
  await expect(card.locator('.spin')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Tải lại kết quả', exact: true })).toHaveCount(0)
  await page.locator('.topbar select').selectOption('en')
  await expect(card.locator('.card-error')).toContainText('Agnes returned HTTP 503')
  await expect(card.locator('.card-unknown-hint')).toContainText('Check your task history')
})

test('multiple jobs count correctly and terminal states stop animation', async ({ page }) => {
  const { job, session } = await setup(page)
  const second = { ...job, id: 'second', prompt: 'Another prompt', createdAt: job.createdAt + 1 }
  const jobs = [second, job]
  await page.route('**/api/generations*', route => route.fulfill({ json: { generations: jobs } }))
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('.mode-tabs button').nth(1).click()
  const banner = page.locator('.quick-video-activity')
  await expect(banner).toContainText('2 tác vụ đang chạy')
  await page.locator('.mode-tabs button').first().click()
  await expect(banner).toHaveCount(0)
  await page.locator('.mode-tabs button').nth(1).click()
  await expect(banner).toContainText('2 tác vụ đang chạy')
  second.status = 'failed'; second.errorCode = 'PROVIDER_FAILED'; second.errorMessage = 'Failed to generate'; second.updatedAt += 1000
  job.status = 'unknown'; job.errorCode = 'OUTCOME_UNKNOWN'; job.updatedAt += 1000
  await expect(banner).toHaveCount(0, { timeout: 8000 })
  await expect(page.locator('.quick-results-list .spin')).toHaveCount(0)
  await expect(page.locator('.quick-results-list [role=progressbar]')).toHaveCount(0)
  await expect(page.locator('.quick-results-list .card-error')).toHaveCount(2)
})

test('switching sessions discards an old delayed poll response', async ({ page }) => {
  const { job, session } = await setup(page)
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Other session' } })
  const { session: other } = await response.json()
  let hold = false
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  let finished: (() => void) | undefined
  const requested = new Promise<void>(resolve => { started = resolve })
  const delayed = new Promise<void>(resolve => { release = resolve })
  const completed = new Promise<void>(resolve => { finished = resolve })
  await page.route('**/api/generations*', async route => {
    const id = new URL(route.request().url()).searchParams.get('quickSessionId')
    if (id === session.id && hold) {
      hold = false; started!(); await delayed
      await route.fulfill({ json: { generations: [job] } }); finished!(); return
    }
    await route.fulfill({ json: { generations: id === session.id ? [job] : [] } })
  })
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('.mode-tabs button').nth(1).click()
  await expect(page.locator('.quick-video-activity')).toContainText('1 tác vụ đang chạy')
  hold = true
  await requested
  await page.getByRole('combobox', { name: 'Phiên', exact: true }).selectOption(other.id)
  await expect(page.getByRole('heading', { name: 'Phiên này chưa có video' })).toBeVisible()
  release!(); await completed
  await expect(page.locator('.quick-video-activity')).toHaveCount(0)
  await expect(page.locator('.quick-results-list .creation-card')).toHaveCount(0)
})

test('a slow list response never removes a newly submitted job', async ({ page }) => {
  const { job, session } = await setup(page)
  let pendingResponse: (() => void) | undefined
  let requested: (() => void) | undefined
  const requestStarted = new Promise<void>(resolve => { requested = resolve })
  const wait = new Promise<void>(resolve => { pendingResponse = resolve })
  let hasJob = false
  let holdNext = false
  await page.route('**/api/generations*', async route => {
    if (route.request().method() === 'POST') { job.createdAt = Date.now(); job.updatedAt = job.createdAt; hasJob = true; await route.fulfill({ status: 202, json: { generation: job } }); return }
    const url = new URL(route.request().url())
    if (url.searchParams.has('quickSessionId')) {
      if (holdNext) { holdNext = false; requested!(); await wait; await route.fulfill({ json: { generations: [] } }); return }
    }
    await route.fulfill({ json: { generations: hasJob ? [job] : [] } })
  })
  await page.goto(`${BASE}/?page=quick&session=${session.id}`)
  await page.locator('.mode-tabs button').nth(1).click()
  await page.getByPlaceholder('Mô tả điều bạn muốn tạo...').fill(job.prompt)
  await expect(page.locator('.generate-button')).toBeEnabled()
  holdNext = true
  await requestStarted
  await page.locator('.generate-button').click()
  await expect(page.locator('.quick-video-activity')).toContainText('1 tác vụ đang chạy')
  pendingResponse!()
  await expect(page.locator('.quick-results-list .creation-card')).toHaveCount(1)
  await expect(page.locator('.quick-video-activity')).toContainText('1 tác vụ đang chạy')
})
