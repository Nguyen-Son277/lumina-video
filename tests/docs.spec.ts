import { expect, test, type Page } from '@playwright/test'
import { docsArticles } from '../src/docs/content/index'
import type { DocsArticle } from '../src/docs/types'
import { BASE, ensureAdminSession, signUpFresh } from './helpers/auth'

// The existing Playwright config starts isolated mockServer + Vite processes.
// No providers/models are seeded and these tests never submit generation requests.
test.use({ storageState: { cookies: [], origins: [] } })

function article(id: string): DocsArticle {
  const result = docsArticles.find(item => item.id === id)
  if (!result) throw new Error(`Missing documentation article: ${id}`)
  return result
}
const localeSelect = (page: Page) => page.getByRole('combobox', { name: /Language|Ngôn ngữ/ })
const guideNavigation = (page: Page) => page.getByRole('navigation', { name: /Browse guides|Khám phá hướng dẫn/ })
const articleHeading = (page: Page, id: string, locale: 'en' | 'vi' = 'en') =>
  page.getByRole('article').getByRole('heading', { level: 2, name: article(id).title[locale], exact: true })

async function openArticle(page: Page, id: string): Promise<void> {
  await page.goto(`${BASE}/?page=docs&article=${id}`)
  await expect(articleHeading(page, id)).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1)
}

test.describe('Lumina Docs — regular user', () => {
  test.beforeEach(async ({ page }) => {
    await signUpFresh(page)
  })

  test('direct article URLs render bilingual content and retain locale after reload', async ({ page }) => {
    await openArticle(page, 'account-settings')
    await expect(page.getByRole('article')).toContainText(article('account-settings').description.en)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: 'shots/docs-desktop-en.png' })
    await localeSelect(page).selectOption('vi')
    await expect(articleHeading(page, 'account-settings', 'vi')).toBeVisible()
    await expect(page.getByRole('article')).toContainText(article('account-settings').description.vi)
    await expect(page).toHaveURL(/page=docs.*article=account-settings/)
    await page.reload()
    await expect(articleHeading(page, 'account-settings', 'vi')).toBeVisible()
    await expect(localeSelect(page)).toHaveValue('vi')
    await localeSelect(page).selectOption('en')
    await expect(articleHeading(page, 'account-settings')).toBeVisible()
  })

  test('local search supports accent-free Vietnamese, selection, and an empty result state', async ({ page }) => {
    await openArticle(page, 'getting-started')
    await localeSelect(page).selectOption('vi')
    const search = page.getByRole('searchbox')
    await expect(search).toHaveAccessibleName(/.+/)
    await search.fill('mat khau')
    await guideNavigation(page).getByRole('button', { name: article('account-settings').title.vi, exact: true }).click()
    await expect(articleHeading(page, 'account-settings', 'vi')).toBeVisible()
    await expect(page).toHaveURL(/article=account-settings/)
    await search.fill('unfindable_zqxv_987654321')
    await expect(guideNavigation(page).getByRole('button')).toHaveCount(0)
    await expect(guideNavigation(page).getByRole('status')).toBeVisible()
    await expect(guideNavigation(page).getByRole('status')).not.toBeEmpty()
    // A failed search must not discard the currently open guide.
    await expect(articleHeading(page, 'account-settings', 'vi')).toBeVisible()
    await search.fill('')
    await expect(guideNavigation(page).getByRole('button', { name: article('getting-started').title.vi, exact: true })).toBeVisible()
  })

  test('sidebar Help/Docs entry opens docs and article selection supports reload, back and forward', async ({ page }) => {
    await page.goto(`${BASE}/?page=studio`)
    await page.locator('.sidebar').getByRole('button', { name: /Docs|Hướng dẫn/, exact: true }).click()
    await expect(articleHeading(page, 'getting-started')).toBeVisible()
    await guideNavigation(page).getByRole('button', { name: article('quick-create').title.en, exact: true }).click()
    await expect(articleHeading(page, 'quick-create')).toBeVisible()
    await guideNavigation(page).getByRole('button', { name: article('privacy-costs').title.en, exact: true }).click()
    await expect(articleHeading(page, 'privacy-costs')).toBeVisible()
    await page.reload()
    await expect(articleHeading(page, 'privacy-costs')).toBeVisible()
    await page.goBack()
    await expect(articleHeading(page, 'quick-create')).toBeVisible()
    await expect(page).toHaveURL(/article=quick-create/)
    await page.goForward()
    await expect(articleHeading(page, 'privacy-costs')).toBeVisible()
    await expect(page).toHaveURL(/article=privacy-costs/)
  })

  test('Help opens Docs and section deep links survive reload and clipboard denial', async ({ page }) => {
    await page.goto(`${BASE}/?page=studio`)
    await page.locator('.topbar').getByRole('button', { name: 'Help', exact: true }).click()
    await expect(articleHeading(page, 'getting-started')).toBeVisible()
    const firstSection = article('getting-started').sections[0]
    await page.locator('.docs-toc').getByRole('link', { name: firstSection.title.en, exact: false }).click()
    await expect(page).toHaveURL(new RegExp(`#${firstSection.id}$`))
    await page.reload()
    await expect(page).toHaveURL(new RegExp(`#${firstSection.id}$`))
    await expect(page.locator(`[id="${firstSection.id}"]`)).toBeInViewport()
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }))
    await page.getByRole('button', { name: 'Copy link', exact: true }).click()
    await expect(page.locator('.docs-copy-status input')).toHaveValue(new RegExp(`#${firstSection.id}$`))
    await guideNavigation(page).getByRole('button', { name: article('quick-create').title.en, exact: true }).click()
    await expect(page).not.toHaveURL(/#/) 
    await page.goBack()
    await expect(articleHeading(page, 'getting-started')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`#${firstSection.id}$`))
    await page.getByRole('button', { name: 'Open in Lumina', exact: true }).click()
    await expect(page).toHaveURL(/page=quick/)
  })

  test('Help respects a dirty Canvas save guard instead of discarding edits', async ({ page }) => {
    const created = await page.request.post(`${BASE}/api/quick-sessions`, { data: { title: 'Docs guard', promptDocument: { version: 1, text: 'Initial idea', mentions: [] } } })
    const id = (await created.json()).session.id
    await page.request.post(`${BASE}/api/quick-sessions/${id}/canvas/sync`, { data: { baseRevision: 0 } })
    await page.goto(`${BASE}/?page=quick&session=${id}&view=canvas`)
    await page.locator('.canvas-node.kind-prompt header').click()
    const prompt = page.locator('.canvas-inspector textarea')
    await expect(prompt).toHaveValue('Initial idea')
    const route = `**/api/quick-sessions/${id}/canvas`
    await page.route(route, async request => {
      if (request.request().method() === 'PUT') await request.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'SAVE_TEST_FAILURE' }) })
      else await request.continue()
    })
    await prompt.fill('Keep this unsaved draft')
    await page.locator('.topbar').getByRole('button', { name: 'Help', exact: true }).click()
    await expect(page).toHaveURL(/page=quick/)
    await expect(page.locator('.canvas-save-state')).toHaveText(/Could not save|Save failed|Không lưu/)
    await expect(prompt).toHaveValue('Keep this unsaved draft')
    await page.unroute(route)
    await page.locator('.topbar').getByRole('button', { name: 'Help', exact: true }).click()
    await expect(articleHeading(page, 'getting-started')).toBeVisible()
    const saved = await page.request.get(`${BASE}/api/quick-sessions/${id}/canvas`)
    expect(JSON.stringify((await saved.json()).canvas.graph)).toContain('Keep this unsaved draft')
  })

  test('unknown and admin-only article URLs safely fall back for regular users', async ({ page }) => {
    for (const id of ['unknown-documentation-article', 'admin']) {
      await page.goto(`${BASE}/?page=docs&article=${id}`)
      await expect(articleHeading(page, 'getting-started')).toBeVisible()
      await expect(guideNavigation(page).getByRole('button', { name: article('admin').title.en, exact: true })).toHaveCount(0)
      await expect(page).toHaveURL(/article=getting-started/)
    }
  })

  test('390px layout keeps rich guides, search and mobile navigation within the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openArticle(page, 'api-models')
    await expectNoHorizontalOverflow(page)
    await localeSelect(page).selectOption('vi')
    await expect(articleHeading(page, 'api-models', 'vi')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: 'shots/docs-mobile-vi.png' })
    await page.getByRole('searchbox').fill('mat khau')
    // Summary has native disclosure semantics; Chromium does not expose it as a button in every version.
    await page.locator('.docs-mobile-nav > summary').click()
    await guideNavigation(page).getByRole('button', { name: article('account-settings').title.vi, exact: true }).click()
    await expect(articleHeading(page, 'account-settings', 'vi')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await page.getByRole('searchbox').fill('')
    await page.locator('.docs-mobile-nav > summary').click()
    await guideNavigation(page).getByRole('button', { name: article('privacy-costs').title.vi, exact: true }).click()
    await expect(articleHeading(page, 'privacy-costs', 'vi')).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })
})

test.describe('Lumina Docs — administrator', () => {
  test('admin article is available without exposing creation destinations', async ({ page }) => {
    await ensureAdminSession(page)
    await openArticle(page, 'admin')
    await expect(guideNavigation(page).getByRole('button', { name: article('admin').title.en, exact: true })).toBeVisible()
    await localeSelect(page).selectOption('vi')
    await expect(articleHeading(page, 'admin', 'vi')).toBeVisible()
    await page.reload()
    await expect(articleHeading(page, 'admin', 'vi')).toBeVisible()
    await page.goto(`${BASE}/?page=docs&article=quick-create`)
    await expect(articleHeading(page, 'quick-create', 'vi')).toBeVisible()
    await expect(page.getByRole('article').getByRole('button', { name: /Open in Lumina|Mở trong Lumina/ })).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })
})
