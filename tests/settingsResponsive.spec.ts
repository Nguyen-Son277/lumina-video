import { expect, test, type Locator } from '@playwright/test'
import { BASE, seedModel, seedProvider, signUpFresh } from './helpers/auth'
import { shellCatalog as S } from '../src/i18n/catalogs/shell'
import { providerKeysCatalog as K } from '../src/i18n/catalogs/providerKeys'

// Geometry checks catch clipped controls even when the application shell hides overflow.
async function expectContained(root: Locator) {
  const errors = await root.evaluate(element => {
    const failures: string[] = []
    const nodes = [element, ...element.querySelectorAll('button, input, select, .provider-summary, .provider-controls, .provider-actions, .model-header, .model-image-settings, .model-details, .model-price-editor, .provider-credentials-panel, .credential-row')]
    for (const node of nodes) {
      const rect = node.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      const container = node === element ? null : node.closest('.provider-item, .model-row, [role="dialog"]')
      const parentRect = container?.getBoundingClientRect()
      if (rect.left < -1 || rect.right > window.innerWidth + 1 || (parentRect && (rect.left < parentRect.left - 1 || rect.right > parentRect.right + 1))) {
        failures.push(`${node.tagName}.${node.className}: ${rect.left}..${rect.right}`)
      }
      if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLSelectElement) && node.scrollWidth > node.clientWidth + 1) {
        failures.push(`${node.tagName}.${node.className}: scroll ${node.scrollWidth}/${node.clientWidth}`)
      }
    }
    return failures
  })
  expect(errors).toEqual([])
}

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`API & Models stays usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await signUpFresh(page)
    const name = `Provider-${'long-name-'.repeat(7)}`
    const provider = await seedProvider(page, { name, baseUrl: `https://e2e.mock.test/${'long-path-'.repeat(8)}/v1` })
    for (const kind of ['image', 'video', 'llm', 'unclassified'] as const) {
      await seedModel(page, provider, { kind, displayName: `${kind}-${'long-model-name-'.repeat(5)}`, modelId: `${kind}-${'long-model-id-'.repeat(6)}` })
    }
    const credential = await page.request.post(`${BASE}/api/providers/${provider}/credentials`, {
      data: { apiKey: 'sk-responsive-test', label: 'Long-key-label-'.repeat(5) },
    })
    expect(credential.ok()).toBe(true)
    await page.goto(`${BASE}/?page=settings`)
    const settings = page.locator('.settings-page')
    await expect(settings.locator('.provider-row')).toBeVisible()
    await expectContained(settings)
    await settings.locator('.keys-toggle').click()
    await expect(settings.locator('.credential-row')).toHaveCount(2)
    await expectContained(settings)
    if ([390, 768, 1440].includes(width)) {
      await page.screenshot({ path: `artifacts/settings-providers-${width}.png`, fullPage: true })
    }

    await settings.locator('.credentials-toolbar').getByRole('button', { name: K.addKey.vi }).click()
    const keyDialog = page.getByRole('dialog', { name: K.addKeyTitle.vi })
    await expect(keyDialog).toBeVisible()
    await expectContained(keyDialog)
    await page.keyboard.press('Escape')
    await settings.locator('.provider-actions button').nth(1).click()
    const editDialog = page.getByRole('dialog', { name: K.editProviderTitle.vi })
    await expect(editDialog).toBeVisible()
    await expectContained(editDialog)
    await page.keyboard.press('Escape')

    await settings.getByRole('button', { name: S.addProvider.vi, exact: true }).click()
    const providerDialog = page.getByRole('dialog', { name: S.addProvider.vi, exact: true })
    await expectContained(providerDialog)
    await page.keyboard.press('Escape')
    await settings.getByRole('button', { name: S.addModel.vi, exact: true }).click()
    const modelDialog = page.getByRole('dialog', { name: S.addModel.vi, exact: true })
    await expectContained(modelDialog)
    await page.keyboard.press('Escape')
    if (width === 320) {
      await page.setViewportSize({ width, height: 480 })
      await settings.getByRole('button', { name: S.addProvider.vi, exact: true }).click()
      await expectContained(providerDialog)
      const save = providerDialog.getByRole('button', { name: S.saveProvider.vi, exact: true })
      await save.scrollIntoViewIfNeeded()
      await expect(save).toBeInViewport()
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width, height: 900 })
    }

    await settings.getByRole('button', { name: /Model catalog/ }).click()
    await expect(settings.locator('.model-row')).toHaveCount(4)
    await expectContained(settings)
    const image = settings.locator('.model-row').filter({ has: page.locator('.model-image-settings') })
    await image.locator('.model-price-toggle').click()
    await expect(image.locator('.model-price-editor')).toBeVisible()
    await expectContained(settings)
    await image.locator('.model-image-size input').first().fill('1024x1024')
    const update = page.waitForResponse(response => response.url().includes('/api/models/') && response.request().method() === 'PATCH')
    await image.locator('.model-image-size input').first().press('Tab')
    expect((await update).ok()).toBe(true)
    await image.locator('.model-price-field input').first().fill('0.12')
    await image.getByRole('button', { name: S.modelPriceSave.vi, exact: true }).click()
    await expect(image.locator('.model-price-status')).toContainText(S.modelPriceSaved.vi)
    const llm = settings.locator('.model-row').filter({ hasText: 'llm-long-model-name' })
    await llm.locator('.model-price-toggle').click()
    await expect(llm.locator('.model-price-editor')).toBeVisible()
    await expectContained(settings)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    if ([390, 768, 1440].includes(width)) {
      await page.screenshot({ path: `artifacts/settings-models-${width}.png`, fullPage: true })
    }
  })
}
