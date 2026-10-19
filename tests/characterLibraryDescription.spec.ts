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
  await page.route('**/api/shared-characters', async route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET' && url.pathname === '/api/shared-characters') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ characters }),
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
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const [id, appearance] of appearances) {
      const body = page.locator('.character-library-card').filter({ has: page.getByRole('heading', { name: `Nhân vật ${id}`, exact: true }) }).locator('.character-library-body')
      const paragraph = body.locator('> p')
      await expect(paragraph).toHaveCount(1)
      const expected = appearance ? expectedDisplay(appearance) : 'Chưa mô tả ngoại hình.'
      const actual = await paragraph.evaluate(element => element.textContent ?? '')
      expect(actual).toBe(expected)
      const expectedCodepoints = appearance
        ? Math.min(Array.from(appearance).length, 200)
        : Array.from('Chưa mô tả ngoại hình.').length
      expect(Array.from(actual).length).toBe(expectedCodepoints)
    }
  }
})

test('edit dialog retains full appearance and leaves character name and voice summary unchanged', async ({ page }) => {
  const appearance = `${'🐉'.repeat(198)}ế\nngoại hình nguyên bản`
  const target = character('edit', appearance)
  await mockSharedCharacters(page, [target])
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Nhân vật', exact: true }).click()

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const card = page.locator('.character-library-card').filter({ has: page.getByRole('heading', { name: target.name, exact: true }) })
    await expect(card.locator('.character-library-body > p')).toHaveText(expectedDisplay(appearance))
    await expect(card).toContainText('Giọng: Miền Nam')
    await expect(card).toContainText('Cao độ: Trung trầm')
    await card.getByRole('button', { name: 'Sửa', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Sửa nhân vật / giọng nói' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Ngoại hình')).toHaveValue(appearance)
    await expect(dialog.getByLabel('Tên', { exact: true })).toHaveValue(target.name)
    await expect(dialog.getByLabel('Giọng vùng miền', { exact: true })).toHaveValue('Miền Nam')
    await expect(dialog.getByLabel('Cao độ', { exact: true })).toHaveValue('Trung trầm')
    await dialog.getByRole('button', { name: 'Đóng' }).click()
    await expect(dialog).toHaveCount(0)
  }
})
