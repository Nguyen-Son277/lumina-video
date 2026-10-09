/// <reference lib="dom" />
/// <reference types="vite/client" />
import { notification, notificationText } from '../../src/i18n/messages'
import { studioCatalog } from '../../src/i18n/catalogs/studio'
import { ERROR_CATALOG } from '../../shared/errorCatalog'
import { describe, expect, it } from 'vitest'
import { interpolate, formatNumber, formatDate, formatBytes, formatDuration, missingTranslations, translate } from '../../src/i18n/translate'
import type { Catalog } from '../../src/i18n/types'

const modules = import.meta.glob('../../src/i18n/catalogs/*.ts', { eager: true }) as Record<string, Record<string, unknown>>
const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort()

describe('Bilingual UI catalogs', () => {
  for (const [path, module] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(module)) {
      if (!value || typeof value !== 'object') continue
      const entries = Object.values(value)
      if (!entries.length || !entries.every(entry => entry && typeof entry === 'object' && 'en' in entry && 'vi' in entry)) continue
      it(`${path} ${name} has matching nonempty translations and placeholders`, () => {
        const catalog = value as Catalog
        expect(missingTranslations(catalog)).toEqual([])
        for (const entry of Object.values(catalog)) {
          expect(placeholders(entry.en)).toEqual(placeholders(entry.vi))
        }
      })
    }
  }

  it('backend error catalog has matching placeholders', () => {
    expect(missingTranslations(ERROR_CATALOG)).toEqual([])
    for (const entry of Object.values(ERROR_CATALOG)) expect(placeholders(entry.en)).toEqual(placeholders(entry.vi))
  })

  it('only explicit app notifications translate; raw content never does', () => {
    expect(notificationText('Đã gửi yêu cầu', 'en')).toBe('Đã gửi yêu cầu')
    const message = notification('studio', 'notifyRequestSent')
    expect(notificationText(message, 'vi')).toBe(studioCatalog.notifyRequestSent.vi)
    expect(notificationText(message, 'en')).toBe(studioCatalog.notifyRequestSent.en)
    expect(translate(studioCatalog, 'imageCountOption', { count: 1 }, 'en')).toBe('1 image')
    expect(translate(studioCatalog, 'imageCountOption', { count: 2 }, 'en')).toBe('2 images')
  })

  it('interpolates user data verbatim without recursive translation', () => {
    expect(interpolate('Hello {name}', { name: 'An {count}' })).toBe('Hello An {count}')
    expect(translate({ greeting: { en: 'Hello {name}', vi: 'Chào {name}' } }, 'greeting', { name: 'Bình' }, 'en')).toBe('Hello Bình')
  })
  it('formats numbers and units according to locale', () => {
    expect(formatNumber(8000, {}, 'en')).toBe('8,000')
    expect(formatNumber(8000, {}, 'vi')).toBe('8.000')
    expect(formatBytes(1536, {}, 'en')).toBe('1.5 KB')
    expect(formatBytes(1536, {}, 'vi')).toBe('1,5 KB')
    expect(formatDuration(65, {}, 'en')).toBe('1:05')
    expect(formatDate('not-a-date', {}, 'vi')).toBe('')
  })
})
