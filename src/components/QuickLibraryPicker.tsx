import { useEffect, useState } from 'react'
import { entityLibraryApi, entityReferenceUrl, type EntityLibraryEntity } from '../api/entityLibrary'
import { errorMessage } from '../api/client'
import { useTranslation } from '../i18n'
import { entityLibraryCatalog } from '../i18n/catalogs/entityLibrary'

export type LibrarySelection = { entity: EntityLibraryEntity; uploadId?: string; label?: string }
/** Explicit owner-scoped entity/view selection; callers pin identity into prompt bindings. */
export function QuickLibraryPicker({ onSelect, disabled, selectedKeys = [] }: { onSelect: (selection: LibrarySelection) => void; disabled?: boolean; selectedKeys?: string[] }) {
  const { t } = useTranslation(entityLibraryCatalog)
  const [open,setOpen]=useState(false), [items,setItems]=useState<EntityLibraryEntity[]>([]), [error,setError]=useState('')
  const [kind,setKind]=useState('all'), [search,setSearch]=useState('')
  const [views,setViews]=useState<Record<string,string>>({})
  useEffect(()=>{if(!open)return;const abort=new AbortController();setError('');entityLibraryApi.list({},abort.signal).then(r=>{if(!abort.signal.aborted)setItems(r.entities)}).catch(e=>{if(!abort.signal.aborted)setError(errorMessage(e))});return()=>abort.abort()},[open])
  return <div className="quick-library-picker">
    <button type="button" className="secondary-button" disabled={disabled} onClick={()=>setOpen(!open)}>{t('chooseLibrary')}</button>
    {open&&<div>
      <label>{t('kind')}<select value={kind} onChange={e=>setKind(e.target.value)}>{(['all','item','location','logo'] as const).map(k=><option key={k} value={k}>{t(k)}</option>)}</select></label>
      <label>{t('search')}<input value={search} onChange={e=>setSearch(e.target.value)} /></label>
      {error&&<p role="alert">{error}</p>}
      <div className="entity-library-grid">{items.filter(e=>e.kind!=='character'&&(kind==='all'||e.kind===kind)&&`${e.name} ${e.handle}`.toLowerCase().includes(search.toLowerCase())).map(entity=>{
        const key=`${entity.kind}:${entity.id}`
        const uploadId=views[key]??entity.reference?.uploadId
        const view=entity.referenceViews?.find(v=>v.uploadId===uploadId)
        const preview=uploadId?`/api/uploads/${encodeURIComponent(uploadId)}`:entityReferenceUrl(entity)
        return <div key={key}>
          {entity.kind==='location'&&Boolean(entity.referenceViews?.length)&&<label>{t('referenceView')}<select value={uploadId??''} onChange={e=>setViews(current=>({...current,[key]:e.target.value}))}>{entity.referenceViews!.map(v=><option key={v.id} value={v.uploadId}>{v.label||t('defaultView')}</option>)}</select></label>}
          <button type="button" className="secondary-button" disabled={disabled||selectedKeys.includes(key)} onClick={()=>{onSelect({entity,uploadId,label:view?.label});setOpen(false)}}>
            {preview&&<img src={preview} alt={entity.name} style={{width:64,height:64,objectFit:'cover'}}/>}
            {t(entity.kind)} · {entity.name} (@{entity.handle})
          </button>
        </div>
      })}</div>
      <p>{t('pickerHint')}</p>
    </div>}
  </div>
}
