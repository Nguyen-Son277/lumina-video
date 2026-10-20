import { readFile } from 'node:fs/promises'
import { expect, test, type Download } from '@playwright/test'

async function downloadText(download: Download): Promise<string> {
  expect(await download.failure()).toBeNull()
  const path = await download.path()
  expect(path).toBeTruthy()
  return readFile(path!, 'utf8')
}
import { BASE, ensureAdminSession, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

const USER_CSV_HEADER = 'time_utc,name,kind,source,status,outcome,model_name,provider_name,project_name,scene_name,session_name,latency_ms,cost,price_currency,cost_unknown,preview,response_preview'
const ADMIN_CSV_HEADER = 'time_utc,name,user_email,kind,source,status,outcome,model_name,provider_name,project_name,scene_name,session_name,latency_ms,cost,price_currency,cost_unknown,preview,response_preview'
const REMOVED_CSV_COLUMNS = ['event_id', 'user_id', 'model_id', 'project_id', 'scene_id', 'session_id', 'bytes', 'prompt_tokens', 'completion_tokens', 'attempt_count']

function csvHeader(text: string): string {
  return text.split(/\r?\n/, 1)[0].replace(/^\uFEFF/, '')
}

function expectNoRemovedCsvColumns(text: string): void {
  const header = csvHeader(text).split(',')
  for (const column of REMOVED_CSV_COLUMNS) expect(header).not.toContain(column)
}

function expectCsvFilename(name: string, kind: 'usage' | 'admin'): void {
  expect(name).toMatch(new RegExp(`^usage-${kind === 'admin' ? 'admin' : 'user'}-.*\\.csv$`, 'i'))
}


async function seedOneMediaEvent(page: Parameters<typeof signUpFresh>[0], prompt: string) {
  const provider = await seedProvider(page)
  const model = await seedModel(page, provider, { modelId: `mock-export-${Date.now()}`, displayName: 'Export image', kind: 'image' })
  const response = await page.request.post(`${BASE}/api/generations`, { data: { modelId: model, prompt } })
  expect(response.status()).toBe(202)
  const body = (await response.json()) as { generation: { id: string } }
  await waitForGeneration(page, body.generation.id)
  return model
}

test('tải CSV theo bộ lọc hiện tại và giữ nguyên trang sử dụng', async ({ page }) => {
  const account = await signUpFresh(page)
  await seedOneMediaEvent(page, 'usage export visible prompt')
  await page.goto(`${BASE}/?page=usage`)
  await expect(page.getByRole('heading', { name: /Nhật ký/ })).toBeVisible()
  await page.getByLabel('Loại', { exact: true }).selectOption('image')
  const button = page.getByRole('button', { name: /CSV/i })
  await expect(button).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  expectCsvFilename(download.suggestedFilename(), 'usage')
  const text = await downloadText(download)
  expect(csvHeader(text)).toBe(USER_CSV_HEADER)
  expectNoRemovedCsvColumns(text)
  expect(text).toContain(`"${account.name}"`)
  expect(text).toContain('usage export visible prompt')
  await expect(page.locator('.usage-table')).toContainText('usage export visible prompt')
  await page.getByRole('combobox', { name: 'Khoảng thời gian', exact: true }).selectOption('custom')
  await page.getByLabel('Từ ngày', { exact: true }).fill('2025-03-05')
  await page.getByLabel('Đến ngày', { exact: true }).fill('2025-03-01')
  await expect(button).toBeDisabled()
  await page.getByLabel('Đến ngày', { exact: true }).fill('2025-03-06')
  await expect(button).toBeEnabled()
})

test('admin có thể tải dữ liệu đã chọn hoặc toàn bộ và vẫn ở panel admin', async ({ page }) => {
  const account = await signUpFresh(page)
  await seedOneMediaEvent(page, 'admin usage export prompt')
  await ensureAdminSession(page)
  await page.goto(BASE)
  const usageTab = page.locator('.admin-tabs [role="tab"]').nth(1)
  await usageTab.click()
  const panel = page.locator('.usage-admin')
  await expect(panel).toBeVisible()
  const exportButton = panel.getByRole('button', { name: /CSV/i })
  await expect(exportButton).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()])
  expectCsvFilename(download.suggestedFilename(), 'admin')
  const allText = await downloadText(download)
  expect(csvHeader(allText)).toBe(ADMIN_CSV_HEADER)
  expectNoRemovedCsvColumns(allText)
  expect(allText).toContain(account.email)
  const accounts = panel.getByLabel('Người dùng', { exact: true })
  await expect(accounts.locator('option').filter({ hasText: account.email })).toHaveCount(1)
  const selectedId = await accounts.locator('option').filter({ hasText: account.email }).getAttribute('value')
  await accounts.selectOption(selectedId!)
  const [selected] = await Promise.all([page.waitForEvent('download'), exportButton.click()])
  expectCsvFilename(selected.suggestedFilename(), 'admin')
  const selectedText = await downloadText(selected)
  expect(csvHeader(selectedText)).toBe(ADMIN_CSV_HEADER)
  expectNoRemovedCsvColumns(selectedText)
  expect(selectedText).toContain(`"${account.name}"`)
  expect(selectedText).toContain(account.email)
  expect(selectedText).toContain('admin usage export prompt')
  const session = await page.request.get(`${BASE}/api/auth/me`)
  expect((await session.json()).user.role).toBe('admin')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.usage-table')).toContainText(account.email)
})
