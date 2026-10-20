import { startArticles } from './start'
import { quickArticles } from './quick'
import { projectArticles } from './projects'
import { resourceArticles } from './resources'
import { plannerArticles } from './planner'
import { canvasArticles } from './canvas'
import { manageArticles } from './manage'
import { supportArticles } from './support'
import type { DocsArticle } from '../types'

const relatedArticles: Record<string, string[]> = {
  'getting-started': ['api-models', 'quick-create', 'studio-projects'],
  'api-models': ['quick-create', 'video-providers', 'usage'],
  'quick-create': ['canvas', 'identity-library', 'video-providers'],
  'studio-projects': ['scenes-export', 'characters', 'canvas'],
  'scenes-export': ['video-providers', 'timeline', 'troubleshooting'],
  characters: ['identity-library', 'studio-projects', 'script-planner'],
  'identity-library': ['characters', 'quick-create', 'canvas'],
  'script-planner': ['timeline', 'characters', 'api-models'],
  timeline: ['script-planner', 'canvas', 'scenes-export'],
  canvas: ['quick-create', 'timeline', 'video-providers'],
  'results-library': ['quick-create', 'trash', 'troubleshooting'],
  usage: ['api-models', 'privacy-costs', 'troubleshooting'],
  trash: ['results-library', 'characters', 'studio-projects'],
  'account-settings': ['getting-started', 'privacy-costs'],
  admin: ['account-settings', 'privacy-costs'],
  'video-providers': ['api-models', 'quick-create', 'scenes-export'],
  troubleshooting: ['api-models', 'video-providers', 'privacy-costs'],
  'privacy-costs': ['usage', 'video-providers', 'account-settings'],
}

const articles: DocsArticle[] = [
  ...startArticles, ...quickArticles, ...projectArticles, ...resourceArticles,
  ...plannerArticles, ...canvasArticles, ...manageArticles, ...supportArticles,
]

export const docsArticles: DocsArticle[] = articles.map(article => ({
  ...article,
  related: relatedArticles[article.id] ?? article.related,
}))
