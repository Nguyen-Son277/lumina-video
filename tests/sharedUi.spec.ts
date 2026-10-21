import { expect, test, type Page } from '@playwright/test'
import { BASE } from './helpers/auth'

// Real production components and CSS, mounted with the same Vite/React instance
// as the application. No test renderer, DOM dependency, or screenshots needed.
async function prepareFixture(page: Page) {
  await page.route('**/__shared-ui-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head></head><body><div id="shared-ui-fixture"></div></body></html>',
  }))
  await page.goto(`${BASE}/__shared-ui-fixture`)
  await page.evaluate(async () => {
    const load = (path: string) => import(path)
    const refresh = await load('/@react-refresh')
    refresh.default.injectIntoGlobalHook(window)
    const w = window as any
    w.$RefreshReg$ = () => {}; w.$RefreshSig$ = () => (type: unknown) => type
    w.__vite_plugin_react_preamble_installed__ = true
    const [buttonSource, entrySource] = await Promise.all([
      fetch('/src/components/ui/Button.tsx').then(response => response.text()),
      fetch('/src/main.tsx').then(response => response.text()),
    ])
    // Resolve Vite's actual optimized import URLs; hard-coded ?v= hashes or a
    // bare React URL would create a second React instance and invalid hooks.
    const reactUrl = buttonSource.match(/["']([^"']*\/react\.js\?[^"']+)["']/)?.[1]
    const domUrl = entrySource.match(/["']([^"']*\/react-dom_client\.js\?[^"']+)["']/)?.[1]
    if (!reactUrl || !domUrl) throw new Error('Cannot resolve production React dependencies')
    const [React, ReactDOM] = await Promise.all([load(reactUrl), load(domUrl)])
    for (const path of ['/src/styles/tokens.css', '/src/styles/ui.css', '/src/styles.css']) {
      await new Promise<void>((resolve, reject) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'; link.href = `${path}?direct`
        link.onload = () => resolve(); link.onerror = () => reject(new Error(`Cannot load ${path}`))
        document.head.appendChild(link)
      })
    }
    w.sharedReact = React.default ?? React
    w.sharedUi = await load('/src/components/ui/index.ts')
    w.sharedRoot = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(document.getElementById('shared-ui-fixture'))
  })
}

test('Button forwards native props/ref and is a non-submitting button by default', async ({ page }) => {
  await prepareFixture(page)
  await page.evaluate(() => {
    const w = window as any, h = w.sharedReact.createElement, { Button } = w.sharedUi
    w.sharedClicks = 0; w.sharedSubmits = 0; w.sharedDisabledClicks = 0
    w.sharedRoot.render(h('form', { onSubmit: (event: Event) => { event.preventDefault(); w.sharedSubmits++ } },
      h(Button, {
        id: 'default-button', ref: (node: HTMLButtonElement | null) => { w.sharedButtonRef = node },
        className: 'secondary-button fixture-native-class', name: 'native-action', value: 'native-value',
        title: 'Native title', 'aria-label': 'Native action', 'aria-describedby': 'button-hint',
        'aria-pressed': false, 'data-native': 'forwarded', onClick: () => { w.sharedClicks++ },
      }, 'Default action'),
      h('span', { id: 'button-hint' }, 'Native button hint'),
      h(Button, { id: 'disabled-button', disabled: true, 'data-native': 'disabled', onClick: () => { w.sharedDisabledClicks++ } }, 'Disabled action'),
      h(Button, { id: 'submit-button', type: 'submit' }, 'Explicit submit'),
    ))
  })
  const button = page.getByRole('button', { name: 'Native action', exact: true })
  await expect(button).toHaveAttribute('type', 'button')
  await expect(button).toHaveAttribute('name', 'native-action')
  await expect(button).toHaveAttribute('value', 'native-value')
  await expect(button).toHaveAttribute('title', 'Native title')
  await expect(button).toHaveAttribute('aria-describedby', 'button-hint')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(button).toHaveAttribute('data-native', 'forwarded')
  await expect(button).toHaveClass(/fixture-native-class/)
  expect(await page.evaluate(() => {
    const node = (window as any).sharedButtonRef
    return node instanceof HTMLButtonElement && node === document.getElementById('default-button')
  })).toBe(true)
  await page.evaluate(() => (window as any).sharedButtonRef.focus())
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => ({ clicks: (window as any).sharedClicks, submits: (window as any).sharedSubmits }))).toEqual({ clicks: 1, submits: 0 })
  await button.click()
  expect(await page.evaluate(() => ({ clicks: (window as any).sharedClicks, submits: (window as any).sharedSubmits }))).toEqual({ clicks: 2, submits: 0 })
  const disabled = page.locator('#disabled-button')
  await expect(disabled).toBeDisabled()
  await expect(disabled).toHaveAttribute('data-native', 'disabled')
  await disabled.evaluate(element => (element as HTMLButtonElement).click())
  expect(await page.evaluate(() => ({ clicks: (window as any).sharedDisabledClicks, submits: (window as any).sharedSubmits }))).toEqual({ clicks: 0, submits: 0 })
  await page.locator('#submit-button').click()
  expect(await page.evaluate(() => (window as any).sharedSubmits)).toBe(1)
})

test('Field and SelectControl retain native label association, select attributes and refs', async ({ page }) => {
  await prepareFixture(page)
  await page.evaluate(() => {
    const w = window as any, R = w.sharedReact, h = R.createElement, { Field, SelectControl } = w.sharedUi
    function Fixture() {
      const [value, setValue] = R.useState('one')
      return h(R.Fragment, null,
        h(Field, { label: 'Native field label', ref: (node: HTMLLabelElement | null) => { w.sharedFieldRef = node }, 'data-native': 'field-label' },
          h('input', { id: 'native-field', name: 'native-field', defaultValue: 'Initial text' })),
        h(SelectControl, {
          id: 'native-select', name: 'native-select', label: 'Native select label', value, required: true,
          ref: (node: HTMLSelectElement | null) => { w.sharedSelectRef = node },
          'aria-describedby': 'select-hint', 'data-native': 'select-control',
          options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }, { value: 'blocked', label: 'Unavailable', disabled: true }],
          onChange: (next: string, event: Event) => { w.sharedSelectChange = { value: next, native: event.target instanceof HTMLSelectElement }; setValue(next) },
        }),
        h('span', { id: 'select-hint' }, 'Native select hint'),
      )
    }
    w.sharedRoot.render(h(Fixture))
  })
  const field = page.getByLabel('Native field label', { exact: true })
  await expect(field).toHaveValue('Initial text')
  await page.locator('label[data-native="field-label"] > span').click()
  await expect(field).toBeFocused()
  await field.fill('Edited through native label')
  const select = page.getByRole('combobox', { name: 'Native select label', exact: true })
  await expect(select).toHaveAttribute('name', 'native-select')
  await expect(select).toHaveAttribute('required', '')
  await expect(select).toHaveAttribute('aria-describedby', 'select-hint')
  await expect(select).toHaveAttribute('data-native', 'select-control')
  // Check the native option contract directly: the Playwright enabled-state
  // matcher can classify an <option disabled> as enabled in this Chrome build.
  const blockedOption = select.locator('option[value="blocked"]')
  await expect(blockedOption).toHaveAttribute('disabled', '')
  await expect(blockedOption).toHaveJSProperty('disabled', true)
  expect(await page.evaluate(() => {
    const w = window as any, field = document.getElementById('native-field') as HTMLInputElement
    const select = document.getElementById('native-select') as HTMLSelectElement
    return {
      fieldRef: w.sharedFieldRef instanceof HTMLLabelElement && field.labels?.[0] === w.sharedFieldRef,
      selectRef: w.sharedSelectRef instanceof HTMLSelectElement && w.sharedSelectRef === select,
      nativeSelectLabel: !!select.labels?.length,
    }
  })).toEqual({ fieldRef: true, selectRef: true, nativeSelectLabel: true })
  await page.evaluate(() => (window as any).sharedSelectRef.focus())
  await expect(select).toBeFocused()
  await select.selectOption('two')
  await expect(select).toHaveValue('two')
  expect(await page.evaluate(() => (window as any).sharedSelectChange)).toEqual({ value: 'two', native: true })
})

async function mountDialog(page: Page, nested = false) {
  await page.evaluate(({ nested }) => {
    const w = window as any, R = w.sharedReact, h = R.createElement, { DialogFrame, CloseButton } = w.sharedUi
    w.sharedCloseCalls = 0; w.sharedInnerCloseCalls = 0
    function Fixture() {
      const [open, setOpen] = R.useState(false), [busy, setBusy] = R.useState(false), [inner, setInner] = R.useState(false)
      w.setSharedDialogBusy = setBusy
      const onClose = () => { w.sharedCloseCalls++; setOpen(false) }
      const closeInner = () => { w.sharedInnerCloseCalls++; setInner(false) }
      return h(R.Fragment, null,
        h('button', { id: 'dialog-opener', type: 'button', onClick: () => setOpen(true) }, 'Open shared dialog'),
        open && h(DialogFrame, {
          onClose, closeDisabled: busy, 'aria-labelledby': 'shared-dialog-title', 'aria-describedby': 'shared-dialog-description',
          'data-testid': 'shared-dialog', backdropProps: { 'data-testid': 'shared-backdrop' },
        },
          h('h2', { id: 'shared-dialog-title' }, 'Shared dialog title'),
          h('p', { id: 'shared-dialog-description' }, 'Shared dialog description'),
          h(CloseButton, { label: 'Close shared dialog', disabled: busy, onClick: onClose }),
          h('input', { id: 'dialog-first', 'aria-label': 'First dialog field', 'data-modal-initial-focus': true }),
          h('button', { type: 'button', hidden: true }, 'Hidden control'),
          h('button', { type: 'button', disabled: true }, 'Disabled control'),
          h('input', { type: 'hidden', value: 'not-tabbable', readOnly: true }),
          nested && h('button', { id: 'nested-opener', type: 'button', onClick: () => setInner(true) }, 'Open nested dialog'),
          h('details', null, h('summary', { id: 'dialog-last-summary' }, 'Native summary control'), h('p', null, 'Details content')),
          inner && h(DialogFrame, {
            onClose: closeInner, 'aria-label': 'Nested shared dialog', 'data-testid': 'nested-dialog',
          }, h('button', { id: 'nested-first', type: 'button', 'data-modal-initial-focus': true }, 'Nested first control'),
          h('details', null, h('summary', { id: 'nested-last-summary' }, 'Nested summary control'))),
        ),
      )
    }
    w.sharedRoot.render(h(Fixture))
  }, { nested })
  await page.locator('#dialog-opener').click()
  return page.getByTestId('shared-dialog')
}

test('DialogFrame traps native summary focus, blocks busy dismissal and restores its opener', async ({ page }) => {
  await prepareFixture(page)
  const dialog = await mountDialog(page)
  await expect(dialog).toHaveAttribute('role', 'dialog')
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog).toHaveAccessibleName('Shared dialog title')
  await expect(dialog).toHaveAccessibleDescription('Shared dialog description')
  await expect(page.locator('#dialog-first')).toBeFocused()
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')
  const close = dialog.getByRole('button', { name: 'Close shared dialog', exact: true })
  await expect(close).toHaveAttribute('type', 'button')
  await expect(close.locator('svg')).toHaveAttribute('aria-hidden', 'true')
  await page.locator('#dialog-last-summary').focus()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('#dialog-last-summary')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog.locator('details')).toHaveAttribute('open', '')
  await page.evaluate(() => (window as any).setSharedDialogBusy(true))
  await expect(close).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.getByTestId('shared-backdrop').click({ position: { x: 2, y: 2 } })
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => (window as any).sharedCloseCalls)).toBe(0)
  await page.evaluate(() => (window as any).setSharedDialogBusy(false))
  await expect(close).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).sharedCloseCalls)).toBe(1)
  await expect(page.locator('#dialog-opener')).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
})

test('DialogFrame yields keyboard focus and Escape to a native modal above its shared layer', async ({ page }) => {
  await prepareFixture(page)
  const outer = await mountDialog(page)
  await expect(page.locator('#dialog-first')).toBeFocused()
  await page.evaluate(() => {
    const w = window as any
    w.sharedNativeCancelCalls = 0; w.sharedNativeCloseCalls = 0
    const dialog = document.createElement('dialog')
    dialog.id = 'native-modal'
    dialog.setAttribute('aria-label', 'Native modal above shared layer')
    for (const [index, text] of ['Native first control', 'Native second control'].entries()) {
      const button = document.createElement('button')
      button.type = 'button'; button.id = `native-control-${index}`; button.textContent = text
      if (index === 0) button.autofocus = true
      dialog.appendChild(button)
    }
    dialog.addEventListener('cancel', () => { w.sharedNativeCancelCalls++ })
    dialog.addEventListener('close', () => { w.sharedNativeCloseCalls++ })
    // Native modal is intentionally outside the shared panel, as an async quick
    // preview may open after the mobile Sidebar already owns a shared layer.
    document.body.appendChild(dialog)
    dialog.showModal()
  })
  const native = page.getByRole('dialog', { name: 'Native modal above shared layer', exact: true })
  const first = native.getByRole('button', { name: 'Native first control', exact: true })
  const second = native.getByRole('button', { name: 'Native second control', exact: true })
  await expect(native).toBeVisible()
  await expect(first).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(second).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(first).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#native-modal')).not.toHaveAttribute('open', '')
  await expect.poll(() => page.evaluate(() => ({ cancel: (window as any).sharedNativeCancelCalls, close: (window as any).sharedNativeCloseCalls }))).toEqual({ cancel: 1, close: 1 })
  await expect(outer).toBeVisible()
  expect(await page.evaluate(() => (window as any).sharedCloseCalls)).toBe(0)
  await expect(page.locator('#dialog-first')).toBeFocused()
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')
  await page.keyboard.press('Escape')
  await expect(outer).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).sharedCloseCalls)).toBe(1)
  await expect(page.locator('#dialog-opener')).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
})

test('nested DialogFrame only dismisses the top dialog and restores focus in order', async ({ page }) => {
  await prepareFixture(page)
  const outer = await mountDialog(page, true)
  await page.locator('#nested-opener').click()
  const inner = page.getByTestId('nested-dialog')
  await expect(inner).toBeVisible()
  await expect(page.locator('#nested-first')).toBeFocused()
  await page.locator('#nested-last-summary').focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('#nested-first')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(inner).toHaveCount(0)
  await expect(outer).toBeVisible()
  expect(await page.evaluate(() => ({ outer: (window as any).sharedCloseCalls, inner: (window as any).sharedInnerCloseCalls }))).toEqual({ outer: 0, inner: 1 })
  await expect(page.locator('#nested-opener')).toBeFocused()
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')
  await page.keyboard.press('Escape')
  await expect(outer).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).sharedCloseCalls)).toBe(1)
  await expect(page.locator('#dialog-opener')).toBeFocused()
})
