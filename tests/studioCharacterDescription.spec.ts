import { expect, test } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

test('Studio character cards shorten description without changing the edit value', async ({ page }) => {
  await signUpFresh(page)
  const projectResponse = await page.request.post(`${BASE}/api/projects`, { data: { name: 'Card description', language: 'vi' } })
  expect(projectResponse.ok()).toBe(true)
  const { project } = await projectResponse.json()
  const appearance = '😀'.repeat(210)
  const response = await page.request.post(`${BASE}/api/projects/${project.id}/characters`, { data: { name: 'Lan', appearance } })
  expect(response.ok()).toBe(true)
  await page.goto(BASE)
  await page.getByRole('button', { name: /Card description/ }).click()
  await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click()
  const card = page.locator('.project-character-card')
  await expect(card.locator(':scope > p')).toHaveText(`${'😀'.repeat(197)}...`)
  await card.getByRole('button', { name: 'Sửa', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Ngoại hình', exact: true })).toHaveValue(appearance)
})
