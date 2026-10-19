import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { loadEnv } from '../../server/env'
import { createMediaStore } from '../../server/media/store'

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

const MB = 1024 * 1024

describe('50 MB generated image limit', () => {
  it('defaults to 50 MB without changing other media limits', () => {
    const env = loadEnv({ APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') })
    expect(env.MAX_IMAGE_BYTES).toBe(50 * MB)
    expect(env.MAX_VIDEO_BYTES).toBe(200 * MB)
    expect(env.MAX_REFERENCE_BYTES).toBe(5 * MB)
    expect(env.MAX_SOURCE_IMAGE_BYTES).toBe(10 * MB)
  })

  it('accepts images above 20 MB through 50 MB and rejects oversized images', () => {
    // Exercise the actual media limit without writing large fixtures to disk.
    const mkdir = vi.mocked(fs.mkdirSync)
    const write = vi.mocked(fs.writeFileSync)
    write.mockClear()
    try {
      const store = createMediaStore({ root: '.', maxImageBytes: 50 * MB, maxVideoBytes: 200 * MB, maxUserBytes: 1024 * MB })
      for (const size of [21 * MB, 50 * MB]) {
        const image = new Uint8Array(size)
        image.set([137, 80, 78, 71, 13, 10, 26, 10])
        expect(store.save({ userId: 'test-user', generationId: 'test-generation', bytes: image }).byteSize).toBe(size)
      }
      const oversized = new Uint8Array(50 * MB + 1)
      oversized.set([137, 80, 78, 71, 13, 10, 26, 10])
      expect(() => store.save({ userId: 'test-user', generationId: 'test-generation', bytes: oversized })).toThrow('50 MB')
      expect(write).toHaveBeenCalledTimes(2)
    } finally {
      mkdir.mockRestore()
      write.mockRestore()
    }
  })
})
