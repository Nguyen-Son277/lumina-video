export const DOCS_ARTICLE_IDS = ['getting-started', 'api-models', 'quick-create', 'studio-projects', 'scenes-export', 'characters', 'identity-library', 'script-planner', 'timeline', 'canvas', 'results-library', 'usage', 'trash', 'account-settings', 'admin', 'video-providers', 'troubleshooting', 'privacy-costs'] as const

export function resolveDocsArticle(value: string | null, role?: string): string {
  if (value === 'admin' && role && role !== 'admin') return 'getting-started'
  return DOCS_ARTICLE_IDS.some(id => id === value) ? value! : 'getting-started'
}
