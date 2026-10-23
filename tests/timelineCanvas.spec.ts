import { expect, test, type APIResponse, type Page } from '@playwright/test'
import type { CanvasGraph, CanvasGroup } from '../shared/canvas'
import type { ApplyResult, PlanSession } from '../src/api/planner'
import type { CanvasBoard, CanvasPreview, CanvasRun } from '../src/api/canvas'
import { MOCK_PNG_BYTES } from '../server/generations/adapters/mock'
import { BASE, seedModel, seedProvider, signUpFresh, waitForGeneration } from './helpers/auth'

/** Real planner/Canvas APIs and UI; the isolated Playwright server forces PROVIDER_MODE=mock. */
async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), `${response.url()}: ${await response.text()}`).toBe(status)
  return response.json() as Promise<T>
}

async function seedTimeline(page: Page): Promise<PlanSession> {
  await signUpFresh(page)
  const providerId = await seedProvider(page) // Reserved .test host; never a paid provider.
  const chatModelId = await seedModel(page, providerId, { modelId: 'mock-chat-model', kind: 'llm' })
  const imageModelId = await seedModel(page, providerId, { modelId: 'mock-image-model', kind: 'image' })
  const videoModelId = await seedModel(page, providerId, { modelId: 'mock-video-model', displayName: 'Timeline mock video', kind: 'video' })
  const created = await json<{ session: PlanSession }>(await page.request.post(`${BASE}/api/plans`, {
    data: { kind: 'planner', title: 'Timeline Canvas E2E' },
  }), 201)
  const root = `${BASE}/api/plans/${created.session.id}`
  await json(await page.request.patch(`${root}/setup`, { data: { chatModelId, imageModelId, videoModelId } }))
  const script = await json<{ session: PlanSession }>(await page.request.post(`${root}/script`))
  expect(script.session.script?.scenes.length).toBeGreaterThan(0)
  const cast = await json<{ session: PlanSession }>(await page.request.post(`${root}/cast`))
  expect(cast.session.cast.length).toBeGreaterThan(0)
  let { session } = await json<{ session: PlanSession }>(await page.request.post(`${root}/timeline`))
  expect(session.timeline!.frames.length).toBeGreaterThanOrEqual(2)

  // Valid local raster fixtures exercise upload-to-video wiring without generating paid images.
  for (const frame of session.timeline!.frames) {
    const uploaded = await json<{ session: PlanSession }>(await page.request.post(`${root}/timeline/${frame.id}/background/upload`, {
      headers: { 'Content-Type': 'image/png' }, data: MOCK_PNG_BYTES,
    }), 201)
    session = uploaded.session
  }
  return session
}

async function readCanvas(page: Page, projectId: string): Promise<CanvasBoard> {
  return (await json<{ canvas: CanvasBoard }>(await page.request.get(`${BASE}/api/projects/${projectId}/canvas`))).canvas
}

function flowNode(page: Page, id: string) {
  // IDs contain colons: use a quoted attribute rather than an unescaped CSS ID.
  return page.locator(`.react-flow__node[data-id="${id}"]`)
}

async function finalizeInUi(page: Page, session: PlanSession, name: string): Promise<ApplyResult> {
  await page.goto(`${BASE}/?page=timeline&session=${session.id}`)
  await expect(page.getByRole('heading', { name: 'Timeline', exact: true })).toBeVisible()
  await expect(page.locator('.board-card:not(.board-card-add)')).toHaveCount(session.timeline!.frames.length)
  await page.locator('.board-heading-actions').getByRole('button', { name: 'Chốt & tạo dự án', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Chốt & tạo dự án', exact: true })
  await dialog.getByLabel('Tên dự án mới', { exact: true }).fill(name)
  await dialog.getByRole('checkbox').uncheck() // Creating a project must not silently enqueue videos.
  const applied = page.waitForResponse(response => response.url() === `${BASE}/api/plans/${session.id}/apply`
    && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'Xác nhận tạo dự án', exact: true }).click()
  const response = await applied
  expect(response.status()).toBe(201)
  const result = await response.json() as ApplyResult
  expect(result.project.name).toBe(name)
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  // Do NOT select the Canvas tab here: this is the automatic-navigation regression assertion.
  await expect(page.getByRole('tab', { name: 'Canvas', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.canvas-flow')).toBeVisible()
  await expect(page.locator('.react-flow__node-canvasGroup')).toHaveCount(session.timeline!.frames.length)
  const canvas = await readCanvas(page, result.project.id)
  expect(canvas.projectId).toBe(result.project.id)
  // The displayed node identities prove the UI opened the returned project, not an older selection.
  for (const group of canvas.graph.groups ?? []) await expect(flowNode(page, group.id)).toBeVisible()
  return result
}

async function reopenCanvas(page: Page, projectName: string): Promise<void> {
  await page.goto(`${BASE}/?page=studio`)
  await page.getByRole('button', { name: new RegExp(projectName) }).click()
  await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
  await expect(page.locator('.canvas-flow')).toBeVisible()
}

function frameGroup(graph: CanvasGraph, sessionId: string, frameId: string): CanvasGroup {
  const matches = (graph.groups ?? []).filter(group => group.timeline?.sessionId === sessionId && group.timeline.frameId === frameId)
  expect(matches).toHaveLength(1)
  return matches[0]!
}

function assertFrameGraph(graph: CanvasGraph, session: PlanSession, result: ApplyResult): void {
  expect(graph.groups).toHaveLength(session.timeline!.frames.length)
  for (const [index, frame] of session.timeline!.frames.entries()) {
    const group = frameGroup(graph, session.id, frame.id)
    expect(group.title).toBe(frame.title)
    expect(group.sceneId).toBe(result.scenes[index]!.id)
    const members = graph.nodes.filter(node => node.groupId === group.id)
    const prompt = members.filter(node => node.kind === 'prompt')
    const video = members.filter(node => node.kind === 'video')
    const image = members.filter(node => node.kind === 'upload')
    expect(prompt).toHaveLength(1)
    expect(video).toHaveLength(1)
    expect(image).toHaveLength(1)
    expect(prompt[0]!.data.text).toContain(frame.context)
    expect(video[0]!.data).toMatchObject({ sceneId: group.sceneId, modelId: session.videoModelId })
    expect(image[0]!.data.uploadId).toBeTruthy()
    // Project storyboard is an independent copied upload, not the planner original.
    expect(image[0]!.data.uploadId).not.toBe(frame.background!.uploadId)
    for (const [source, sourcePort, targetPort] of [[prompt[0]!, 'prompt', 'prompt'], [image[0]!, 'image', 'image']] as const) {
      expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: source.id, target: video[0]!.id, sourcePort, targetPort })]))
    }
    expect(members.filter(node => node.kind === 'character')).toHaveLength(new Set([
      frame.speakerCastId, ...frame.blocking.map(entry => entry.castId),
    ].filter(Boolean)).size)
    const memberIds = new Set(members.map(node => node.id))
    for (const edge of graph.edges.filter(edge => memberIds.has(edge.target))) expect(memberIds.has(edge.source)).toBe(true)
  }
}

test.use({ viewport: { width: 1600, height: 1000 } })
test.setTimeout(90_000)

test('Timeline finalize opens the exact new project Canvas with a wired group per frame', async ({ page }) => {
  const session = await seedTimeline(page)
  // An existing project catches accidental navigation to the first/previous Studio project.
  const decoy = await json<{ project: { id: string } }>(await page.request.post(`${BASE}/api/projects`, { data: { name: 'Unrelated existing project' } }), 201)
  const result = await finalizeInUi(page, session, 'Timeline automatic canvas')
  expect(result.project.id).not.toBe(decoy.project.id)
  const canvas = await readCanvas(page, result.project.id)
  assertFrameGraph(canvas.graph, session, result)
  expect(canvas.runs).toHaveLength(0)
  expect((await readCanvas(page, decoy.project.id)).graph.nodes).toHaveLength(0)
})

test('Timeline continuously syncs while preserving a Canvas prompt, then previews and runs its video', async ({ page }) => {
  const session = await seedTimeline(page)
  const projectName = 'Timeline sync and video'
  const result = await finalizeInUi(page, session, projectName)
  const initial = await readCanvas(page, result.project.id)
  const frames = structuredClone(session.timeline!.frames)
  const firstGroup = frameGroup(initial.graph, session.id, frames[0]!.id)
  const secondGroup = frameGroup(initial.graph, session.id, frames[1]!.id)
  const localPrompt = initial.graph.nodes.find(node => node.groupId === firstGroup.id && node.kind === 'prompt')!
  const untouchedPrompt = initial.graph.nodes.find(node => node.groupId === secondGroup.id && node.kind === 'prompt')!
  const video = initial.graph.nodes.find(node => node.groupId === firstGroup.id && node.kind === 'video')!
  const customText = 'Canvas-only edit: slow tracking shot with warm golden light.'
  await flowNode(page, localPrompt.id).getByRole('button', { name: 'Chi tiết', exact: true }).click()
  await page.locator('.canvas-inspector textarea').fill(customText)
  // Wait for actual persisted data, not merely an idle-looking save label.
  await expect.poll(async () => (await readCanvas(page, result.project.id)).graph.nodes.find(node => node.id === localPrompt.id)?.data.text).toBe(customText)

  // Two separate writes prove this is a durable association, not a one-time import/apply.
  for (const revision of [1, 2]) {
    frames[0] = { ...frames[0]!, title: `Synced first title ${revision}`, action: `Upstream first action ${revision}` }
    frames[1] = { ...frames[1]!, context: `Continuously updated environment ${revision}`, action: `Second action ${revision}` }
    await json<{ session: PlanSession }>(await page.request.put(`${BASE}/api/plans/${session.id}/timeline`, { data: { frames } }))
    const synced = await readCanvas(page, result.project.id)
    expect(synced.revision).toBeGreaterThan(initial.revision)
    expect(synced.graph.groups).toHaveLength(initial.graph.groups!.length)
    expect(synced.graph.nodes.map(node => node.id).sort()).toEqual(initial.graph.nodes.map(node => node.id).sort())
    expect(frameGroup(synced.graph, session.id, frames[0]!.id).title).toBe(frames[0]!.title)
    expect(synced.graph.nodes.find(node => node.id === localPrompt.id)?.data).toMatchObject({ text: customText, promptDocument: { text: customText } })
    expect(synced.graph.nodes.find(node => node.id === untouchedPrompt.id)?.data.text).toContain(frames[1]!.context)
    expect(synced.graph.nodes.find(node => node.id === localPrompt.id)).toMatchObject({ x: localPrompt.x, y: localPrompt.y, groupId: localPrompt.groupId })
    expect(frameGroup(synced.graph, session.id, frames[0]!.id).timeline?.conflicts?.length).toBeGreaterThan(0)
  }

  await reopenCanvas(page, projectName)
  await expect(flowNode(page, localPrompt.id).locator('.canvas-node-summary')).toHaveText(customText)
  await expect(flowNode(page, firstGroup.id)).toContainText(frames[0]!.title)
  await flowNode(page, untouchedPrompt.id).getByRole('button', { name: 'Chi tiết', exact: true }).click()
  await expect(page.locator('.canvas-inspector textarea')).toHaveValue(new RegExp(frames[1]!.context))
  await page.locator('.canvas-inspector').getByRole('button', { name: 'Đóng', exact: true }).click()
  await flowNode(page, video.id).getByRole('button', { name: 'Chi tiết', exact: true }).click()
  await expect(page.locator('.canvas-inspector').getByRole('combobox', { name: 'Cảnh Studio', exact: true })).toHaveValue(firstGroup.sceneId!)

  const previewResponse = page.waitForResponse(response => response.url().endsWith(`/nodes/${encodeURIComponent(video.id)}/preview`)
    && response.request().method() === 'POST')
  await flowNode(page, video.id).getByRole('button', { name: 'Xem trước', exact: true }).click()
  const previewHttp = await previewResponse
  expect(previewHttp.status()).toBe(200)
  const { preview } = await previewHttp.json() as { preview: CanvasPreview }
  expect(preview).toMatchObject({ kind: 'video', nodeId: video.id, runnable: true, userText: customText })
  const background = initial.graph.nodes.find(node => node.groupId === firstGroup.id && node.kind === 'upload')!
  expect(preview.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: background.id, sent: true, url: `/api/uploads/${background.data.uploadId}` })]))
  const inspector = page.locator('.canvas-inspector')
  await expect(inspector.locator('pre')).toContainText(customText)
  await expect(inspector.locator('.canvas-input-row:not(.is-skipped)')).not.toHaveCount(0)
  expect((await readCanvas(page, result.project.id)).runs).toHaveLength(0) // Preview must be free of generation side effects.

  const runResponse = page.waitForResponse(response => response.url().endsWith(`/nodes/${encodeURIComponent(video.id)}/run`)
    && response.request().method() === 'POST')
  await inspector.getByRole('button', { name: 'Xác nhận và chạy', exact: true }).click()
  const runHttp = await runResponse
  expect(runHttp.status()).toBe(202)
  const runs = await json<{ runs: CanvasRun[] }>(await page.request.get(`${BASE}/api/projects/${result.project.id}/canvas/runs`))
  expect(runs.runs).toHaveLength(1)
  expect(runs.runs[0]).toMatchObject({ nodeId: video.id, kind: 'video', inputStamp: preview.stamp })
  expect(runs.runs[0]!.generationId).toBeTruthy()
  const generation = await waitForGeneration(page, runs.runs[0]!.generationId!, 45_000)
  expect(generation.status).toBe('succeeded')
  expect(generation.assets.length).toBeGreaterThan(0)
  await expect(flowNode(page, video.id).locator('video.canvas-output-media')).toHaveAttribute('src', generation.assets[0]!.url, { timeout: 20_000 })
})
