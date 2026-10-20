import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FocusEventHandler } from 'react'
import {
  findUnresolvedPromptMentions,
  insertPromptMention,
  parsePromptMentions,
  updatePromptDocument,
  validatePromptDocument,
  type EntityRef,
  type PromptDocument,
} from '../../shared/promptMentions'
import { errorMessage } from '../api/client'
import { entityLibraryApi, entityReferenceUrl, type EntityLibraryEntity } from '../api/entityLibrary'
import { useTranslation } from '../i18n'
import { entityLibraryCatalog } from '../i18n/catalogs/entityLibrary'
import '../styles/entity-mentions.css'

export interface EntityMentionTextareaProps {
  document: PromptDocument
  onChange: (document: PromptDocument) => void
  projectId?: string
  placeholder?: string
  disabled?: boolean
  rows?: number
  /** Applied to the textarea itself, so existing textarea styling is retained. */
  className?: string
  maxLength?: number
  id?: string
  name?: string
  'aria-label'?: string
  onBlur?: FocusEventHandler<HTMLTextAreaElement>
}

// The catalog is fetched only for suggestions/existence checks. Display names never
// resolve a raw @handle, and reference filesystem paths are never used as URLs.
type CatalogEntity = EntityLibraryEntity
interface MentionQuery { start: number; end: number; query: string; prefix: '@' | '#' }

function queryAtCaret(text: string, start: number, end: number): MentionQuery | null {
  if (start !== end) return null
  const token = parsePromptMentions(text).find(mention => mention.start < start && start <= mention.end)
  if (token) return { start: token.start, end: token.end, query: text.slice(token.start + 1, start), prefix: text[token.start] as '@' | '#' }
  // Probe a valid token to reuse shared escape/boundary rules, including bare
  // triggers and hex-shaped handles that remain literal unless explicitly bound.
  let at = start - 1
  while (at >= 0 && /[\p{L}\p{N}\p{M}_-]/u.test(text[at]!)) at--
  const prefix = text[at]
  if (prefix !== '@' && prefix !== '#') return null
  const probe = `${text.slice(0, at)}${prefix}identity `
  if (!parsePromptMentions(probe).some(mention => mention.start === at)) return null
  let tokenEnd = start
  while (tokenEnd < text.length && /[\p{L}\p{N}\p{M}_-]/u.test(text[tokenEnd]!)) tokenEnd++
  return { start: at, end: tokenEnd, query: text.slice(at + 1, start), prefix }
}

function normalizedSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase()
}

function entityKey(entity: EntityRef): string { return `${entity.kind}:${entity.id}` }

function referenceUrl(entity: CatalogEntity): string | undefined {
  return entityReferenceUrl(entity) ?? undefined
}

/** Plain controlled textarea with explicit, persistent kind+ID mention bindings. */
export function EntityMentionTextarea({
  document,
  onChange,
  projectId,
  placeholder,
  disabled,
  rows = 4,
  className,
  maxLength,
  id,
  name,
  'aria-label': ariaLabel,
  onBlur,
}: EntityMentionTextareaProps) {
  const { t } = useTranslation(entityLibraryCatalog)
  const instanceId = useId()
  const listId = `${instanceId}-suggestions`
  const helpId = `${instanceId}-help`
  const warningId = `${instanceId}-warning`
  const errorId = `${instanceId}-error`
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const [focusRequest, setFocusRequest] = useState(0)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const [catalog, setCatalog] = useState<{ projectId?: string; entities: CatalogEntity[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [insertionError, setInsertionError] = useState(false)
  const composing = useRef(false)

  useEffect(() => {
    if (focusRequest === 0) return
    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    setLoadError('')
    setCatalog(null)
    void entityLibraryApi.list({ projectId }, controller.signal)
      .then(result => {
        if (!cancelled) setCatalog({ projectId, entities: result.entities })
      })
      .catch(error => { if (!cancelled) setLoadError(errorMessage(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; controller.abort() }
  }, [projectId, focusRequest])

  const entities = useMemo(() => catalog && catalog.projectId === projectId ? catalog.entities : [], [catalog, projectId])
  const catalogReady = catalog !== null && catalog.projectId === projectId
  const byId = useMemo(() => new Map(entities.map(entity => [entityKey(entity), entity])), [entities])
  const documentInvalid = validatePromptDocument(document).length > 0
  const unresolved = useMemo(() => {
    if (documentInvalid) return []
    return findUnresolvedPromptMentions(document, catalogReady ? entity => byId.has(entityKey(entity)) : undefined)
  }, [document, documentInvalid, catalogReady, byId])
  const query = queryAtCaret(document.text, selection.start, selection.end)
  const matches = useMemo(() => {
    if (!query) return []
    const needle = normalizedSearch(query.query)
    return entities.filter(entity => (query.prefix === '@' ? entity.kind === 'character' : entity.kind !== 'character')
      && (!needle || normalizedSearch(entity.handle).includes(needle) || normalizedSearch(entity.name).includes(needle))).slice(0, 8)
  }, [entities, query?.query, query?.prefix])
  const menuOpen = focused && !disabled && !dismissed && query !== null && !composing.current
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1))
  const activeOptionId = menuOpen && matches[activeIndex] ? `${listId}-${activeIndex}` : undefined
  const hasWarning = documentInvalid || unresolved.length > 0 || insertionError

  useEffect(() => { setActive(0) }, [query?.start, query?.query, query?.prefix, projectId])
  useEffect(() => {
    if (activeOptionId) window.document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' })
  }, [activeOptionId])

  function syncSelection(element: HTMLTextAreaElement, reopen = true): void {
    setSelection({ start: element.selectionStart, end: element.selectionEnd })
    if (reopen) setDismissed(false)
  }

  function insert(entity: CatalogEntity): void {
    const element = textarea.current
    if (!element || disabled || composing.current) return
    const target = queryAtCaret(document.text, element.selectionStart, element.selectionEnd)
    if (!target) return
    const label = entity.handle.replace(/^@/, '')
    if (maxLength !== undefined && document.text.length - (target.end - target.start) + label.length + 1 > maxLength) return
    try {
      // Invalid persisted data is surfaced, not thrown from event handlers. The
      // next explicit user edit repairs it without inventing any name bindings.
      const base = documentInvalid ? { version: 1 as const, text: document.text, mentions: [] } : document
      const next = insertPromptMention(base, target.start, target.end, { kind: entity.kind, id: entity.id }, label, undefined, target.prefix)
      onChange(next)
      setInsertionError(false)
      setDismissed(true)
      const position = target.start + label.length + 1
      setSelection({ start: position, end: position })
      requestAnimationFrame(() => {
        if (textarea.current !== element) return
        element.focus()
        element.setSelectionRange(position, position)
        setDismissed(true)
      })
    } catch {
      setInsertionError(true)
    }
  }

  return <div className={`entity-mention${disabled ? ' is-disabled' : ''}`}>
    <textarea
      ref={textarea}
      id={id}
      name={name}
      className={['entity-mention-input', className].filter(Boolean).join(' ')}
      value={document.text}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      maxLength={maxLength}
      aria-label={ariaLabel}
      aria-autocomplete="list"
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? listId : undefined}
      aria-activedescendant={activeOptionId}
      aria-invalid={hasWarning || undefined}
      aria-describedby={[helpId, hasWarning && warningId, loadError && errorId].filter(Boolean).join(' ')}
      onFocus={event => {
        setFocused(true)
        setFocusRequest(current => current + 1)
        syncSelection(event.currentTarget)
      }}
      onBlur={event => { setFocused(false); setDismissed(true); onBlur?.(event) }}
      onChange={event => {
        const text = event.currentTarget.value
        const base = documentInvalid ? { version: 1 as const, text: document.text, mentions: [] } : document
        onChange(updatePromptDocument(base, text))
        setInsertionError(false)
        syncSelection(event.currentTarget)
      }}
      onSelect={event => syncSelection(event.currentTarget, false)}
      onClick={event => syncSelection(event.currentTarget)}
      onCompositionStart={() => { composing.current = true; setDismissed(true) }}
      onCompositionEnd={event => { composing.current = false; syncSelection(event.currentTarget) }}
      onKeyDown={event => {
        if (!menuOpen || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true) }
        else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
          event.preventDefault()
          setActive(current => (Math.min(current, matches.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
        } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && matches[activeIndex]) {
          event.preventDefault()
          insert(matches[activeIndex])
        }
        // Tab, modified Enter and keys outside an open list keep native semantics.
      }}
    />
    {menuOpen && <div className="entity-mention-menu">
      <div id={listId} className="entity-mention-options" role="listbox" aria-label={t(query?.prefix === '#' ? 'mentionObjectList' : 'mentionCharacterList')} aria-busy={loading}>
        {matches.map((entity, index) => <button
          key={entityKey(entity)}
          id={`${listId}-${index}`}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === activeIndex}
          className={`entity-mention-option${index === activeIndex ? ' is-active' : ''}`}
          onPointerDown={event => { event.preventDefault() }}
          onMouseEnter={() => setActive(index)}
          onClick={() => insert(entity)}
        >
          {referenceUrl(entity) ? <img className="entity-mention-thumbnail" src={referenceUrl(entity)} alt="" loading="lazy" />
            : <span className="entity-mention-thumbnail entity-mention-thumbnail-empty" aria-hidden="true">{query?.prefix}</span>}
          <span className="entity-mention-option-copy"><strong>{query?.prefix}{entity.handle}</strong><span>{entity.name}</span></span>
          <span className="entity-mention-kind">{t(entity.kind)}</span>
        </button>)}
      </div>
      {!matches.length && <div className="entity-mention-empty" role="status">{loading ? t('loading') : loadError || t('mentionEmpty')}</div>}
    </div>}
    <div className="entity-mention-help" id={helpId}>{t('mentionHelp')}</div>
    {hasWarning && <div className="entity-mention-warning" id={warningId} role="status">
      <span>{t('mentionUnbound')}</span>
      {unresolved.length > 0 && <span className="entity-mention-unresolved">{unresolved.map(mention => `${document.text[mention.start] ?? '@'}${mention.label}`).join(', ')}</span>}
    </div>}
    {loadError && <div className="entity-mention-error" id={errorId} role="status">{loadError}</div>}
    {document.mentions.length > 0 && !documentInvalid && <div className="entity-mention-chips">
      {document.mentions.map(binding => {
        const entity = byId.get(entityKey(binding.entity))
        const missing = catalogReady && !entity
        return <span key={binding.id} className={`entity-mention-chip${missing ? ' is-unresolved' : ''}`}>
          {entity && referenceUrl(entity) && <img src={referenceUrl(entity)} alt="" loading="lazy" />}
          <span>{document.text[binding.start] ?? '@'}{binding.label}</span><small>{t(binding.entity.kind)}</small>
        </span>
      })}
    </div>}
  </div>
}
