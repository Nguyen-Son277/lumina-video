import { describe, expect, it } from 'vitest'
import { CANVAS_SCHEMA_VERSION, validateCanvasGraph } from '../../shared/canvas'
import { effectiveCanvasVideoParams, isCanvasVideoSettings, sanitizeCanvasVideoSettings } from '../../shared/canvasVideoSettings'

const openai = { modelId: 'sora' }
const agnes = { modelId: 'agnes-video-2.5' }
const flash = { modelId: 'agnes-video-2.5-flash' }
const hf = { modelId: 'bytedance/seedance-2.5' }
const sanitize = (model: typeof openai, params: Record<string, unknown>) => sanitizeCanvasVideoSettings({ modelId: model.modelId, params }, model)
const graph = (videoSettings: unknown, modelId: unknown = 'sora', kind = 'video') => ({
  schemaVersion: CANVAS_SCHEMA_VERSION,
  nodes: [{ id: 'video', kind, x: 0, y: 0, data: { modelId, ...(videoSettings === undefined ? {} : { videoSettings }) } }], edges: [],
})

describe('Canvas stable video overrides', () => {
  it('retains only protocol controls and never mutates scene values', () => {
    const params = { size: '1920x1200', seconds: '19', imageUploadId: 'private', imageUrl: 'https://example.com', input_reference: 'private', firstFrame: 'https://example.com', logoOverlays: [], useCharacterReference: true, allowTemporaryMedia: true, prompt: 'secret', unknown: { nested: true }, duration: 8 }
    expect(sanitize(openai, params)).toEqual({ modelId: 'sora', params: { size: '1920x1200', seconds: '19' } })
    expect(params.imageUploadId).toBe('private')
    expect(sanitize(openai, {})).toEqual({ modelId: 'sora', params: {} })
  })

  it('validates OpenAI types, dimensions and duration', () => {
    for (const params of [{ seconds: '3' }, { seconds: 31 }, { seconds: NaN }, { size: 'https://example.com' }, { size: '0x720' }, { size: 720 }]) expect(() => sanitize(openai, params)).toThrow()
    expect(sanitize(openai, { seconds: 30, size: '1280x720' }).params.seconds).toBe(30)
  })

  it('validates Agnes controls, modes, ranges and Flash restrictions', () => {
    const params = { mode: 'reference', size: '1080P', seconds: '20', aspectRatio: '9:16', seed: -42, n: 1, referenceImages: ['https://example.com'], allowTemporaryMedia: true }
    expect(sanitize(agnes, params).params).toEqual({ mode: 'reference', size: '1080P', seconds: '20', aspectRatio: '9:16', seed: -42, n: 1 })
    for (const bad of [{ mode: 'image' }, { size: '1280x720' }, { seed: 1.2 }, { n: 0 }, { n: 5 }, { aspectRatio: '2:1' }]) expect(() => sanitize(agnes, bad)).toThrow()
    for (const bad of [{ size: '1080P' }, { seconds: '13' }, { seconds: 5 }, { n: 2 }]) expect(() => sanitize(flash, bad)).toThrow()
    expect(sanitize(flash, { seconds: '12', size: '720P', n: 1 }).params.seconds).toBe('12')
  })

  it('uses explicit protocol metadata, not just model IDs', () => {
    const custom = { modelId: 'custom', videoApiStyle: 'higgsfield' as const }
    expect(sanitizeCanvasVideoSettings({ modelId: 'custom', params: { duration: 10, seconds: '8' } }, custom).params).toEqual({ duration: 10 })
  })

  it('validates Higgsfield settings without persisting a frame or application params', () => {
    expect(sanitize(hf, { mode: 'image', duration: 8, resolution: '1080p', bitrateMode: 'standard', generateAudio: false, imageUploadId: 'private' }).params).toEqual({ mode: 'image', duration: 8, resolution: '1080p', bitrateMode: 'standard', generateAudio: false })
    for (const bad of [{ mode: 'reference' }, { duration: 3 }, { duration: 4.5 }, { resolution: '4k' }, { bitrateMode: 'low' }, { generateAudio: 'true' }, { aspectRatio: '2:1' }, { outputFormat: 'webm' }, { mode: 'image', aspectRatio: '16:9' }, { mode: 'image', outputFormat: 'mp4' }]) expect(() => sanitize(hf, bad)).toThrow()
  })

  it('rejects invalid envelopes but keeps local model IDs distinct from upstream names', () => {
    for (const value of [null, [], {}, { modelId: 'sora', params: [] }]) expect(() => sanitizeCanvasVideoSettings(value, openai)).toThrow()
  })

  it('inherits complete settings and application params but not any media', () => {
    const inherited = { seconds: '8', size: '1920x1200', logoOverlays: [{ id: 'logo' }], allowTemporaryMedia: true, useCharacterReference: true, imageUploadId: 'private', input_reference: 'https://example.com' }
    expect(effectiveCanvasVideoParams(openai, inherited)).toEqual(inherited)
    expect(sanitizeCanvasVideoSettings({ modelId: 'local-uuid', params: { seconds: '12' } }, openai).modelId).toBe('local-uuid')
    expect(effectiveCanvasVideoParams(openai, inherited, sanitize(openai, { seconds: '12' }))).toEqual({ size: '1280x720', seconds: '12', logoOverlays: inherited.logoOverlays, allowTemporaryMedia: true, useCharacterReference: true })
    expect(effectiveCanvasVideoParams(openai, {}, { modelId: 'local', params: { seconds: '20' } })).toMatchObject({ size: '1280x720', seconds: '20' })
    expect(effectiveCanvasVideoParams(hf, { aspectRatio: '16:9', outputFormat: 'mov', logoOverlays: [] }, sanitize(hf, { mode: 'image' }))).toEqual({ mode: 'image', duration: 5, resolution: '720p', bitrateMode: 'high', generateAudio: true, useCharacterReference: false, logoOverlays: [] })
  })
})

describe('Canvas video settings graph structure', () => {
  it('preserves schema v1 and accepts legacy nodes and valid bound settings', () => {
    expect(CANVAS_SCHEMA_VERSION).toBe(1)
    expect(validateCanvasGraph(graph(undefined))).toEqual([])
    expect(validateCanvasGraph(graph(sanitize(openai, { seconds: '8' })))).toEqual([])
  })

  it('rejects malformed envelopes, media/application/unknown keys and bad primitive values', () => {
    for (const value of [null, [], {}, { modelId: '', params: {} }, { modelId: 'sora', params: [] }, { modelId: 'sora', params: { seconds: {} } }, { modelId: 'sora', params: { seconds: Infinity } }, { modelId: 'sora', params: { imageUploadId: 'private' } }, { modelId: 'sora', params: { allowTemporaryMedia: true } }, { modelId: 'sora', params: {}, media: 'private' }]) {
      expect(isCanvasVideoSettings(value)).toBe(false)
      expect(validateCanvasGraph(graph(value))).toContainEqual({ code: 'node_video_settings_invalid', id: 'video' })
    }
  })

  it('requires a video node with matching node modelId', () => {
    const settings = sanitize(openai, {})
    for (const candidate of [graph(settings, 'other'), graph(settings, null), graph(settings, 'sora', 'image')]) expect(validateCanvasGraph(candidate)).toContainEqual({ code: 'node_video_settings_invalid', id: 'video' })
  })
})
