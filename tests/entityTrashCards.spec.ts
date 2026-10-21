import { expect, test, type Page } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'
import type { EntityKind } from '../src/api/entityLibrary'

async function create(page: Page, kind: EntityKind, name: string) {
  const response = await page.request.post(`${BASE}${kind === 'character' ? '/api/shared-characters' : '/api/entity-library/assets'}`, {
    data: kind === 'character' ? { name, appearance: 'Card test', voice: {} } : { kind, name, description: 'Card test' },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json()
  return (body.character ?? body.asset).id as string
}
const card = (page: Page, id: string) => page.locator(`[data-testid="entity-library-card"][data-entity-id="${id}"]`)
test.beforeEach(async ({ page }) => { await signUpFresh(page) })

for (const kind of ['character', 'item', 'logo', 'location'] as const) {
  test(`${kind} card supports cancel and confirmed 30-day trash without a native dialog`, async ({ page }) => {
    const id = await create(page, kind, `Trash card ${kind}`)
    let nativeDialogs = 0
    page.on('dialog', dialog => { nativeDialogs++; void dialog.dismiss() })
    let deletes = 0
    page.on('request', request => { if (request.method() === 'DELETE') deletes++ })
    await page.goto(`${BASE}/?page=entities`)
    await card(page, id).getByTestId('entity-card-trash').click()
    const modal = page.getByTestId('entity-trash-confirm-dialog')
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('entity-trash-retention')).toContainText('30 ngày')
    await modal.getByTestId('entity-trash-cancel').click()
    await expect(modal).toHaveCount(0)
    expect(deletes).toBe(0)
    await expect(card(page, id)).toBeVisible()
    await card(page, id).getByTestId('entity-card-trash').click()
    await modal.getByTestId('entity-trash-confirm').click()
    await expect(card(page, id)).toHaveCount(0)
    await expect(page.getByTestId('entity-trash-success')).toContainText('30 ngày')
    await expect(page.getByTestId('entity-open-trash')).toHaveAttribute('href', '/?page=trash')
    expect(nativeDialogs).toBe(0)
    expect(deletes).toBe(1)
    const response = await page.request.get(`${BASE}/api/trash?kind=${kind === 'character' ? 'character' : 'library_asset'}`)
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    const item = body.items.find((value: { id: string }) => value.id === id)
    expect(item).toBeTruthy()
    expect(item.purgeAfter - item.deletedAt).toBe(30 * 24 * 60 * 60 * 1000)
    const restored = await page.request.post(`${BASE}/api/trash/${kind === 'character' ? 'character' : 'library_asset'}/${id}/restore`)
    expect(restored.ok()).toBeTruthy()
    await page.reload()
    await expect(card(page, id)).toBeVisible()
  })
}

test('all-types catalog follows descending creation time and filters keep that order', async ({ page }) => {
  for (const [kind, name] of [['item', 'Old object'], ['character', 'Middle character'], ['logo', 'Newest logo']] as const) await create(page, kind, name)
  const response = await page.request.get(`${BASE}/api/entity-library`)
  const entities = (await response.json()).entities as Array<{ id: string; createdAt: number }>
  expect(entities.map(entity => entity.createdAt)).toEqual(entities.map(entity => entity.createdAt).sort((a, b) => b - a))
  await page.goto(`${BASE}/?page=entities`)
  const cards = page.getByTestId('entity-library-card')
  await expect(cards).toHaveCount(3)
  for (let index = 0; index < entities.length; index++) await expect(cards.nth(index)).toHaveAttribute('data-entity-id', entities[index]!.id)
  await page.getByTestId('entity-library-filter-logo').click()
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Newest logo')
  await page.screenshot({ path: 'artifacts/entity-trash-cards/newest-first-and-trash.png', fullPage: true })
})

test('detail keeps one trash action and failed deletion remains retryable', async ({ page }) => {
  const id = await create(page, 'item', 'Retry card')
  await page.goto(`${BASE}/?page=entities`)
  await card(page, id).getByTestId('entity-card-details').click()
  const details = page.getByTestId('entity-details-dialog')
  await expect(details.getByTestId('entity-detail-trash')).toHaveCount(1)
  await details.getByTestId('entity-detail-trash').click()
  await expect(details).toHaveCount(0)
  let fail = true
  await page.route(`**/api/entity-library/assets/${id}`, route => {
    if (route.request().method() === 'DELETE' && fail) return route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message: 'Synthetic retained usage' } } })
    return route.continue()
  })
  const modal = page.getByTestId('entity-trash-confirm-dialog')
  await modal.getByTestId('entity-trash-confirm').click()
  await expect(modal.getByRole('alert')).toBeVisible()
  await expect(card(page, id)).toBeVisible()
  await expect(modal.getByTestId('entity-trash-confirm')).toBeEnabled()
  fail = false
  await modal.getByTestId('entity-trash-confirm').click()
  await expect(modal).toHaveCount(0)
  await expect(card(page, id)).toHaveCount(0)
})
