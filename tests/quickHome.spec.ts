import { expect, test, type Locator, type Page } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

type Created = { id: string; quickSessionId: string; prompt: string }
const home = (page: Page) => page.getByTestId('quick-home')
const sessionView = (page: Page) => page.locator('.page-content.studio-page:not(.quick-home)')
const prompt = (root: Locator) => root.locator('.composer-body > .prompt-box textarea')

async function models(page: Page) {
  const provider = await seedProvider(page)
  return {
    image: await seedModel(page, provider, { modelId: 'quick-home-image', displayName: 'Home Image', kind: 'image' }),
    video: await seedModel(page, provider, { modelId: 'quick-home-video', displayName: 'Home Video', kind: 'video' }),
  }
}
async function seedGeneration(page: Page, modelId: string, text: string, sessionId?: string): Promise<Created> {
  if (!sessionId) {
    const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: text, promptDocument: { version: 1, text, mentions: [] } } })
    expect(response.ok()).toBeTruthy()
    sessionId = (await response.json()).session.id
  }
  const response = await page.request.post(`${BASE}/api/generations`, { data: { modelId, prompt: text, quickSessionId: sessionId } })
  expect(response.status(), await response.text()).toBe(202)
  const generation = (await response.json()).generation as Created
  expect((await waitForGeneration(page, generation.id)).status).toBe('succeeded')
  return generation
}
async function send(page: Page, root: Locator, text: string): Promise<Created> {
  await expect(root.locator('.quick-config-trigger')).toBeEnabled()
  await prompt(root).fill(text)
  await expect(prompt(root)).toHaveValue(text)
  await expect(root.locator('.generate-button')).toBeEnabled()
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/generations' && response.request().method() === 'POST')
  await root.locator('.generate-button').click()
  const confirm = page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung' }).getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true })
  const next = await Promise.race([response.then(() => 'accepted'), confirm.waitFor({ state: 'visible' }).then(() => 'preview')])
  if (next === 'preview') await confirm.click()
  const accepted = await response
  expect(accepted.status()).toBe(202)
  return (await accepted.json()).generation as Created
}
async function sessions(page: Page) {
  const response = await page.request.get(`${BASE}/api/quick-sessions`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).sessions as Array<{ id: string }>
}
function expectHomeUrl(page: Page) {
  const url = new URL(page.url())
  expect(url.searchParams.get('page')).toBe('quick')
  expect(url.searchParams.has('session')).toBeFalsy()
  expect(url.searchParams.has('generation')).toBeFalsy()
}

test.beforeEach(async ({ page }) => { await signUpFresh(page) })

test('home opens without a session; each send starts a new session and feed filters do not change composer mode', async ({ page }) => {
  const model = await models(page)
  await page.goto(`${BASE}/?page=quick`)
  await expect(home(page)).toBeVisible()
  await expect(home(page).locator('.quick-home-empty')).toBeVisible()
  expect(await sessions(page)).toHaveLength(0)
  expectHomeUrl(page)

  const first = await send(page, home(page), 'Nhà gỗ đầu tiên trong rừng')
  await expect(home(page).locator(`[data-generation-id="${first.id}"]`)).toBeVisible()
  await expect(prompt(home(page))).toHaveValue('')
  expectHomeUrl(page)
  const second = await send(page, home(page), 'Nhà gỗ thứ hai bên hồ')
  await expect(home(page).locator('.creation-card')).toHaveCount(2)
  expect(second.quickSessionId).toBeTruthy()
  expect(second.quickSessionId).not.toBe(first.quickSessionId)
  expect(await sessions(page)).toHaveLength(2)
  expectHomeUrl(page)

  const video = await seedGeneration(page, model.video, 'Video mây trôi qua núi')
  await prompt(home(page)).fill('Bản nháp ảnh không đổi khi lọc video')
  await home(page).locator('.quick-home-filters').getByRole('button', { name: 'Video', exact: true }).click()
  await expect(home(page).locator('.creation-card')).toHaveCount(1)
  await expect(home(page).locator('.creation-card')).toHaveAttribute('data-generation-id', video.id)
  await expect(home(page).locator('.mode-tabs button').first()).toHaveAttribute('aria-pressed', 'true')
  await expect(prompt(home(page))).toHaveValue('Bản nháp ảnh không đổi khi lọc video')
  const thumbnail = home(page).locator('.creation-open-session video')
  await expect(thumbnail).toHaveCount(1)
  expect(await thumbnail.getAttribute('autoplay')).toBeNull()
  expect(await thumbnail.getAttribute('controls')).toBeNull()
  await home(page).locator('.quick-home-filters').getByRole('button', { name: 'Ảnh', exact: true }).click()
  await expect(home(page).locator('.creation-card')).toHaveCount(2)
  await home(page).locator('.quick-home-filters').getByRole('button', { name: 'Tất cả', exact: true }).click()
  await expect(home(page).locator('.creation-card')).toHaveCount(3)
})

test('thumbnail opens the selected generation; editing keeps its session and returning home preserves the draft', async ({ page }) => {
  const model = await models(page)
  const selected = await seedGeneration(page, model.image, 'Mô tả gốc cần mở đúng')
  await seedGeneration(page, model.image, 'Mô tả mới hơn trong cùng phiên', selected.quickSessionId)
  await page.goto(`${BASE}/?page=quick`)
  await prompt(home(page)).fill('Bản nháp riêng ở trang chủ')
  await home(page).locator(`[data-generation-id="${selected.id}"] .creation-open-session`).click()
  await expect(home(page)).toBeHidden()
  await expect(sessionView(page)).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(selected.quickSessionId)
  expect(new URL(page.url()).searchParams.get('generation')).toBe(selected.id)
  await expect(prompt(sessionView(page))).toHaveValue(selected.prompt)
  await expect(sessionView(page).locator('.quick-edit-banner')).toBeVisible()

  const edited = await send(page, sessionView(page), 'Mô tả gốc được chỉnh sửa trong phiên')
  expect(edited.quickSessionId).toBe(selected.quickSessionId)
  await expect(sessionView(page).locator('.creation-card')).toHaveCount(3)
  expect(await sessions(page)).toHaveLength(1)
  await sessionView(page).getByTestId('quick-session-back').click()
  await expect(home(page)).toBeVisible()
  await expect(prompt(home(page))).toHaveValue('Bản nháp riêng ở trang chủ')
  expectHomeUrl(page)
})

test('pending thumbnail is keyboard accessible and opens its original session', async ({ page }) => {
  const model = await models(page)
  const selected = await seedGeneration(page, model.video, 'Video đang chờ xử lý')
  await page.route('**/api/generations?**', async route => {
    if (new URL(route.request().url()).searchParams.get('scope') !== 'quick') return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    body.generations = body.generations.map((generation: Created) => generation.id === selected.id
      ? { ...generation, assets: [], status: 'running', providerStatus: 'running', progress: 20 }
      : generation)
    await route.fulfill({ response, json: body })
  })
  await page.goto(`${BASE}/?page=quick`)
  const card = home(page).locator(`[data-generation-id="${selected.id}"]`)
  await expect(card.locator('.creation-placeholder')).toBeVisible()
  const open = card.getByRole('button', { name: `Mở phiên tạo ${selected.prompt}`, exact: true })
  await open.focus()
  await page.keyboard.press('Enter')
  await expect(sessionView(page)).toBeVisible()
  await expect(prompt(sessionView(page))).toHaveValue(selected.prompt)
  expect(new URL(page.url()).searchParams.get('session')).toBe(selected.quickSessionId)
})

test('home draft opens Canvas in a session and back home keeps the independent draft', async ({ page }) => {
  await models(page)
  await page.goto(`${BASE}/?page=quick`)
  await prompt(home(page)).fill('Khu vườn buổi sáng từ trang chủ')
  await home(page).getByTestId('quick-canvas-toggle').click()
  await expect(page.getByTestId('quick-canvas-workspace')).toBeVisible()
  await expect(page.locator('.canvas-node.kind-prompt textarea')).toHaveValue('Khu vườn buổi sáng từ trang chủ')
  const sessionId = new URL(page.url()).searchParams.get('session')
  expect(sessionId).toBeTruthy()
  expect(new URL(page.url()).searchParams.get('view')).toBe('canvas')
  await expect(home(page)).toBeHidden()
  await sessionView(page).getByTestId('quick-session-back').click()
  await expect(home(page)).toBeVisible()
  await expect(prompt(home(page))).toHaveValue('Khu vườn buổi sáng từ trang chủ')
  expectHomeUrl(page)
  expect(await sessions(page)).toHaveLength(1)
  const created = await send(page, home(page), 'Ý tưởng mới sau khi về từ Canvas')
  expect(created.quickSessionId).not.toBe(sessionId)
  expect(await sessions(page)).toHaveLength(2)
  expectHomeUrl(page)
})

test('failed home send retries the existing session and idempotency key', async ({ page }) => {
  await models(page)
  let failed = false
  const payloads: Array<{ quickSessionId: string; idempotencyKey: string }> = []
  await page.route('**/api/generations', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    payloads.push(route.request().postDataJSON())
    if (!failed) {
      failed = true
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Temporary test failure' } }) })
    }
    await route.continue()
  })
  await page.goto(`${BASE}/?page=quick`)
  await expect(home(page).locator('.quick-config-trigger')).toBeEnabled()
  await prompt(home(page)).fill('Thử lại không tạo thêm phiên')
  await home(page).locator('.generate-button').click()
  const confirm = page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung' }).getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true })
  const alert = home(page).locator('.quick-create-actions [role="alert"]')
  const next = await Promise.race([alert.waitFor({ state: 'visible' }).then(() => 'failed'), confirm.waitFor({ state: 'visible' }).then(() => 'preview')])
  if (next === 'preview') await confirm.click()
  await expect(alert).toBeVisible()
  expect(await sessions(page)).toHaveLength(1)
  await expect(prompt(home(page))).toHaveValue('Thử lại không tạo thêm phiên')
  const created = await send(page, home(page), 'Thử lại không tạo thêm phiên')
  expect(payloads).toHaveLength(2)
  expect(payloads[0].quickSessionId).toBeTruthy()
  expect(payloads[1].quickSessionId).toBe(payloads[0].quickSessionId)
  expect(payloads[1].idempotencyKey).toBe(payloads[0].idempotencyKey)
  expect(created.quickSessionId).toBe(payloads[0].quickSessionId)
  expect(await sessions(page)).toHaveLength(1)
  expectHomeUrl(page)
})

test('home search filters server results without changing the composer draft', async ({ page }) => {
  const model = await models(page)
  await seedGeneration(page, model.image, 'Một căn nhà giữa rừng')
  await seedGeneration(page, model.video, 'Mây trôi trên núi')
  await page.goto(`${BASE}/?page=quick`)
  await prompt(home(page)).fill('Bản nháp không bị ảnh hưởng')
  const search = home(page).getByRole('searchbox', { name: 'Tìm nội dung' })
  await search.fill('núi')
  await expect(home(page).locator('.creation-card')).toHaveCount(1)
  await expect(home(page).locator('.creation-card')).toContainText('Mây trôi trên núi')
  await expect(prompt(home(page))).toHaveValue('Bản nháp không bị ảnh hưởng')
  await search.fill('không tồn tại')
  await expect(home(page).getByRole('heading', { name: 'Không có nội dung phù hợp với tìm kiếm.' })).toBeVisible()
  await search.fill('')
  await expect(home(page).locator('.creation-card')).toHaveCount(2)
})

test('home load-more failure retries the same cursor without duplicates', async ({ page }) => {
  const model = await models(page)
  const source = await seedGeneration(page, model.image, 'Nguồn phân trang')
  const detail = await page.request.get(`${BASE}/api/generations/${source.id}`)
  const original = (await detail.json()).generation
  const items = Array.from({ length: 31 }, (_, index) => ({ ...original, id: `retry-page-${index}`, prompt: `Kết quả retry ${index}`, createdAt: 100_000 - index, updatedAt: 100_000 - index }))
  let failed = false
  await page.route('**/api/generations?**', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('scope') !== 'quick') return route.continue()
    const offset = query.has('cursor') ? 30 : 0
    if (offset && !failed) {
      failed = true
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY', message: 'Temporary page failure' } }) })
      return
    }
    const filtered = items.filter(item => !query.get('kind') || item.kind === query.get('kind'))
    await route.fulfill({ json: { generations: filtered.slice(offset, offset + 30), nextCursor: filtered.length > offset + 30 ? 'older-results' : null } })
  })
  await page.goto(`${BASE}/?page=quick`)
  await expect(home(page).locator('.creation-card')).toHaveCount(30)
  await home(page).getByRole('button', { name: 'Tải thêm nội dung', exact: true }).click()
  const alert = home(page).getByRole('alert')
  await expect(alert).toBeVisible()
  await alert.getByRole('button', { name: 'Thử tải lại nội dung', exact: true }).click()
  await expect(home(page).locator('.creation-card')).toHaveCount(31)
  const ids = await home(page).locator('.creation-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-generation-id')))
  expect(new Set(ids).size).toBe(31)
})

test('home session history opens draft-only sessions and retries loading', async ({ page }) => {
  await models(page)
  const response = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Phiên chỉ có bản nháp', promptDocument: { version: 1, text: 'Bản nháp lịch sử', mentions: [] } } })
  expect(response.ok()).toBeTruthy()
  await page.goto(`${BASE}/?page=quick`)
  await home(page).getByRole('button', { name: 'Lịch sử phiên', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Lịch sử phiên' })
  await expect(dialog).toContainText('Phiên chỉ có bản nháp')
  await dialog.getByRole('button', { name: /Phiên chỉ có bản nháp/ }).click()
  await expect(home(page)).toBeHidden()
  await expect(sessionView(page)).toBeVisible()
  await expect(prompt(sessionView(page))).toHaveValue('Bản nháp lịch sử')
})

test('home cursor loads older mixed results without duplicate cards', async ({ page }) => {
  test.setTimeout(90_000)
  const model = await models(page)
  const image = await seedGeneration(page, model.image, 'Kết quả ảnh phân trang')
  const video = await seedGeneration(page, model.video, 'Kết quả video phân trang')
  const imageResponse = await page.request.get(`${BASE}/api/generations/${image.id}`)
  const videoResponse = await page.request.get(`${BASE}/api/generations/${video.id}`)
  const originals = [(await imageResponse.json()).generation, (await videoResponse.json()).generation]
  const items = Array.from({ length: 32 }, (_, index) => ({ ...originals[index % 2], id: `pagination-${index}`, prompt: `Kết quả phân trang ${index}`, createdAt: 100_000 - index, updatedAt: 100_000 - index }))
  const queries: URLSearchParams[] = []
  await page.route('**/api/generations?**', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('scope') !== 'quick') return route.continue()
    queries.push(query)
    const filtered = items.filter(item => !query.get('kind') || item.kind === query.get('kind'))
    const offset = query.has('cursor') ? 30 : 0
    await route.fulfill({ json: { generations: filtered.slice(offset, offset + 30), nextCursor: filtered.length > offset + 30 ? 'older-results' : null } })
  })
  await page.goto(`${BASE}/?page=quick`)
  await expect(home(page).locator('.creation-card')).toHaveCount(30)
  await home(page).getByRole('button', { name: 'Tải thêm nội dung', exact: true }).click()
  await expect(home(page).locator('.creation-card')).toHaveCount(32)
  await expect(home(page).getByRole('button', { name: 'Tải thêm nội dung', exact: true })).toHaveCount(0)
  const ids = await home(page).locator('.creation-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-generation-id')))
  expect(new Set(ids).size).toBe(32)
  expect(queries.some(query => query.get('cursor') === 'older-results' && query.get('limit') === '30')).toBeTruthy()
  await home(page).locator('.quick-home-filters').getByRole('button', { name: 'Video', exact: true }).click()
  await expect(home(page).locator('.creation-card')).toHaveCount(16)
  await expect(home(page).locator('.creation-card').first().locator('.mini-type')).toContainText(/video/i)
  expectHomeUrl(page)
})

test('home failed video card retries download in place', async ({ page }) => {
  const model = await models(page)
  const created = await seedGeneration(page, model.video, 'Video feed lỗi cần tải lại')
  const detail = await page.request.get(`${BASE}/api/generations/${created.id}`)
  const generation = await detail.json().then(body => body.generation)
  generation.status = 'failed'
  generation.providerJobId = 'provider-job-existing'
  generation.errorCode = 'DOWNLOAD_FAILED'
  generation.errorMessage = 'Tải media thất bại'
  generation.assets = []
  let retries = 0
  await page.route('**/api/generations?*', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('scope') !== 'quick') return route.continue()
    await route.fulfill({ json: { generations: [generation], nextCursor: null } })
  })
  await page.route(`**/api/generations/${generation.id}/retry-download`, async route => {
    retries += 1
    generation.status = 'running'
    generation.errorCode = null
    generation.errorMessage = null
    generation.updatedAt += 1
    await route.fulfill({ json: { generation } })
  })
  await page.goto(`${BASE}/?page=quick`)
  const card = home(page).locator('.creation-card').filter({ hasText: generation.prompt })
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: 'Tải lại kết quả', exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Tải lại kết quả', exact: true }).click()
  await expect(card).toContainText(/Hoàn tất|Đang xử lý/)
  expect(retries).toBe(1)
})

test('home queued video can be stopped without provider submission', async ({ page }) => {
  const model = await models(page)
  const created = await seedGeneration(page, model.video, 'Video đang chờ để dừng')
  const detail = await page.request.get(`${BASE}/api/generations/${created.id}`)
  const generation = await detail.json().then(body => body.generation)
  generation.status = 'queued'
  generation.providerJobId = null
  generation.canCancel = true
  generation.assets = []
  let cancels = 0
  await page.route('**/api/generations?*', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('scope') !== 'quick') return route.continue()
    await route.fulfill({ json: { generations: [generation], nextCursor: null } })
  })
  await page.route(`**/api/generations/${generation.id}/cancel`, async route => {
    cancels += 1
    generation.status = 'failed'
    generation.errorCode = 'CANCELLED'
    generation.canCancel = false
    generation.updatedAt += 1
    await route.fulfill({ json: { generation } })
  })
  await page.goto(`${BASE}/?page=quick`)
  const card = home(page).locator('.creation-card').filter({ hasText: generation.prompt })
  await expect(card.getByRole('button', { name: 'Dừng', exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Dừng', exact: true }).click()
  await expect(card).toContainText('Đã dừng')
  expect(cancels).toBe(1)
})

test('home keyboard submit respects composition and an open mention menu', async ({ page }) => {
  await models(page)
  await page.goto(`${BASE}/?page=quick`)
  await expect(home(page).locator('.quick-config-trigger')).toBeEnabled()
  await prompt(home(page)).fill('Tạo nhanh bằng bàn phím')
  const requests: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/generations(?:\/preview)?$/.test(new URL(request.url()).pathname)) requests.push(request.url())
  })
  await prompt(home(page)).evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })))
  expect(requests).toHaveLength(0)
  await prompt(home(page)).fill('@')
  await expect(prompt(home(page))).toHaveAttribute('aria-expanded', 'true')
  await prompt(home(page)).press('Control+Enter')
  expect(requests).toHaveLength(0)
  await prompt(home(page)).press('Escape')
  await prompt(home(page)).fill('Tạo nhanh bằng bàn phím')
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/generations' && response.request().method() === 'POST')
  await prompt(home(page)).press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  const confirm = page.getByRole('dialog', { name: 'Xác nhận yêu cầu tạo nội dung' }).getByRole('button', { name: 'Xác nhận & tạo nội dung', exact: true })
  const next = await Promise.race([accepted.then(() => 'accepted'), confirm.waitFor({ state: 'visible' }).then(() => 'preview')])
  if (next === 'preview') await confirm.click()
  expect((await accepted).status()).toBe(202)
  await expect(home(page).locator('.creation-card')).toHaveCount(1)
  expectHomeUrl(page)
})

test('home header, scrollable feed and compact composer fit responsive viewports', async ({ page }, testInfo) => {
  const model = await models(page)
  await seedGeneration(page, model.image, 'Ánh nắng trên ngôi nhà gỗ')
  await seedGeneration(page, model.video, 'Mây trôi trên đỉnh núi')
  await page.goto(`${BASE}/?page=quick`)
  await expect(home(page).locator('.creation-card')).toHaveCount(2)
  await prompt(home(page)).fill('Ý tưởng mới sẵn sàng để gửi')
  for (const [width, height] of [[320, 844], [390, 844], [1440, 900], [844, 390]]) {
    await page.setViewportSize({ width, height })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const bounds = await home(page).evaluate(root => {
      const header = root.querySelector('.quick-home-header')!.getBoundingClientRect()
      const feed = root.querySelector('.quick-home-feed')!.getBoundingClientRect()
      const dock = root.querySelector('.quick-home-composer')!.getBoundingClientRect()
      return { headerBottom: header.bottom, feedTop: feed.top, feedBottom: feed.bottom, feedHeight: feed.height, dockTop: dock.top, dockBottom: dock.bottom, viewportHeight: innerHeight }
    })
    const screenshot = testInfo.outputPath(`quick-home-${width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
    await testInfo.attach(`quick-home-${width}`, { path: screenshot, contentType: 'image/png' })
    expect(bounds.feedHeight).toBeGreaterThan(height < 500 ? 35 : 100)
    expect(bounds.headerBottom).toBeLessThanOrEqual(bounds.feedTop)
    expect(bounds.feedBottom).toBeLessThanOrEqual(bounds.dockTop)
    expect(bounds.dockBottom).toBeLessThanOrEqual(bounds.viewportHeight)
    await expect(home(page).locator('.generate-button')).toBeInViewport({ ratio: 1 })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Thu gọn menu', exact: true }).click()
  await expect(page.locator('.sidebar')).toHaveClass(/is-collapsed/)
  const collapsedScreenshot = testInfo.outputPath('quick-home-collapsed-1440.png')
  await page.screenshot({ path: collapsedScreenshot, fullPage: true, animations: 'disabled' })
  await testInfo.attach('quick-home-collapsed-1440', { path: collapsedScreenshot, contentType: 'image/png' })
  await expect(home(page).locator('.generate-button')).toBeInViewport()
})
