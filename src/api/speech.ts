import { api } from './client'
import type { NarrationPreferences, SpeechInput, SpeechJob, SpeechScope } from '../../shared/speech'
export type { NarrationInput, NarrationPreferences, SpeechJob, SpeechScope } from '../../shared/speech'

const query = (scope: SpeechScope): string => {
  const params = new URLSearchParams()
  if (scope.projectId) params.set('projectId', scope.projectId)
  if (scope.quickSessionId) params.set('quickSessionId', scope.quickSessionId)
  return params.size ? `?${params}` : ''
}

export const speechApi = {
  create: (input: SpeechInput, key: string = crypto.randomUUID()) => api.postWithKey<{ job: SpeechJob }>('/speech-jobs', input, key),
  list: (scope: SpeechScope, signal?: AbortSignal) => api.get<{ jobs: SpeechJob[] }>(`/speech-jobs${query(scope)}`, signal),
  get: (id: string) => api.get<{ job: SpeechJob }>(`/speech-jobs/${encodeURIComponent(id)}`),
  remove: (id: string) => api.delete<void>(`/speech-jobs/${encodeURIComponent(id)}`),
  preferences: (scope: SpeechScope, signal?: AbortSignal) => api.get<{ preferences: NarrationPreferences }>(`/speech-jobs/preferences${query(scope)}`, signal),
  savePreferences: (scope: SpeechScope, preferences: NarrationPreferences) => api.put<{ preferences: NarrationPreferences }>('/speech-jobs/preferences', { scope, preferences }),
}
