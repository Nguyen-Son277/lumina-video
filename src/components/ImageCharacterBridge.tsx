import { createContext, useContext, useState, type ReactNode } from 'react'
import type { ImageEditorSource } from '../../shared/imageEditor'
import type { ModelInfo } from '../api/types'
import { imageEditorApi } from '../api/imageEditor'
import { errorMessage } from '../api/client'
import { useTranslation, notification, type Notification } from '../i18n'
import { entityCreationCatalog } from '../i18n/catalogs/entityCreation'
import { EntityAiDialog } from './entities/EntityAiDialog'
import { CreationModal } from './entities/EntityEditorDialog'

const ImageCharacterContext = createContext<((source: ImageEditorSource) => Promise<void>) | null>(null)
export function useImageCharacterAction() { return useContext(ImageCharacterContext) }

/** The same character creation flow is available from every typed image preview. */
export function ImageCharacterProvider({ children, models, onOpenSettings, onNotify }: {
  children: ReactNode
  models: ModelInfo[]
  onOpenSettings: () => void
  onNotify: (message: Notification) => void
}) {
  const { t } = useTranslation(entityCreationCatalog)
  const [source, setSource] = useState<{ uploadId: string; url: string } | null>(null)
  const [error, setError] = useState<unknown>(null)
  async function open(input: ImageEditorSource) {
    setError(null)
    try {
      const result = await imageEditorApi.prepare(input)
      setSource({ uploadId: result.source.uploadId, url: result.source.url })
    } catch (cause) { setError(cause) }
  }
  return <ImageCharacterContext.Provider value={open}>
    {children}
    {source && <EntityAiDialog key={source.uploadId} kind="character" initialSource={source} modalZIndex={1400}
      llmModels={models.filter(model => model.kind === 'llm')} models={models}
      onClose={() => setSource(null)} onSaved={() => onNotify(notification('entityLibrary', 'notifySaved'))}
      onNotify={onNotify}
      onOpenSettings={() => { setSource(null); onOpenSettings() }} />}
    {error != null && <CreationModal title={t('reference')} testId="image-character-error" zIndex={1400} onClose={() => setError(null)}>
      <p role="alert">{errorMessage(error)}</p>
    </CreationModal>}
  </ImageCharacterContext.Provider>
}
