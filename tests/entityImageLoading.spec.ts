import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'
import type { EntityKind } from '../src/api/entityLibrary'
import { BASE, seedLlmModel, seedModel, seedProvider, signUpFresh } from './helpers/auth'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const voice = { language: 'vi', accent: '', pitch: '', timbre: '', pace: '', articulation: '', habits: '' }
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve }); return { wait, release } }
function generation(id: string, status = 'running', progress: number | null = null, extra = {}) {
  return { id, status, progress, assets: status === 'succeeded' ? [{ id: `${id}-asset`, url: png }] : [], ...extra }
}
async function setup(page: Page, kind: EntityKind = 'item', images = true, count = 1) {
  await signUpFresh(page)
  const llm = await seedLlmModel(page)
  const model = await seedModel(page, await seedProvider(page))
  await page.goto(`${BASE}/?page=entities`)
  await page.getByTestId('entity-library-ai-create').click()
  const ai = page.getByTestId('entity-ai-dialog')
  await expect(ai.getByTestId('entity-ai-kind')).toBeEnabled()
  await ai.getByTestId('entity-ai-kind').selectOption(kind)
  await ai.getByTestId('entity-ai-llm').selectOption(llm)
  await ai.locator('[name="description"]').fill('Loading regression description')
  await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill(String(count))
  if (images) {
    await ai.getByLabel('Tạo thêm ảnh (phát sinh phí)', { exact: true }).check()
    await ai.getByTestId('entity-ai-image-model').selectOption(model)
  }
  return ai
}
async function candidates(page: Page, kind: EntityKind, names: () => string[], barrier?: ReturnType<typeof gate>) {
  const endpoint = kind === 'character' ? 'shared-characters' : 'entity-library'
  await page.route(`**/api/${endpoint}/generate`, async route => {
    if (barrier) await barrier.wait
    await route.fulfill({ json: { candidates: names().map(name => kind === 'character'
      ? { name, appearance: `Appearance ${name}`, voice }
      : { name, handle: name.toLowerCase().replaceAll(' ', '-'), description: `Description ${name}`, continuityNotes: '' }), modelId: 'mock', model: 'mock' } })
  })
}
async function start(ai: Locator) { await ai.getByRole('button', { name: 'Tạo bằng AI', exact: true }).click() }
async function active(ai: Locator) {
  await expect(ai.getByTestId('entity-ai-progress')).toBeVisible()
  await expect(ai.getByTestId('entity-ai-footer-progress')).toBeVisible()
  await expect(ai.getByRole('button', { name: 'Dừng chờ', exact: true })).toBeEnabled()
}
async function idle(ai: Locator) {
  await expect(ai.getByTestId('entity-ai-progress')).toHaveCount(0)
  await expect(ai.getByTestId('entity-ai-footer-progress')).toHaveCount(0)
}

for (const kind of ['character', 'item', 'logo', 'location'] as const) {
  test(`${kind}: immediate text and image sending indicators, unknown/known progress and successful completion`, async ({ page }) => {
    const ai = await setup(page, kind)
    const textGate = gate(), sendGate = gate()
    await candidates(page, kind, () => ['Loading candidate'], textGate)
    let stage: 'unknown' | 'known' | 'done' = 'unknown'
    let accepted = 0
    const endpoint = kind === 'character' ? 'shared-characters' : 'entity-library'
    await page.route(`**/api/${endpoint}/illustrations`, async route => {
      accepted++
      await sendGate.wait
      await route.fulfill({ json: { generation: generation('loading-job') } })
    })
    await page.route('**/api/generations/loading-job', route => route.fulfill({ json: {
      generation: generation('loading-job', stage === 'done' ? 'succeeded' : 'running', stage === 'known' ? 47 : null),
    } }))
    try {
      await start(ai)
      await active(ai)
      await expect(ai.getByTestId('entity-card')).toHaveCount(0)
      textGate.release()
      const card = ai.getByTestId('entity-card')
      await expect(card.getByTestId('entity-image-status')).toHaveAttribute('data-image-phase', 'sending')
      await expect.poll(() => accepted).toBe(1)
      await expect(card.getByTestId('entity-image-status').getByRole('progressbar')).not.toHaveAttribute('value')
      sendGate.release()
      await expect(card.getByTestId('entity-image-status')).toHaveAttribute('data-image-phase', 'generating')
      await expect(card.getByTestId('entity-image-status').getByRole('progressbar')).not.toHaveAttribute('value')
      stage = 'known'
      await expect(card.getByTestId('entity-image-status').getByRole('progressbar')).toHaveAttribute('value', '47')
      stage = 'done'
      await expect(card.getByTestId('entity-image-status')).toHaveCount(0)
      await expect(card.getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled()
      await idle(ai)
      expect(accepted).toBe(1)
    } finally { textGate.release(); sendGate.release() }
  })
}

test('source upload shows global loading before upload and text responses; metadata-only has no image overlay', async ({ page }) => {
  const ai = await setup(page, 'item', false)
  const uploadGate = gate(), textGate = gate()
  await candidates(page, 'item', () => ['Metadata only'], textGate)
  await page.route('**/api/uploads', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    await uploadGate.wait
    await route.fulfill({ json: { upload: { id: 'local-source', mime: 'image/png' } } })
  })
  const buffer = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#67abef' } }).png().toBuffer()
  await ai.getByTestId('entity-ai-source').setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer })
  try {
    await start(ai)
    await active(ai)
    await expect(ai.getByTestId('entity-card')).toHaveCount(0)
    uploadGate.release()
    await active(ai)
    textGate.release()
    await expect(ai.getByTestId('entity-card')).toHaveCount(1)
    await expect(ai.getByTestId('entity-image-status')).toHaveCount(0)
    await idle(ai)
    await expect(ai.getByTestId('entity-card')).not.toContainText('Đang tạo ảnh')
  } finally { uploadGate.release(); textGate.release() }
})

test('queued candidates keep same-run order and summary only counts the newest run; new image is prepended', async ({ page }) => {
  const ai = await setup(page, 'item', true, 3)
  let run = 1
  await candidates(page, 'item', () => run === 1 ? ['First A', 'First B', 'First C'] : ['Second A', 'Second B'])
  const firstPair = gate()
  let sent = 0
  await page.route('**/api/entity-library/illustrations', async route => {
    const number = ++sent
    if (number <= 2) await firstPair.wait
    await route.fulfill({ json: { generation: generation(`order-${number}`, 'succeeded', 100) } })
  })
  await page.route('**/api/generations/order-*', route => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!
    return route.fulfill({ json: { generation: generation(id, 'succeeded', 100) } })
  })
  try {
    await start(ai)
    const cards = ai.getByTestId('entity-card')
    await expect(cards).toHaveCount(3)
    await expect(cards.nth(2).getByTestId('entity-image-status')).toHaveAttribute('data-image-phase', 'queued')
    await expect(ai.getByTestId('entity-ai-progress')).toContainText('0/3')
    await expect(cards.getByTestId('entity-card-name')).toHaveText(['First A', 'First B', 'First C'])
    firstPair.release()
    await idle(ai)
    run = 2
    await ai.getByLabel('Số ứng viên (1–6)', { exact: true }).fill('2')
    await start(ai)
    await expect(cards).toHaveCount(5)
    await idle(ai)
    await expect(cards.getByTestId('entity-card-name')).toHaveText(['Second A', 'Second B', 'First A', 'First B', 'First C'])
    const originalId = await cards.nth(1).getAttribute('data-entity-id')
    page.once('dialog', dialog => dialog.accept())
    await cards.nth(1).getByRole('button', { name: 'Tạo ảnh khác có tính phí', exact: true }).click()
    await expect(cards).toHaveCount(6)
    await idle(ai)
    await expect(cards.getByTestId('entity-card-name')).toHaveText(['Second B', 'Second A', 'Second B', 'First A', 'First B', 'First C'])
    expect(await cards.first().getAttribute('data-entity-id')).not.toBe(originalId)
  } finally { firstPair.release() }
})

test('stop during sending does not resurrect loading on late acceptance and resume reuses the same paid generation', async ({ page }) => {
  const ai = await setup(page)
  await candidates(page, 'item', () => ['Stopped candidate'])
  const acceptance = gate()
  let requests = 0
  let delivered = false
  await page.route('**/api/entity-library/illustrations', async route => {
    requests++
    await acceptance.wait
    await route.fulfill({ json: { generation: generation('late-job', 'succeeded', 100) } })
    delivered = true
  })
  await page.route('**/api/generations/late-job', route => route.fulfill({ json: { generation: generation('late-job', 'succeeded', 100) } }))
  try {
    await start(ai)
    const card = ai.getByTestId('entity-card')
    await expect.poll(() => requests).toBe(1)
    await expect(card.getByTestId('entity-image-status')).toBeVisible()
    await ai.getByRole('button', { name: 'Dừng chờ', exact: true }).click()
    await idle(ai)
    await expect(card.getByTestId('entity-image-status')).toHaveCount(0)
    acceptance.release()
    await expect.poll(() => delivered).toBe(true)
    await expect(card).toContainText('Đã dừng chờ')
    await expect(card.getByTestId('entity-image-status')).toHaveCount(0)
    await card.getByRole('button', { name: 'Tiếp tục tác vụ cũ', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled()
    await idle(ai)
    expect(requests).toBe(1)
  } finally { acceptance.release() }
})

for (const terminal of ['failed', 'unknown', 'empty-success'] as const) {
  test(`terminal ${terminal} removes image loading and leaves a visible error without paid retry`, async ({ page }) => {
    const ai = await setup(page)
    await candidates(page, 'item', () => ['Failed candidate'])
    let paid = 0
    await page.route('**/api/entity-library/illustrations', route => {
      paid++
      return route.fulfill({ json: { generation: generation('failed-job') } })
    })
    await page.route('**/api/generations/failed-job', route => route.fulfill({ json: {
      generation: generation('failed-job', terminal === 'empty-success' ? 'succeeded' : terminal, null, { assets: [] }),
    } }))
    await start(ai)
    const card = ai.getByTestId('entity-card')
    await expect(card.getByRole('alert')).toBeVisible()
    await expect(card.getByTestId('entity-image-status')).toHaveCount(0)
    await idle(ai)
    expect(paid).toBe(1)
  })
}

test('character autosave keeps image overlay while attaching the finished reference, then clears on saved', async ({ page }) => {
  const ai = await setup(page, 'character')
  await candidates(page, 'character', () => ['Attach candidate'])
  await ai.getByLabel('Tự lưu ứng viên hoàn tất', { exact: true }).check()
  await page.route('**/api/shared-characters/illustrations', route => route.fulfill({ json: { generation: generation('attach-job', 'succeeded', 100) } }))
  await page.route('**/api/generations/attach-job', route => route.fulfill({ json: { generation: generation('attach-job', 'succeeded', 100) } }))
  const attach = gate()
  let attaching = false
  await page.route('**/api/shared-characters/*/reference/from-generation', async route => {
    attaching = true
    await attach.wait
    await route.fulfill({ json: { character: { id: new URL(route.request().url()).pathname.split('/')[3] } } })
  })
  try {
    await start(ai)
    await expect.poll(() => attaching).toBe(true)
    const card = ai.getByTestId('entity-card')
    await expect(card.getByTestId('entity-image-status')).toHaveAttribute('data-image-phase', 'saving')
    await active(ai)
    attach.release()
    await expect(card).toContainText('Đã lưu')
    await expect(card.getByTestId('entity-image-status')).toHaveCount(0)
    await idle(ai)
  } finally { attach.release() }
})

test('asset publication has its own loading phase and mobile overlays remain within the card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const ai = await setup(page, 'location')
  await candidates(page, 'location', () => ['Publication candidate'])
  await ai.getByLabel('Tự lưu ứng viên hoàn tất', { exact: true }).check()
  let published = false
  const result = () => generation('publish-job', 'succeeded', 100, {
    libraryPublishStatus: published ? 'succeeded' : 'pending',
    libraryPublications: published ? [{ targetId: 'published-location' }] : [],
  })
  await page.route('**/api/entity-library/illustrations', route => route.fulfill({ json: { generation: result() } }))
  await page.route('**/api/generations/publish-job', route => route.fulfill({ json: { generation: result() } }))
  await start(ai)
  const card = ai.getByTestId('entity-card')
  await expect(card.getByTestId('entity-image-status')).toHaveAttribute('data-image-phase', 'publishing')
  await active(ai)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  const containment = await card.evaluate(root => {
    const cardRect = root.getBoundingClientRect(), overlay = root.querySelector('[data-testid="entity-image-status"]')!.getBoundingClientRect()
    return overlay.left >= cardRect.left - 1 && overlay.right <= cardRect.right + 1
  })
  expect(containment).toBe(true)
  const footerGeometry = await ai.evaluate(root => {
    const footer = root.querySelector('form > footer')!
    const rect = footer.getBoundingClientRect()
    const controls = [...footer.querySelectorAll('button,[data-testid="entity-ai-footer-progress"]')].map(element => element.getBoundingClientRect())
    const overlap = controls.some((a, index) => controls.slice(index + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1))
    return {
      withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
      controlsContained: controls.every(control => control.left >= rect.left - 1 && control.right <= rect.right + 1 && control.top >= rect.top - 1 && control.bottom <= rect.bottom + 1),
      overlap,
    }
  })
  expect(footerGeometry).toEqual({ withinViewport: true, controlsContained: true, overlap: false })
  published = true
  await expect(card).toContainText('Đã lưu')
  await expect(card.getByTestId('entity-image-status')).toHaveCount(0)
  await idle(ai)
})
