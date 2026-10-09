/**
 * Kiểu dữ liệu dùng chung cho nền tảng i18n (không phụ thuộc thư viện ngoài).
 *
 * Mỗi namespace là một module xuất `catalog` dạng:
 *   export const catalog = { semanticKey: { en: 'English', vi: 'Tiếng Việt' } } as const
 */

/** Các ngôn ngữ được hỗ trợ. `en` là mặc định. */
export const SUPPORTED_LOCALES = ['en', 'vi'] as const

/** Mã ngôn ngữ hợp lệ. */
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** Tham số nội suy cho một khoá dịch: `{ name: 'Lumina' }` khớp `{name}` trong chuỗi. */
export type MessageParams = Record<string, string | number>

/** Một khoá dịch kèm đủ bản dịch cho mọi `Locale`. */
export type CatalogEntry = Record<Locale, string> & { enOne?: string; viOne?: string }

/** Hình dạng chuẩn của một catalog namespace. */
export type Catalog = Record<string, CatalogEntry>

/** Khoá hợp lệ của một catalog cụ thể. */
export type CatalogKey<C extends Catalog> = keyof C & string

/** Hàm dịch đã gắn catalog (và ngôn ngữ hiện tại). */
export type Translate<C extends Catalog> = (key: CatalogKey<C>, params?: MessageParams) => string

/** Hàm được gọi khi ngôn ngữ hiện tại thay đổi. */
export type LocaleListener = () => void
