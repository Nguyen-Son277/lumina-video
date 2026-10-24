import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

for (const width of [1440, 390]) {
  test(`Studio narration generates playable speech and remembers changes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await signUpFresh(page)
    const providerId = await seedProvider(page)
    const voice = await page.request.post(`${BASE}/api/models`, { data: { providerId, kind: 'tts', modelId: 'edge-tts/vi-VN-NamMinhNeural', displayName: 'Nam Minh' } })
    const modelId = (await voice.json()).model.id
    const projectResponse = await page.request.post(`${BASE}/api/projects`, { data: { name: 'Quảng cáo có giọng đọc' } })
    const projectId = (await projectResponse.json()).project.id
    await page.goto(BASE)
    await page.getByRole('button', { name: /Quảng cáo có giọng đọc/ }).first().click()
    await page.getByRole('button', { name: 'Xuất video', exact: true }).click()
    let modal = page.getByRole('dialog', { name: 'Xuất video dự án' })
    const panel = modal.getByRole('region', { name: 'Thuyết minh', exact: true })
    await expect(panel).toBeVisible()
    expect((await (await page.request.get(`${BASE}/api/speech-jobs?projectId=${projectId}`)).json()).jobs).toHaveLength(0)
    await panel.getByLabel('Thêm giọng thuyết minh xuyên suốt').check()
    await panel.getByLabel('Giọng thuyết minh', { exact: true }).selectOption(modelId)
    await panel.getByLabel('Kịch bản thuyết minh toàn video').fill('Xin chào, đây là video quảng cáo của chúng tôi.')
    await panel.getByRole('button', { name: 'Tạo giọng và nghe thử' }).click()
    await expect(panel.locator('audio')).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByRole('link', { name: 'Tải MP3', exact: true }).first()).toHaveAttribute('href', /\/speech-jobs\/[^/]+\/file\?download=1/)
    await expect.poll(() => panel.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(2)
    await panel.locator('audio').evaluate((audio: HTMLAudioElement) => audio.play())
    await expect.poll(() => panel.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.1)
    await panel.locator('audio').evaluate((audio: HTMLAudioElement) => audio.pause())
    mkdirSync('artifacts', { recursive: true })
    await page.screenshot({ path: `artifacts/speech-studio-${width}.png`, fullPage: true })
    await modal.getByRole('button', { name: 'Đóng', exact: true }).click()
    await page.getByRole('button', { name: 'Xuất video', exact: true }).click()
    modal = page.getByRole('dialog', { name: 'Xuất video dự án' })
    await expect(modal.getByLabel('Kịch bản thuyết minh toàn video')).toHaveValue('Xin chào, đây là video quảng cáo của chúng tôi.')
    await expect(modal.locator('audio')).toBeVisible()
    await modal.getByLabel('Kịch bản thuyết minh toàn video').fill('Kịch bản quảng cáo mới.')
    await expect(modal.locator('audio')).toHaveCount(0)
    await expect(modal).toContainText('Bản xuất sẽ tạo giọng đọc mới.')
    expect((await (await page.request.get(`${BASE}/api/speech-jobs?projectId=${projectId}`)).json()).jobs).toHaveLength(1)
    await modal.getByLabel('Âm thanh gốc của video').selectOption('mix')
    const volume = modal.getByLabel('Âm lượng tiếng gốc')
    await volume.press('Home')
    for (let step = 0; step < 25; step += 1) await volume.press('ArrowRight')
    await expect.poll(async () => (await (await page.request.get(`${BASE}/api/speech-jobs/preferences?projectId=${projectId}`)).json()).preferences.originalVolume).toBe(0.25)
    await modal.getByRole('button', { name: 'Đóng', exact: true }).click()
  })
}

test('runs Quick narration with a configured voice after closing the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 })
  await signUpFresh(page)
  const providerId = await seedProvider(page)
  await page.goto(`${BASE}/?page=settings`)
  await expect(page.getByText('Nguồn danh sách giọng', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Đồng bộ giọng', exact: true })).toHaveCount(0)
  const voiceResponse = await page.request.post(`${BASE}/api/models`, { data: { providerId, kind: 'tts', modelId: 'edge-tts/vi-VN-HoaiMyNeural', displayName: 'Hoài My' } })
  expect(voiceResponse.ok()).toBe(true)
  const voiceId = (await voiceResponse.json()).model.id
  const videoModel = await seedModel(page, providerId, { kind: 'video', modelId: 'sora-quick-voice' })
  const sessionId = (await (await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Quảng cáo Quick' } })).json()).session.id
  const graph = { schemaVersion: 1, nodes: [{ id: 'video', kind: 'video', x: 100, y: 100, data: { modelId: videoModel } }], edges: [] }
  const root = `${BASE}/api/quick-sessions/${sessionId}/canvas`
  expect((await page.request.put(root, { data: { baseRevision: 0, graph } })).ok()).toBe(true)
  await page.goto(`${BASE}/?page=quick&session=${sessionId}&view=canvas`)
  await page.locator('.canvas-toolbar').getByRole('button', { name: 'Xuất video', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Xuất video', exact: true })
  await modal.getByLabel('Thêm giọng thuyết minh xuyên suốt').check()
  await modal.getByLabel('Giọng thuyết minh', { exact: true }).selectOption(voiceId)
  await modal.getByLabel('Kịch bản thuyết minh toàn video').fill('Giọng nữ cho chiến dịch quảng cáo.')
  const submitted = page.waitForResponse(response => response.url().endsWith('/api/speech-jobs') && response.request().method() === 'POST')
  await modal.getByRole('button', { name: 'Tạo giọng và nghe thử' }).click()
  const jobId = (await (await submitted).json()).job.id
  await modal.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect.poll(async () => (await (await page.request.get(`${BASE}/api/speech-jobs/${jobId}`)).json()).job.status).toBe('succeeded')
  await page.locator('.canvas-toolbar').getByRole('button', { name: 'Xuất video', exact: true }).click()
  await expect(modal.getByLabel('Giọng thuyết minh', { exact: true })).toHaveValue(voiceId)
  await expect(modal.locator('audio')).toBeVisible()
  mkdirSync('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/speech-quick-390.png', fullPage: true })
})
