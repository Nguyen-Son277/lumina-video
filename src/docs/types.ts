import type { Locale } from '../i18n/types'
/** Static content must not import TSX: it is also validated by server-side tests. */
export type DocsDestination = 'quick' | 'studio' | 'characters' | 'entities' | 'library' | 'planner' | 'timeline' | 'usage' | 'trash' | 'settings' | 'account-settings' | 'admin-accounts' | 'admin-usage'

export type DocsText = Record<Locale, string>
export type DocsGroup = 'start' | 'create' | 'resources' | 'advanced' | 'manage' | 'support'
export type DocsBlock =
  | { type: 'paragraph'; text: DocsText }
  | { type: 'steps' | 'list'; items: DocsText[] }
  | { type: 'callout'; tone: 'tip' | 'warning' | 'info'; title: DocsText; text: DocsText }
  | { type: 'table'; headers: DocsText[]; rows: DocsText[][] }
  | { type: 'example'; title: DocsText; text: DocsText }
export interface DocsSection { id: string; title: DocsText; blocks: DocsBlock[] }
export interface DocsArticle {
  id: string
  group: DocsGroup
  title: DocsText
  description: DocsText
  keywords: DocsText
  sections: DocsSection[]
  related: string[]
  destination?: DocsDestination
  audience?: 'user' | 'admin'
}
export const bilingual = (en: string, vi: string): DocsText => ({ en, vi })
