import { expect, test } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

test.beforeEach(async ({ page }) => { await signUpFresh(page) })

test('one navigation entry and legacy character URL preserve filter/detail through reload and history', async ({ page }) => {
  const character = (await (await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'Lan hồ sơ gốc', appearance: 'Ngoại hình đầy đủ', voice: { language: 'vi', accent: 'Miền Nam', pitch: '', timbre: '', pace: '', articulation: '', habits: '' } } })).json()).character
  const item = (await (await page.request.post(`${BASE}/api/entity-library/assets`, { data: { kind: 'item', name: 'Đạo cụ gốc', description: 'Đồ vật' } })).json()).asset
  await page.goto(`${BASE}/?page=characters&entity=${character.id}`)
  await expect(page).toHaveURL(new RegExp(`page=entities.*type=character.*entity=${character.id}`))
  const dialog = page.getByTestId('entity-details-dialog')
  await expect(dialog).toContainText('Miền Nam')
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Nhân vật & tài nguyên', exact: true })).toHaveCount(1)
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Nhân vật', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('entity-library-filter-item').click()
  await expect(page).toHaveURL(/type=item/)
  await page.getByTestId('entity-library-card').getByTestId('entity-card-details').click()
  await expect(dialog).toContainText('Đạo cụ gốc')
  await expect(page).toHaveURL(new RegExp(`entity=${item.id}.*entityKind=item`))
  await page.reload()
  await expect(dialog).toContainText('Đạo cụ gốc')
  await page.goBack()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('entity-library-filter-item')).toHaveAttribute('aria-pressed', 'true')
  await page.goBack()
  await expect(page.getByTestId('entity-library-filter-character')).toHaveAttribute('aria-pressed', 'true')
})

test('character detail hydrates full voice and editing preserves native voice', async ({ page }) => {
  const appearance = `${'Ngoại hình 🐉 '.repeat(30)}đuôi nguyên bản`
  const character = (await (await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'Lan giọng nói', appearance, voice: { language: 'vi', accent: 'Miền Nam', pitch: 'Trầm', timbre: 'Ấm', pace: 'Chậm', articulation: 'Rõ', habits: 'Ngắt câu' } } })).json()).character
  await page.goto(`${BASE}/?page=entities&type=character&entity=${character.id}&entityKind=character`)
  const dialog = page.getByTestId('entity-details-dialog')
  await expect(dialog.getByTestId('entity-details-description')).toHaveText(appearance)
  await expect(dialog).toContainText('Ngắt câu')
  await dialog.getByRole('button', { name: /Sửa —/ }).click()
  const editor = page.getByTestId('entity-editor-dialog')
  await expect(editor.locator('textarea[name="voice.accent"]')).toHaveValue('Miền Nam')
  await editor.locator('input[name="name"]').fill('Lan đổi tên')
  await editor.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const saved = (await (await page.request.get(`${BASE}/api/shared-characters/${character.id}`)).json()).character
  expect(saved.voice).toEqual({ language: 'vi', accent: 'Miền Nam', pitch: 'Trầm', timbre: 'Ấm', pace: 'Chậm', articulation: 'Rõ', habits: 'Ngắt câu' })
  expect(saved.appearance).toBe(appearance)
  await page.setViewportSize({ width: 320, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('discarding edits on same-page browser Back closes editor and restores filter', async ({ page }) => {
  await page.goto(`${BASE}/?page=entities&type=character`)
  await page.getByTestId('entity-library-filter-item').click()
  await page.getByTestId('entity-library-create').click()
  const editor = page.getByTestId('entity-editor-dialog')
  await editor.locator('input[name="name"]').fill('Bản nháp chưa lưu')
  await page.goBack()
  await expect(page.getByTestId('entity-dirty-dialog')).toBeVisible()
  await page.getByTestId('entity-dirty-dialog').getByRole('button', { name: 'Bỏ thay đổi và rời đi' }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByTestId('entity-library-filter-character')).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/type=character/)
})
