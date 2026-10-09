import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { transformSync } = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }))
const { parse } = require(require.resolve('espree', { paths: [require.resolve('eslint')] }))
import fs from 'node:fs'
import path from 'node:path'

const roots = ['src/pages', 'src/components']
const allowedStatic = new Set(['lumina', '.', 'VIDEO', 'IMAGE', 'BETA', 'API', 'Studio', 'Timeline', 'vi', '/images/edits', 'https://api.example.com/v1', 'sk-••••••••••••••••'])
const hasWords = /[A-Za-zÀ-ỹ]{2,}/u
const findings = []
function inspect(file) {
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'tsx', jsx: 'preserve', target: 'esnext' }).code
  const source = parse(code, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true })
  function visit(node) {
    if (!node || typeof node !== 'object') return
    const visibleAttribute = node.type === 'JSXAttribute' && ['title', 'aria-label', 'alt', 'placeholder'].includes(node.name?.name)
    const text = node.type === 'JSXText' ? node.value.trim() : visibleAttribute && node.value?.type === 'Literal' ? node.value.value : ''
    if (text && hasWords.test(text) && !allowedStatic.has(text)) findings.push(`${file} (compiled line ${node.loc.start.line}): ${text}`)
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'range') continue
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(source)
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (file.endsWith('.tsx')) inspect(file)
  }
}
roots.forEach(walk)
if (findings.length) {
  console.error('Unlocalized static UI copy:\n' + findings.join('\n'))
  process.exitCode = 1
} else console.log('No untranslated static JSX text or UI attributes found.')
