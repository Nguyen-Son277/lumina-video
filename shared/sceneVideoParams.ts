import { inferVideoApiStyle, isAgnesFlash, type VideoApiStyle } from './videoApi'
import { normalizeHiggsfieldParams } from './higgsfield'
import { validVideoSeconds } from './videoControls'

type Model = { modelId: string; videoApiStyle?: VideoApiStyle }
export const sceneVideoStyle = (model: Model): VideoApiStyle => model.videoApiStyle ?? inferVideoApiStyle(model.modelId)
const applicationKeys = ['logoOverlays', 'allowTemporaryMedia', 'useCharacterReference'] as const
export function sceneApplicationParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(applicationKeys.filter(key => key in params).map(key => [key, params[key]]))
}
export function sceneVideoDefaults(model: Model): Record<string, unknown> {
  const style = sceneVideoStyle(model)
  if (style === 'higgsfield') return { mode: 'text', duration: 5, resolution: '720p', bitrateMode: 'high', generateAudio: true, aspectRatio: '16:9', outputFormat: 'mp4', useCharacterReference: false }
  if (style === 'agnes') return { mode: 'text', size: '720P', seconds: '5', aspectRatio: '16:9', n: 1, useCharacterReference: false }
  return { size: '1280x720', seconds: '4' }
}
export function completeSceneVideoParams(model: Model, params: Record<string, unknown>): Record<string, unknown> {
  const defaults = sceneVideoDefaults(model)
  if (sceneVideoStyle(model) === 'higgsfield' && params.mode === 'image') {
    delete defaults.aspectRatio; delete defaults.outputFormat
  }
  return { ...defaults, ...params }
}
export function switchSceneVideoParams(model: Model, previous: Record<string, unknown>): Record<string, unknown> {
  return { ...sceneVideoDefaults(model), ...sceneApplicationParams(previous), ...(sceneVideoStyle(model) !== 'openai' ? { useCharacterReference: false } : {}) }
}
export function sceneVideoDurationValid(model: Model, params: Record<string, unknown>): boolean {
  const complete = completeSceneVideoParams(model, params)
  if (sceneVideoStyle(model) === 'higgsfield') return Number.isInteger(complete.duration) && Number(complete.duration) >= 4 && Number(complete.duration) <= 30
  return validVideoSeconds(complete.seconds, isAgnesFlash(model.modelId) ? 12 : 30)
}
export function validateSceneHiggsfield(model: Model, params: Record<string, unknown>, prompt: string): void {
  if (sceneVideoStyle(model) === 'higgsfield') normalizeHiggsfieldParams(params, prompt)
}
