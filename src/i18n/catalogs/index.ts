/**
 * Điểm gom các catalog theo namespace để test và lớp UI nhập một chỗ.
 * Thêm namespace mới: tạo `src/i18n/catalogs/<tên>.ts` rồi khai báo trong `catalogs`.
 */

import { plannerCharactersCatalog } from './plannerCharacters'
import { adminCatalog } from './admin'
import { commonCatalog } from './common'
import { shellCatalog } from './shell'
import { studioCatalog } from './studio'
import { charactersCatalog } from './characters'
import { plannerCatalog } from './planner'
import { providerKeysCatalog } from './providerKeys'
import { locationsCatalog } from './locations'

export { commonCatalog, shellCatalog, studioCatalog, charactersCatalog, plannerCatalog, providerKeysCatalog, locationsCatalog, adminCatalog }
export type { CommonCatalog } from './common'

/** Registry mọi namespace đã đăng ký. */
export const catalogs = {
  common: commonCatalog,
  shell: shellCatalog,
  studio: studioCatalog,
  characters: charactersCatalog,
  plannerCharacters: plannerCharactersCatalog,
  planner: plannerCatalog,
  providerKeys: providerKeysCatalog,
  locations: locationsCatalog,
  admin: adminCatalog,
} as const

export type CatalogNamespace = keyof typeof catalogs
