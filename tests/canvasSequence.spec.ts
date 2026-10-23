import { expect, test } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'

for (const quick of [false, true]) {
  for (const mobile of [false, true]) {
    test(`${quick ? 'Quick' : 'Studio'} compact cards and video sequence export ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 })
      await signUpFresh(page)
      const provider = await seedProvider(page)
      const modelId = await seedModel(page, provider, { kind: 'video', modelId: 'sora-chain' })
      const created = await page.request.post(`${BASE}/api/${quick ? 'quick-sessions' : 'projects'}`, { data: quick ? { title: 'Chain preview' } : { name: 'Chain preview' } })
      const scopeId = (await created.json())[quick ? 'session' : 'project'].id
      const root = `${BASE}/api/${quick ? 'quick-sessions' : 'projects'}/${scopeId}/canvas`
      const actorResponse = await page.request.post(`${BASE}/api/shared-characters`, { data: { name: 'Long character', appearance: 'Chi tiết nhân vật 👩‍👩‍👧‍👦\n'.repeat(150) } })
      const actor = (await actorResponse.json()).character
      const longText = 'a\u0301👩‍👩‍👧‍👦'.repeat(110)
      const graph = { schemaVersion: 1, nodes: [
        { id: 'v-c', kind: 'video', x: 0, y: 350, data: { modelId } },
        { id: 'v-a', kind: 'video', x: 300, y: 350, data: { modelId } },
        { id: 'v-b', kind: 'video', x: 600, y: 350, data: { modelId } },
        { id: 'v-single', kind: 'video', x: 900, y: 350, data: { modelId } },
        { id: 'long-prompt', kind: 'prompt', x: 0, y: 0, data: { text: longText } },
        { id: 'long-character', kind: 'character', x: 300, y: 0, data: { sourceId: actor.id } },
        { id: 'long-note', kind: 'note', x: 600, y: 0, data: { text: longText } },
      ], edges: [{ id: 'a-b', source: 'v-a', sourcePort: 'video', target: 'v-b', targetPort: 'sequence' }] }
      expect((await page.request.put(root, { data: { baseRevision: 0, graph } })).ok()).toBe(true)
      if (quick) await page.goto(`${BASE}/?page=quick&session=${scopeId}&view=canvas`)
      else {
        await page.goto(`${BASE}/?page=studio`)
        await page.getByRole('button', { name: /Chain preview/ }).click()
        await page.getByRole('tab', { name: 'Canvas' }).click()
      }
      const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"] .canvas-node`)
      const inspector = page.locator('.canvas-inspector')
      await expect(page.locator('.canvas-node textarea, .canvas-node input, .canvas-node select')).toHaveCount(0)
      for (const id of ['long-prompt', 'long-note']) {
        const summary = node(id).getByTestId('canvas-node-description')
        await expect(summary).toHaveText(`${'a\u0301👩‍👩‍👧‍👦'.repeat(79)}a\u0301…`)
        expect(await summary.evaluate(element => element.clientHeight <= Number.parseFloat(getComputedStyle(element).lineHeight) * 3 + 1)).toBe(true)
        await node(id).getByRole('button', { name: 'Chi tiết', exact: true }).click()
        await expect(inspector.locator('textarea')).toHaveValue(longText)
        await inspector.locator('textarea').fill(`${longText} sửa trong panel`)
        await inspector.getByRole('button', { name: 'Đóng', exact: true }).click()
      }
      await node('long-character').getByRole('button', { name: 'Chi tiết', exact: true }).click()
      const full = inspector.locator('.canvas-node-note')
      await expect(full).toHaveText(actor.appearance)
      expect(await full.evaluate(element => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === 'auto')).toBe(true)
      await inspector.getByRole('button', { name: 'Đóng', exact: true }).click()

      await node('v-b').getByRole('button', { name: 'Chi tiết', exact: true }).click()
      await inspector.getByLabel('Video tiếp theo', { exact: true }).selectOption('v-c')
      await expect(page.locator('.canvas-sequence-edge')).toHaveCount(2)
      await expect(node('v-c')).toContainText('Video 3/3')
      await page.getByRole('button', { name: 'Hoàn tác', exact: true }).click()
      await expect(page.locator('.canvas-sequence-edge')).toHaveCount(1)
      await page.getByRole('button', { name: 'Làm lại', exact: true }).click()
      await expect(page.locator('.canvas-sequence-edge')).toHaveCount(2)
      await inspector.getByRole('button', { name: 'Gỡ nối với video trước', exact: true }).click()
      await expect(page.locator('.canvas-sequence-edge')).toHaveCount(1)
      await page.getByRole('button', { name: 'Hoàn tác', exact: true }).click()
      await expect(page.locator('.canvas-sequence-edge')).toHaveCount(2)
      await inspector.getByRole('button', { name: 'Đóng', exact: true }).click()
      await node('v-c').getByRole('button', { name: 'Chi tiết', exact: true }).click()
      await inspector.getByLabel('Video tiếp theo', { exact: true }).selectOption('v-a')
      await expect(page.getByRole('alert')).toContainText('vòng lặp')
      await expect(page.locator('.canvas-sequence-edge')).toHaveCount(2)
      await inspector.getByRole('button', { name: 'Đóng', exact: true }).click()
      await node('v-b').getByRole('button', { name: 'Chi tiết', exact: true }).click()
      await page.locator('.canvas-toolbar').getByRole('button', { name: 'Xuất video', exact: true }).click()
      const modal = page.getByRole('dialog', { name: 'Xuất video', exact: true })
      await expect(modal.getByLabel('Chuỗi video', { exact: true })).toHaveValue('v-a')
      await expect(modal.locator('.project-export-list strong')).toHaveText(['1. v-a', '2. v-b', '3. v-c'])
      await expect(modal.getByRole('button', { name: 'Tạo bản xuất video', exact: true })).toBeDisabled()
      await expect(modal.getByText('Chưa có video thành công', { exact: true })).toHaveCount(3)
      await modal.getByLabel('Chuỗi video', { exact: true }).selectOption('v-single')
      await expect(modal.locator('.project-export-list strong')).toHaveText(['1. v-single'])
      expect((await (await page.request.get(`${root}/exports`)).json()).exports).toHaveLength(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await modal.press('Escape')
      await expect(modal).toHaveCount(0)
      await expect(page.locator('.canvas-save-state')).toHaveText('Đã lưu')
      const saved = (await (await page.request.get(root)).json()).canvas
      expect(saved.graph.edges.filter((edge: { targetPort: string }) => edge.targetPort === 'sequence')).toHaveLength(2)
      expect(saved.graph.nodes.find((entry: { id: string }) => entry.id === 'long-note').data.text).toBe(`${longText} sửa trong panel`)
      await page.reload()
      if (!quick) {
        await page.getByRole('button', { name: /Chain preview/ }).click()
        await page.getByRole('tab', { name: 'Canvas' }).click()
      }
      await expect(page.locator('.canvas-sequence-edge')).toHaveCount(2)
      await expect(node('v-a')).toContainText('Bắt đầu')
      await expect(node('v-c')).toContainText('Kết thúc')
    })
  }
}
