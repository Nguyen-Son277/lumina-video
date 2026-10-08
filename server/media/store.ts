import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Database } from '../db/index'
import { insufficientStorage, notFound, providerIncompatible } from '../lib/errors'

/** Định dạng media được phép phục vụ. Không bao giờ phục vụ HTML hoặc SVG. */
const ALLOWED_MIME = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
])

/** Suy ra MIME từ magic bytes, không tin header của provider. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (png.every((value, index) => bytes[index] === value)) return 'image/png'
  }
  if (bytes.length >= 3) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6))
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4))
    const webp = String.fromCharCode(...bytes.slice(8, 12))
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  if (bytes.length >= 12) {
    const ftyp = String.fromCharCode(...bytes.slice(4, 8))
    if (ftyp === 'ftyp') {
      const brand = String.fromCharCode(...bytes.slice(8, 12)).toLowerCase()
      if (brand.startsWith('qt')) return 'video/quicktime'
      return 'video/mp4'
    }
  }
  if (bytes.length >= 4) {
    const ebml = [0x1a, 0x45, 0xdf, 0xa3]
    if (ebml.every((value, index) => bytes[index] === value)) return 'video/webm'
  }
  return null
}

export function extensionFor(mime: string): string | null {
  return ALLOWED_MIME.get(mime) ?? null
}

export type MediaStore = {
  root: string
  save: (input: {
    userId: string
    generationId: string
    bytes: Uint8Array
    declaredMime?: string
    /** Chỉ số khi một tác vụ trả về nhiều tệp, tránh ghi đè lẫn nhau. */
    index?: number
  }) => { relativePath: string; mimeType: string; byteSize: number }
  absolutePath: (relativePath: string) => string
  openReadStream: (relativePath: string) => ReturnType<typeof createReadStream>
  stat: (relativePath: string) => { size: number }
  remove: (relativePath: string) => void
  removeGenerationDir: (userId: string, generationId: string) => void
  /** Lưu ảnh tham chiếu của nhân vật vào thư mục riêng của người dùng. */
  saveCharacterReference: (input: {
    userId: string
    characterId: string
    bytes: Uint8Array
    declaredMime?: string
    maxBytes: number
  }) => { relativePath: string; mimeType: string; byteSize: number }
  /** Xóa ảnh tham chiếu cũ của nhân vật (mọi định dạng). */
  removeCharacterReference: (userId: string, characterId: string) => void
  /** Đọc toàn bộ tệp để dựng data URL gửi cho provider. */
  readFile: (relativePath: string) => Uint8Array
  /** Lưu ảnh nguồn do người dùng tải lên để tạo ảnh mới từ ảnh đó. */
  saveUpload: (input: {
    userId: string
    uploadId: string
    bytes: Uint8Array
    maxBytes: number
  }) => { relativePath: string; mimeType: string; byteSize: number }
  /** Xóa tệp của một ảnh nguồn theo id. */
  removeUpload: (userId: string, uploadId: string) => void
  /** Xóa một tệp theo đường dẫn tương đối trong kho. */
  removeByPath: (relativePath: string) => void
  userUsageBytes: (db: Database, userId: string) => number
  exists: (relativePath: string) => boolean
}

export function createMediaStore(options: {
  root: string
  maxImageBytes: number
  maxVideoBytes: number
  maxUserBytes: number
}): MediaStore {
  const root = resolve(options.root)
  mkdirSync(root, { recursive: true })

  function absolutePath(relativePath: string): string {
    const absolute = resolve(join(root, relativePath))
    // Chặn path traversal: đường dẫn cuối phải nằm trong thư mục gốc.
    if (!absolute.startsWith(root)) {
      throw notFound('Đường dẫn media không hợp lệ')
    }
    return absolute
  }

  return {
    root,
    absolutePath,

    save({ userId, generationId, bytes, declaredMime, index = 0 }) {
      const sniffed = sniffMime(bytes)
      const mimeType = sniffed ?? (declaredMime && ALLOWED_MIME.has(declaredMime) ? declaredMime : null)

      if (!mimeType) {
        throw providerIncompatible(
          'Nội dung provider trả về không phải định dạng ảnh hoặc video được hỗ trợ',
        )
      }

      const isVideo = mimeType.startsWith('video/')
      const limit = isVideo ? options.maxVideoBytes : options.maxImageBytes
      if (bytes.byteLength > limit) {
        throw insufficientStorage(
          `Tệp vượt giới hạn cho phép (${Math.round(limit / 1024 / 1024)} MB)`,
        )
      }

      const extension = extensionFor(mimeType)
      if (!extension) {
        throw providerIncompatible('Định dạng media không được hỗ trợ')
      }

      const relativeDir = join(userId, generationId)
      const directory = absolutePath(relativeDir)
      mkdirSync(directory, { recursive: true })

      const relativePath = join(relativeDir, index === 0 ? `output.${extension}` : `output-${index}.${extension}`)
      writeFileSync(absolutePath(relativePath), bytes)

      return { relativePath, mimeType, byteSize: bytes.byteLength }
    },

    openReadStream(relativePath) {
      return createReadStream(absolutePath(relativePath))
    },

    stat(relativePath) {
      const info = statSync(absolutePath(relativePath))
      return { size: info.size }
    },

    remove(relativePath) {
      const absolute = absolutePath(relativePath)
      if (existsSync(absolute)) rmSync(absolute, { force: true })
    },

    removeGenerationDir(userId, generationId) {
      const directory = absolutePath(join(userId, generationId))
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
    },

    saveCharacterReference({ userId, characterId, bytes, maxBytes }) {
      // Ảnh tham chiếu bắt buộc phải nhận dạng được bằng magic bytes.
      // Không tin Content-Type do client khai báo, tránh tải lên nội dung khác
      // đội lốt ảnh (ví dụ HTML) rồi được phục vụ lại cho người dùng.
      const mimeType = sniffMime(bytes)

      if (!mimeType || !mimeType.startsWith('image/')) {
        throw providerIncompatible('Ảnh tham chiếu phải là PNG, JPEG, WebP hoặc GIF hợp lệ')
      }
      if (bytes.byteLength > maxBytes) {
        throw insufficientStorage(
          `Ảnh tham chiếu vượt giới hạn ${Math.round(maxBytes / 1024 / 1024)} MB`,
        )
      }

      const extension = extensionFor(mimeType)
      if (!extension) throw providerIncompatible('Định dạng ảnh không được hỗ trợ')

      // Xóa ảnh cũ trước để không tích tụ nhiều định dạng cho cùng nhân vật.
      const oldDirectory = absolutePath(join(userId, 'characters', characterId))
      if (existsSync(oldDirectory)) rmSync(oldDirectory, { recursive: true, force: true })

      const relativeDir = join(userId, 'characters', characterId)
      mkdirSync(absolutePath(relativeDir), { recursive: true })
      const relativePath = join(relativeDir, `reference.${extension}`)
      writeFileSync(absolutePath(relativePath), bytes)

      return { relativePath, mimeType, byteSize: bytes.byteLength }
    },

    removeCharacterReference(userId, characterId) {
      const directory = absolutePath(join(userId, 'characters', characterId))
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
    },

    readFile(relativePath) {
      return readFileSync(absolutePath(relativePath))
    },

    saveUpload({ userId, uploadId, bytes, maxBytes }) {
      // Bắt buộc nhận dạng bằng magic bytes, không tin Content-Type của client.
      const mimeType = sniffMime(bytes)
      if (!mimeType || !mimeType.startsWith('image/')) {
        throw providerIncompatible('Ảnh nguồn phải là PNG, JPEG, WebP hoặc GIF hợp lệ')
      }
      if (bytes.byteLength > maxBytes) {
        throw insufficientStorage(
          `Ảnh nguồn vượt giới hạn ${Math.round(maxBytes / 1024 / 1024)} MB`,
        )
      }

      const extension = extensionFor(mimeType)
      if (!extension) throw providerIncompatible('Định dạng ảnh không được hỗ trợ')

      const relativeDir = join(userId, 'uploads', uploadId)
      mkdirSync(absolutePath(relativeDir), { recursive: true })
      const relativePath = join(relativeDir, `source.${extension}`)
      writeFileSync(absolutePath(relativePath), bytes)

      return { relativePath, mimeType, byteSize: bytes.byteLength }
    },

    removeUpload(userId, uploadId) {
      const directory = absolutePath(join(userId, 'uploads', uploadId))
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
    },

    removeByPath(relativePath) {
      const absolute = absolutePath(relativePath)
      if (existsSync(absolute)) rmSync(absolute, { force: true })
    },

    userUsageBytes(db, userId) {
      const row = db
        .prepare('SELECT COALESCE(SUM(byte_size), 0) AS total FROM assets WHERE user_id = ?')
        .get(userId) as { total: number } | undefined
      return Number(row?.total ?? 0)
    },

    exists(relativePath) {
      return existsSync(absolutePath(relativePath))
    },
  }
}
