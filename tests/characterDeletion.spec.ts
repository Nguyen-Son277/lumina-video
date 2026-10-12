import { expect, test, type Page } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

/**
 * Xoá nhân vật khi còn tham chiếu.
 *
 * Ca chính là lỗi thật đã gặp: nhân vật chỉ nằm trong cảnh của dự án **đã vào Thùng
 * rác** nên không còn đường gỡ, khiến người dùng không xoá được dù không có phiên nào
 * giữ nhân vật.
 */

async function seedCharacterInScene(page: Page, projectName: string, characterName: string) {
  const project = (await (await page.request.post(`${BASE}/api/projects`, { data: { name: projectName } })).json()).project
  const character = (await (await page.request.post(`${BASE}/api/shared-characters`, {
    data: { name: characterName, appearance: 'váy hồng, tóc dài', voice: {} },
  })).json()).character
  const scene = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
    data: { title: 'Cảnh gặp mặt', prompt: 'đi dạo', characterId: character.id, characterIds: [character.id], dialogue: 'Chào' },
  })
  expect(scene.ok()).toBe(true)
  return { projectId: project.id as string, characterId: character.id as string, sceneId: ((await scene.json()) as { scene: { id: string } }).scene.id }
}

async function openCharacters(page: Page): Promise<void> {
  await page.goto(`${BASE}/?page=characters`)
  await expect(page.getByRole('heading', { name: /Nhân vật/ }).first()).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await signUpFresh(page)
})

test('dự án trong Thùng rác không còn giữ nhân vật: xoá được ngay', async ({ page }) => {
  const { projectId, characterId } = await seedCharacterInScene(page, 'Dự án đã bỏ', 'Lan')
  const trashed = await page.request.post(`${BASE}/api/projects/${projectId}/trash`, { data: { deleteResults: false } })
  expect(trashed.ok()).toBe(true)

  await openCharacters(page)
  await page.getByRole('button', { name: 'Xóa Lan', exact: true }).click()

  // Không có hộp thoại chặn: nhân vật được xoá và server gỡ tham chiếu ở dự án trong thùng rác.
  await expect(page.getByRole('dialog', { name: 'Nhân vật vẫn đang được sử dụng' })).toHaveCount(0)
  await expect(page.getByText('Đã xóa nhân vật và gỡ khỏi 1 cảnh, 0 node Canvas.')).toBeVisible()
  await expect(page.locator('.character-library-card')).toHaveCount(0)

  const gone = await page.request.get(`${BASE}/api/shared-characters/${characterId}`)
  expect(gone.status()).toBe(404)
})

test('dự án đang dùng thì hỏi xác nhận, nêu tên dự án và gỡ khi đồng ý', async ({ page }) => {
  const { characterId, sceneId } = await seedCharacterInScene(page, 'Cuộc Hẹn Hò Sang Trọng', 'Minh')

  await openCharacters(page)
  await page.getByRole('button', { name: 'Xóa Minh', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Nhân vật vẫn đang được sử dụng' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Cuộc Hẹn Hò Sang Trọng')
  await expect(dialog).toContainText('Đang dùng')
  await expect(dialog).toContainText('1 cảnh')
  await expect(dialog).toContainText('Cảnh gặp mặt')

  // Chưa xác nhận thì nhân vật vẫn còn.
  const stillThere = await page.request.get(`${BASE}/api/shared-characters/${characterId}`)
  expect(stillThere.status()).toBe(200)

  await dialog.getByRole('button', { name: 'Gỡ khỏi các cảnh/Canvas và xoá' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.character-library-card')).toHaveCount(0)

  const gone = await page.request.get(`${BASE}/api/shared-characters/${characterId}`)
  expect(gone.status()).toBe(404)

  // Cảnh giữ lời thoại nhưng không còn nhân vật này.
  const scene = await page.request.get(`${BASE}/api/projects/${(await (await page.request.get(`${BASE}/api/projects`)).json()).projects[0].id}/scenes`)
  const body = (await scene.json()) as { scenes: Array<{ id: string; characterId: string | null; characterIds: string[]; dialogue: string }> }
  const updated = body.scenes.find((item) => item.id === sceneId)!
  expect(updated.characterId).toBeNull()
  expect(updated.characterIds).toEqual([])
  expect(updated.dialogue).toBe('Chào')
})
