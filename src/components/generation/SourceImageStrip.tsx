import type { HTMLAttributes, Key, ReactNode } from 'react'
import { LoaderCircle, Plus, X } from 'lucide-react'

export type SourceImageStripProps<T> = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  items: readonly T[]
  getKey: (item: T, index: number) => Key
  getUrl?: (item: T) => string | undefined
  getAlt?: (item: T) => string
  onRemove?: (item: T) => void
  removeLabel?: string
  onFiles?: (files: FileList | null) => void
  canAdd?: boolean
  uploading?: boolean
  /** File input only; removal keeps the caller's existing fieldset/button policy. */
  disabled?: boolean
  addLabel?: ReactNode
  accept?: string
  multiple?: boolean
  itemClassName?: string
  removeClassName?: string
  addClassName?: string
  /** Override item content, without forcing library references into upload semantics. */
  renderItem?: (item: T, index: number) => ReactNode
  beforeItems?: ReactNode
  addSlot?: ReactNode
  afterItems?: ReactNode
  children?: ReactNode
}

/** Controlled thumbnail/add presentation; upload and removal lifecycles belong to callers. */
export function SourceImageStrip<T>({
  items, getKey, getUrl, getAlt, onRemove, removeLabel, onFiles, canAdd = false,
  uploading = false, disabled = false, addLabel, accept = 'image/png,image/jpeg,image/webp,image/gif', multiple = true,
  className = 'project-source-strip', itemClassName = 'project-source-item',
  removeClassName = 'project-source-remove', addClassName = 'project-source-add',
  renderItem, beforeItems, addSlot, afterItems, children, ...props
}: SourceImageStripProps<T>) {
  return <div {...props} className={className}>
    {beforeItems}
    {items.map((item, index) => <div className={itemClassName} key={getKey(item, index)}>
      {renderItem ? renderItem(item, index) : <>
        {getUrl && <img src={getUrl(item)} alt={getAlt?.(item) ?? ''} />}
        {onRemove && <button type="button" className={removeClassName} aria-label={removeLabel} onClick={() => onRemove(item)}><X size={13} /></button>}
      </>}
    </div>)}
    {addSlot !== undefined ? addSlot : canAdd && onFiles && <label className={addClassName}>
      <input type="file" accept={accept} multiple={multiple} disabled={disabled} onChange={event => {
        onFiles(event.target.files)
        event.target.value = ''
      }} />
      {uploading ? <LoaderCircle size={18} className="spin" /> : <Plus size={18} />}
      <span>{addLabel}</span>
    </label>}
    {afterItems}
    {children}
  </div>
}
