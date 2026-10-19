import { expect, test, type Page } from '@playwright/test'
import { BASE, signUpFresh } from './helpers/auth'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const NOW = 1_800_000_000_000

type SceneDto = {
  id: string
  projectId: string
  title: string
  prompt: string
  characterId: string | null
  dialogue: string
  modelId: string
  params: Record<string, unknown>
  position: number
  selectedGenerationId: string | null
  background: string
  backgroundUploadId: string | null
  backgroundUrl: string | null
  approved: boolean
  autoGenerate: boolean
}

type GenerationDto = {
  id: string
  kind: 'video'
  prompt: string
  projectId: string
  sceneId: string
  status: 'succeeded' | 'downloading' | 'unknown'
  progress: number | null
  provider: string
  model: string
  params: Record<string, unknown>
  errorCode: string | null
  errorMessage: string | null
  providerJobId: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  assets: Array<{ id: string; mimeType: string; byteSize: number; url: string }>
}

async function seedProjectAndScene(page: Page, name: string): Promise<{ projectId: string; scene: SceneDto }> {
  const projectResponse = await page.request.post(`${BASE}/api/projects`, {
    data: { name, description: 'Scene cover regression', style: '', language: 'vi', archived: false },
  })
  expect(projectResponse.ok()).toBe(true)
  const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id

  const uploadResponse = await page.request.post(`${BASE}/api/uploads`, {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(PNG_BASE64, 'base64'),
  })
  expect(uploadResponse.ok()).toBe(true)
  const uploadId = ((await uploadResponse.json()) as { upload: { id: string } }).upload.id

  const sceneResponse = await page.request.post(`${BASE}/api/projects/${projectId}/scenes`, {
    data: {
      title: 'Covered scene',
      prompt: 'A quiet forest at sunrise',
      background: 'Pine forest',
      backgroundUploadId: uploadId,
    },
  })
  expect(sceneResponse.ok()).toBe(true)
  const scene = (await sceneResponse.json() as { scene: SceneDto }).scene
  return { projectId, scene }
}

function generation(
  id: string,
  projectId: string,
  sceneId: string,
  createdAt: number,
  status: GenerationDto['status'],
  assetUrl?: string,
): GenerationDto {
  return {
    id,
    kind: 'video',
    prompt: `Prompt ${id}`,
    projectId,
    sceneId,
    status,
    progress: status === 'downloading' ? 70 : null,
    provider: 'mock-provider',
    model: 'mock-video-model',
    params: {},
    errorCode: null,
    errorMessage: null,
    providerJobId: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: status === 'succeeded' ? createdAt : null,
    assets: assetUrl ? [{ id: `asset-${id}`, mimeType: 'video/mp4', byteSize: 1234, url: assetUrl }] : [],
  }
}

async function openScenesWithMockedSelections(
  page: Page,
  projectId: string,
  scene: SceneDto,
  generations: GenerationDto[],
): Promise<() => Promise<void>> {
  await page.route(`**/api/projects/${projectId}/scenes`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = (await response.json()) as { scenes: SceneDto[] }
    await route.fulfill({ response, json: { scenes: body.scenes.map((item) => item.id === scene.id ? scene : item) } })
  })
  await page.route('**/api/generations?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('projectId') !== projectId) return route.continue()
    if (url.searchParams.get('latestPerScene') === 'true') {
      const newest = generations.reduce<GenerationDto | undefined>((latest, item) =>
        !latest || item.createdAt > latest.createdAt ? item : latest, undefined)
      return route.fulfill({ json: { generations: newest ? [newest] : [] } })
    }
    if (!url.searchParams.has('kind') && !url.searchParams.has('latestPerScene')) {
      return route.fulfill({ json: { generations } })
    }
    return route.continue()
  })
  // Hold media requests so metadata probing cannot replace the tested cover; abort them in teardown.
  const heldRequests: Array<() => Promise<void>> = []
  await page.route('**/hold-video/**', (route) => new Promise<void>((resolve) => {
    heldRequests.push(() => route.abort().then(resolve))
  }))

  await page.goto(BASE)
  await page.getByRole('button', { name: /Scene cover/ }).first().click()
  await expect(page.locator('.project-tab-panel')).toBeVisible()
  await page.getByRole('tab', { name: 'Cảnh video', exact: true }).click()
  await expect(page.locator('.project-scene-list')).toBeVisible()
  return async () => { await Promise.all(heldRequests.map((release) => release())) }
}

test('successful newest cover wins while the older selected version remains labelled', async ({ page }) => {
  await signUpFresh(page)
  const { projectId, scene } = await seedProjectAndScene(page, 'Scene cover selected')
  const old = generation('old-selected', projectId, scene.id, NOW - 1_000, 'succeeded', 'http://127.0.0.1/hold-video/old.mp4')
  const newest = generation('newest-cover', projectId, scene.id, NOW, 'succeeded', 'http://127.0.0.1/hold-video/new.mp4')
  scene.selectedGenerationId = old.id

  const releaseRequests = await openScenesWithMockedSelections(page, projectId, scene, [old, newest])

  try {
    const card = page.locator('.project-scene-card').filter({ hasText: 'Covered scene' })
    await expect(card).toContainText('Đã chọn phiên bản')
    await expect(card.locator('.project-scene-thumb video')).toHaveAttribute('src', newest.assets[0].url)
  } finally {
    await releaseRequests()
  }
})

for (const status of ['unknown', 'downloading'] as const) {
  test(`latest ${status} cover falls back to the uploaded illustration`, async ({ page }) => {
    await signUpFresh(page)
    const { projectId, scene } = await seedProjectAndScene(page, `Scene cover ${status}`)
    const old = generation('old-selected', projectId, scene.id, NOW - 1_000, 'succeeded', 'http://127.0.0.1/hold-video/old.mp4')
    const newest = generation('newest-cover', projectId, scene.id, NOW, status, 'http://127.0.0.1/hold-video/new.mp4')
    scene.selectedGenerationId = old.id

    const releaseRequests = await openScenesWithMockedSelections(page, projectId, scene, [old, newest])

    try {
      const card = page.locator('.project-scene-card').filter({ hasText: 'Covered scene' })
      await expect(card).toContainText('Đã chọn phiên bản')
      await expect(card.locator('.project-scene-thumb img')).toHaveAttribute('src', scene.backgroundUrl!)
    } finally {
      await releaseRequests()
    }
  })
}
