import { expect, test, type Page } from '@playwright/test'
import type { EntityLibraryEntity, EntityKind } from '../src/api/entityLibrary'
import { BASE, signUpFresh } from './helpers/auth'

const scopedKinds: EntityKind[] = ['logo', 'location', 'character']

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

test('truncates only long logo/location/character descriptions by Unicode code points', async ({ page }) => {
  const entities: EntityLibraryEntity[] = []
  for (const kind of [...scopedKinds, 'item' as const]) {
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
    const description = identifiedCard.locator('.entity-library-description')
    if (!expected.description) await expect(description).toHaveCount(0)
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
  const logoCard = page.locator('[data-testid="entity-library-card"][data-entity-id="logo-tail"]')
  await expect(logoCard.locator('.entity-library-description')).toHaveText(expectedDisplay('logo', fullDescription))
  await page.getByTestId('entity-library-search').fill('đuôi-tìm-được')
  await expect(cards).toHaveCount(1)
  await expect(logoCard).toBeVisible()
  await page.getByTestId('entity-library-search').fill('')

  await logoCard.getByRole('button', { name: `Sửa — ${logo.name}`, exact: true }).click()
  const editor = page.getByTestId('entity-library-editor')
  await expect(editor.locator('textarea[name="description"]')).toHaveValue(fullDescription)
  await expectNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page)
  await expect(page.locator('[data-testid="entity-library-card"][data-entity-id="item-long"] .entity-library-description')).toHaveText(unbrokenItem)
})
