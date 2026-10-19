import { test, expect, type Page } from '@playwright/test'
import type { Generation } from '../src/api/types'
import type { ProjectScene } from '../src/api/projectTypes'
import { BASE, seedProvider, seedModel, signUpFresh } from './helpers/auth'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

async function uploadBackground(page: Page): Promise<string> {
  const response = await page.request.post(`${BASE}/api/uploads`, {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(PNG_BASE64, 'base64'),
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { upload: { id: string } }).upload.id
}

function mockVideo(id: string, sceneId: string, status: Generation['status'], assets: Generation['assets'] = [], now = Date.now()): Generation {
  return {
    id, kind: 'video', prompt: 'A cover video', projectId: null, sceneId,
    status, progress: status === 'running' ? 50 : null, provider: 'Mock provider', model: 'Mock video', params: {},
    errorCode: null, errorMessage: null, providerJobId: null, providerStatus: null,
    createdAt: now, updatedAt: now, completedAt: status === 'succeeded' ? now : null, assets,
  }
}

const videoAsset = (id: string): Generation['assets'][number] => ({
  id, mimeType: 'video/mp4', byteSize: 20, variant: 'original', sourceAssetId: null, url: `/api/assets/${id}`,
})

const sceneCard = (page: Page, title: string) => page.locator('.project-scene-card').filter({
  has: page.getByRole('checkbox', { name: `Chọn cảnh ${title}`, exact: true }),
})

async function enterProject(page: Page, projectName: string) {
  await page.goto(`${BASE}/?page=studio`)
  await page.getByText(projectName, { exact: true }).click()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
}

// Hold only mocked video asset requests; resolve all held requests during teardown.
async function holdAssetRequests(page: Page) {
  const held: Array<() => Promise<void>> = []
  await page.route('**/api/assets/*', route => new Promise<void>(resolve => {
    held.push(() => route.abort().then(resolve))
  }))
  return async () => { await Promise.all(held.map(release => release())) }
}

test('scene cards show latest successful video only when not superseded by pending work', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'cover-video', displayName: 'Cover video', kind: 'video' })
  const project = (await (await page.request.post(`${BASE}/api/projects`, { data: { name: 'Latest cover project' } })).json()).project
  const scenes: ProjectScene[] = []
  for (const title of ['First cover', 'Second cover', 'Polling anchor']) {
    const backgroundUploadId = await uploadBackground(page)
    const response = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
      data: { title, prompt: 'A cover', modelId, params: { size: '1280x720', seconds: '5' }, backgroundUploadId, autoGenerate: true },
    })
    expect(response.ok()).toBe(true)
    scenes.push((await response.json()).scene as ProjectScene)
  }
  const anchor = scenes[2]!

  let latest: Generation[] = [mockVideo('initial-running', scenes[0].id, 'running'), mockVideo('anchor-running', scenes[2].id, 'running')]
  let latestCalls = 0
  await page.route('**/api/generations?*latestPerScene=true', async route => {
    latestCalls++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ generations: latest }) })
  })
  const releaseAssets = await holdAssetRequests(page)
  try {
    await enterProject(page, 'Latest cover project')
    await expect.poll(() => latestCalls, { timeout: 10_000 }).toBeGreaterThan(0)
    for (const scene of scenes) {
      const card = sceneCard(page, scene.title)
      await expect(card.locator('.project-scene-thumb img')).toBeVisible()
      await expect(card.locator('.project-scene-thumb img')).toHaveAttribute('src', new RegExp('/api/uploads/'))
      await expect(card.locator('.project-scene-thumb video')).toHaveCount(0)
    }

    // Latest-only API results include all scenes, and pending generation supersedes old success.
    latest = [mockVideo('old-success', scenes[0].id, 'succeeded', [videoAsset('video-one')]), mockVideo('queued', scenes[1].id, 'queued'), mockVideo('anchor-running', scenes[2].id, 'running')]
    await expect.poll(() => latestCalls, { timeout: 10_000 }).toBeGreaterThan(1)
    await expect(sceneCard(page, 'First cover').locator('.project-scene-thumb video')).toBeVisible()
    await expect(sceneCard(page, 'First cover').locator('.project-scene-thumb img')).toHaveCount(0)
    await expect(sceneCard(page, 'Second cover').locator('.project-scene-thumb img')).toBeVisible()

    // Polling queued -> success updates this mounted page without reloading.
    latest = [mockVideo('old-success', scenes[0].id, 'succeeded', [videoAsset('video-one')]), mockVideo('new-success', scenes[1].id, 'succeeded', [videoAsset('video-two')]), mockVideo('anchor-running', scenes[2].id, 'running')]
    await expect(sceneCard(page, 'Second cover').locator('.project-scene-thumb video')).toBeVisible({ timeout: 10_000 })

    // Keep the unrelated older-scene version in the response while checking missing/failed fallback.
    latest = [mockVideo('old-success', scenes[0].id, 'succeeded', [videoAsset('video-one')]), mockVideo('failed', scenes[1].id, 'failed', [videoAsset('failed-video')]), mockVideo('anchor-running', scenes[2].id, 'running')]
    await expect(sceneCard(page, 'Second cover').locator('.project-scene-thumb img')).toBeVisible({ timeout: 10_000 })
    latest = [mockVideo('missing-asset', scenes[0].id, 'succeeded'), mockVideo('failed', scenes[1].id, 'failed', [videoAsset('failed-video')]), mockVideo('anchor-running', scenes[2].id, 'running')]
    await expect(sceneCard(page, 'First cover').locator('.project-scene-thumb img')).toBeVisible({ timeout: 10_000 })
    await expect(sceneCard(page, 'Second cover').locator('.project-scene-thumb img')).toBeVisible()
  } finally {
    await releaseAssets()
  }
})

test('video media errors fall back to uploaded image, recover on new URL, and route failure keeps scenes', async ({ page }) => {
  await signUpFresh(page)
  const provider = await seedProvider(page)
  const modelId = await seedModel(page, provider, { modelId: 'broken-cover-video', kind: 'video' })
  const project = (await (await page.request.post(`${BASE}/api/projects`, { data: { name: 'Broken cover project' } })).json()).project
  const backgroundUploadId = await uploadBackground(page)
  const response = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
    data: { title: 'Broken video', prompt: 'A cover', modelId, backgroundUploadId },
  })
  expect(response.ok()).toBe(true)
  const scene = (await response.json()).scene as ProjectScene
  const anchorUploadId = await uploadBackground(page)
  const anchorResponse = await page.request.post(`${BASE}/api/projects/${project.id}/scenes`, {
    data: { title: 'Polling anchor', prompt: 'A cover', modelId, backgroundUploadId: anchorUploadId },
  })
  expect(anchorResponse.ok()).toBe(true)
  const anchor = (await anchorResponse.json()).scene as ProjectScene
  let failRoute = false
  let latest: Generation[] = [mockVideo('bad-video', scene.id, 'succeeded', [videoAsset('bad-asset')], 100), mockVideo('anchor-running', anchor.id, 'running')]
  let latestCalls = 0
  await page.route('**/api/generations?*latestPerScene=true', async route => {
    latestCalls++
    return failRoute
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ generations: latest }) })
  })
  const releaseAssets = await holdAssetRequests(page)
  try {
    await enterProject(page, 'Broken cover project')
    const card = sceneCard(page, 'Broken video')
    const thumb = card.locator('.project-scene-thumb')
    const video = thumb.locator('video')
    await expect(video).toBeVisible()
    await video.evaluate((element: HTMLVideoElement) => element.dispatchEvent(new Event('error')))
    await expect(thumb.locator('img')).toBeVisible()

    // Same mounted component receives a new URL and clears its media-error fallback.
    latest = [mockVideo('recovered', scene.id, 'succeeded', [{ ...videoAsset('recovered-asset'), url: '/api/assets/recovered-asset' }], 200), mockVideo('anchor-running', anchor.id, 'running')]
    await expect(card.locator('.project-scene-thumb video')).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('.project-scene-thumb img')).toHaveCount(0)

    failRoute = true
    const beforeFailure = latestCalls
    await expect.poll(() => latestCalls, { timeout: 10_000 }).toBeGreaterThan(beforeFailure)
    await expect(sceneCard(page, 'Broken video').locator('.project-scene-thumb')).toBeVisible()
  } finally {
    await releaseAssets()
  }
})
