import { expect, test, type Page } from '@playwright/test'
import type { EntityLibraryEntity, EntityKind } from '../src/api/entityLibrary'
import { BASE, signUpFresh } from './helpers/auth'

const scopedKinds: EntityKind[] = ['logo', 'location', 'character', 'item']

function entity(id: string, kind: EntityKind, description: string): EntityLibraryEntity {
  return {
    id, kind, name: `${kind} ${id}`, handle: `${kind}-${id}`, description,
    continuityNotes: '', revision: 1, reference: null,
  }
}

function expectedDisplay(kind: EntityKind, description: string): string {
  const characters = Array.from(description)
  return scopedKinds.includes(kind) && characters.length > 200
    ? `${characters.slice(0, 197).join('')}...`
    : description
}

async function mockEntityLibrary(page: Page, entities: EntityLibraryEntity[]) {
  await page.route('**/api/shared-characters/*', async route => {
    const character = entities.find(entity => entity.kind === 'character' && route.request().url().endsWith(`/${entity.id}`))
    if (!character) return route.continue()
    await route.fulfill({ json: { character: { id: character.id, projectId: null, name: character.name, appearance: character.description,
      voice: { language: '', accent: '', pitch: '', timbre: '', pace: '', articulation: '', habits: '' },
      referenceUrl: null, referenceMime: null, referenceBytes: null } } })
  })
  await page.route('**/api/entity-library', async route => {
    if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/entity-library') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entities }) })
    } else {
      await route.continue()
    }
  })
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}

test.beforeEach(async ({ page }) => { await signUpFresh(page) })

test("truncates all four kinds long descriptions by Unicode code points", async ({ page }) => {
  const entities: EntityLibraryEntity[] = []
  for (const kind of scopedKinds) {
    for (const length of [0, 199, 200, 201]) {
      // Emoji are astral code points; Vietnamese combining/newline content is also preserved verbatim.
      const description = length === 0 ? '' : `${'🐉'.repeat(length - 6)}ế\ncuối`
      entities.push(entity(`${kind}-${length}`, kind, description))
    }
  }
  await mockEntityLibrary(page, entities)
  await page.goto(`${BASE}/?page=entities`)

  for (const expected of entities) {
    const identifiedCard = page.locator(`[data-testid="entity-library-card"][data-entity-id="${expected.id}"]`)
    await expect(identifiedCard).toHaveCount(1)
    const description = identifiedCard.locator('[data-testid="entity-card-description"]')
    await expect(description).toHaveCSS('-webkit-line-clamp', '3')
    await expect(identifiedCard.getByTestId('entity-card-name')).toHaveCSS('-webkit-line-clamp', '2')
    if (!expected.description) await expect(description).toHaveText('Chưa có mô tả')
    else await expect.poll(() => description.evaluate(element => element.textContent)).toBe(expectedDisplay(expected.kind, expected.description))
  }
})

test('searches the untruncated tail, editor keeps full text, and long text fits desktop/mobile', async ({ page }) => {
  const fullDescription = `${'A'.repeat(230)}đuôi-tìm-được\nMô tả tiếng Việt 🐉`
  const unbrokenItem = 'item-' + 'x'.repeat(1200)
  const logo = entity('logo-tail', 'logo', fullDescription)
  const location = entity('location-tail', 'location', `${'🌋'.repeat(240)}\nđịa điểm`)
  const character = entity('character-tail', 'character', `${'Nguyễn'.repeat(40)} 🐉\nnhân vật`)
  const item = entity('item-long', 'item', unbrokenItem)
  await mockEntityLibrary(page, [logo, location, character, item])
  await page.goto(`${BASE}/?page=entities`)

  const cards = page.getByTestId('entity-library-card')
  await expect(cards).toHaveCount(4)
  await page.screenshot({ path: 'artifacts/unified-library-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'artifacts/unified-library-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 844 })
  const logoCard = page.locator('[data-testid="entity-library-card"][data-entity-id="logo-tail"]')
  await expect(logoCard.locator('[data-testid="entity-card-description"]')).toHaveText(expectedDisplay('logo', fullDescription))
  await page.getByTestId('entity-library-search').fill('đuôi-tìm-được')
  await expect(cards).toHaveCount(1)
  await expect(logoCard).toBeVisible()
  await page.getByTestId('entity-library-search').fill('')

  await logoCard.getByTestId('entity-card-details').click()
  await expect(page.getByTestId('entity-details-dialog')).toContainText(fullDescription)
  await page.getByTestId('entity-details-dialog').getByRole('button', { name: 'Đóng', exact: true }).click()
  await logoCard.getByRole('button', { name: `Sửa — ${logo.name}`, exact: true }).click()
  const editor = page.getByTestId('entity-editor-dialog')
  await expect(editor.locator('textarea[name="description"]')).toHaveValue(fullDescription)
  await expectNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page)
  await expect(page.locator('[data-testid="entity-library-card"][data-entity-id="item-long"] [data-testid="entity-card-description"]')).toHaveText(expectedDisplay('item', unbrokenItem))
  await editor.getByRole('button', { name: 'Đóng', exact: true }).last().click()
  for (const entity of [location, character, item]) {
    const card = page.locator(`[data-testid="entity-library-card"][data-entity-id="${entity.id}"]`)
    await card.getByTestId('entity-card-details').click()
    await expect(page.getByTestId('entity-details-description')).toHaveText(entity.description)
    await page.getByTestId('entity-details-dialog').getByRole('button', { name: 'Đóng', exact: true }).click()
    await card.getByRole('button', { name: `Sửa — ${entity.name}`, exact: true }).click()
    await expect(editor.locator(`textarea[name="${entity.kind === 'character' ? 'appearance' : 'description'}"]`)).toHaveValue(entity.description)
    await editor.getByRole('button', { name: 'Đóng', exact: true }).last().click()
  }
})
