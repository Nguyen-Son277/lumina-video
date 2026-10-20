import { expect, test, type Page } from '@playwright/test'
import type { ProjectCharacter } from '../src/api/projectTypes'
import { BASE, signUpFresh } from './helpers/auth'

function character(id: string, appearance: string): ProjectCharacter {
  return {
    id,
    projectId: null,
    name: `Nhân vật ${id}`,
    appearance,
    voice: {
      language: 'vi',
      accent: 'Miền Nam',
      pitch: 'Trung trầm',
      timbre: 'Ấm',
      pace: 'Vừa phải',
      articulation: 'Rõ ràng',
      habits: 'Ngắt nhịp nhẹ',
    },
    referenceUrl: null,
    referenceMime: null,
    referenceBytes: null,
  }
}

async function mockSharedCharacters(page: Page, characters: ProjectCharacter[]) {
  await page.route('**/api/shared-characters/*', async route => {
    const target = characters.find(character => route.request().url().endsWith(`/${character.id}`))
    if (target) return route.fulfill({ json: { character: target } })
    await route.continue()
  })
  await page.route('**/api/entity-library', async route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET' && url.pathname === '/api/entity-library') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entities: characters.map(character => ({ id: character.id, kind: 'character', name: character.name, handle: character.id, description: character.appearance, continuityNotes: '', revision: 1, reference: null })) }),
      })
    } else {
      await route.continue()
    }
  })
}

function expectedDisplay(appearance: string): string {
  const codepoints = Array.from(appearance)
  return codepoints.length > 200 ? `${codepoints.slice(0, 197).join('')}...` : appearance
}

test.beforeEach(async ({ page }) => { await signUpFresh(page) })

test('shows empty and 199/200/201-codepoint appearances verbatim or truncated', async ({ page }) => {
  const appearances = [
    ['', ''],
    ['199', `${'🐉'.repeat(193)}ế\ncuối`],
    ['200', `${'🌿'.repeat(194)}ế\ncuối`],
    ['201', `${'🪷'.repeat(195)}ế\ncuối`],
  ] as const
  const characters = appearances.map(([id, appearance]) => character(id, appearance))
  await mockSharedCharacters(page, characters)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật & tài nguyên', exact: true }).click()

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const [id, appearance] of appearances) {
      const body = page.locator('[data-testid="entity-library-card"][data-entity-kind="character"]').filter({ has: page.getByRole('heading', { name: `Nhân vật ${id}`, exact: true }) })
      const paragraph = body.getByTestId('entity-card-description')
      await expect(paragraph).toHaveCount(1)
      const expected = appearance ? expectedDisplay(appearance) : 'Chưa có mô tả'
      const actual = await paragraph.evaluate(element => element.textContent ?? '')
      expect(actual).toBe(expected)
      const expectedCodepoints = appearance
        ? Math.min(Array.from(appearance).length, 200)
        : Array.from('Chưa có mô tả').length
      expect(Array.from(actual).length).toBe(expectedCodepoints)
    }
  }
})

test('edit dialog retains full appearance and leaves character name and voice summary unchanged', async ({ page }) => {
  const appearance = `${'🐉'.repeat(198)}ế\nngoại hình nguyên bản`
  const target = character('edit', appearance)
  await mockSharedCharacters(page, [target])
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật & tài nguyên', exact: true }).click()

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const card = page.locator('[data-testid="entity-library-card"][data-entity-kind="character"]').filter({ has: page.getByRole('heading', { name: target.name, exact: true }) })
    await expect(card.getByTestId('entity-card-description')).toHaveText(expectedDisplay(appearance))
    await card.getByTestId('entity-card-details').click()
    const details = page.getByTestId('entity-details-dialog')
    await expect(details).toContainText('Miền Nam')
    await expect(details).toContainText('Trung trầm')
    await expect(details).toContainText(appearance)
    await details.getByRole('button', { name: 'Đóng', exact: true }).click()
    await card.getByRole('button', { name: `Sửa — ${target.name}`, exact: true }).click()
    const dialog = page.getByTestId('entity-editor-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Ngoại hình')).toHaveValue(appearance)
    await expect(dialog.getByLabel('Tên', { exact: true })).toHaveValue(target.name)
    await expect(dialog.locator('[name="voice.accent"]')).toHaveValue('Miền Nam')
    await expect(dialog.locator('[name="voice.pitch"]')).toHaveValue('Trung trầm')
    await dialog.getByRole('button', { name: 'Đóng', exact: true }).last().click()
    await expect(dialog).toHaveCount(0)
  }
})
