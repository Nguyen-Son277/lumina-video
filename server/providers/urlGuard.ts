import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { badRequest, errorMeta } from '../lib/errors'

export type ResolvedAddress = {
  address: string
  family: 4 | 6
}

export type UrlGuardOptions = {
  allowPrivate: boolean
  /**
   * Bỏ qua bước phân giải DNS. Chỉ dùng ở chế độ mock, nơi không hề có
   * kết nối mạng nào được thực hiện. Không bao giờ bật ở chế độ live.
   */
  skipDnsCheck?: boolean
}

/**
 * Các dải địa chỉ không được phép kết nối tới.
 * Bao gồm loopback, private, link-local, CGNAT, metadata cloud và IPv6 tương ứng.
 */
const BLOCKED_V4_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'private',
  'carrierGradeNat',
  'reserved',
  'benchmarking',
  'amt',
  'as112',
  'thisNetwork',
])

const BLOCKED_V6_RANGES = new Set([
  'unspecified',
  'linkLocal',
  'multicast',
  'loopback',
  'uniqueLocal',
  'ipv4Mapped',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
  'reserved',
  'benchmarking',
  'amt',
  'as112v6',
  'orchid2',
  'droneRemoteIdProtocolEntityTags',
])

/** Metadata endpoint của các nhà cung cấp cloud — chặn tuyệt đối. */
const METADATA_ADDRESSES = new Set(['169.254.169.254', 'fd00:ec2::254', '100.100.100.200'])

export function isBlockedAddress(address: string): boolean {
  if (METADATA_ADDRESSES.has(address.toLowerCase())) return true

  const version = isIP(address)
  if (version === 0) return true

  try {
    const parsed = ipaddr.parse(address)
    if (parsed.kind() === 'ipv4') {
      return BLOCKED_V4_RANGES.has(parsed.range())
    }
    const v6 = parsed as ipaddr.IPv6
    // Địa chỉ IPv4-mapped (::ffff:127.0.0.1) phải kiểm tra theo dải IPv4.
    if (v6.isIPv4MappedAddress()) {
      return BLOCKED_V4_RANGES.has(v6.toIPv4Address().range())
    }
    return BLOCKED_V6_RANGES.has(v6.range())
  } catch {
    return true
  }
}

/**
 * Phân giải DNS và trả về địa chỉ. Dùng hàm lookup tuỳ biến để undici không
 * tự phân giải lại, tránh tấn công DNS rebinding giữa bước kiểm tra và kết nối.
 */
export function resolveHostname(hostname: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(
          badRequest(
            `Không phân giải được tên miền "${hostname}"`,
            undefined,
            errorMeta('providers.domain_resolve_failed', { host: hostname }),
          ),
        )
        return
      }
      const normalized = addresses
        .filter((item): item is { address: string; family: 4 | 6 } => item.family === 4 || item.family === 6)
        .map((item) => ({ address: item.address, family: item.family }))
      resolve(normalized)
    })
  })
}

export type GuardedTarget = {
  url: URL
  addresses: ResolvedAddress[]
}

/**
 * Kiểm tra Base URL do người dùng nhập trước khi gửi request mang API key.
 *
 * - Chỉ chấp nhận http/https.
 * - Mặc định bắt buộc https.
 * - Chặn loopback, private, link-local, metadata và các dải nội bộ khác.
 * - Không cho phép thông tin xác thực nhúng trong URL.
 */
export async function guardProviderUrl(
  rawUrl: string,
  options: UrlGuardOptions,
): Promise<GuardedTarget> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw badRequest('Base URL không hợp lệ')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('Base URL chỉ hỗ trợ http hoặc https')
  }

  if (url.username || url.password) {
    throw badRequest('Base URL không được chứa thông tin đăng nhập')
  }

  if (!options.allowPrivate && url.protocol !== 'https:') {
    throw badRequest('Base URL phải dùng https')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')

  // Nếu là IP literal thì kiểm tra trực tiếp, không cần DNS.
  if (isIP(hostname) !== 0) {
    if (!options.allowPrivate && isBlockedAddress(hostname)) {
      throw badRequest('Base URL trỏ tới địa chỉ nội bộ, không được phép')
    }
    return { url, addresses: [{ address: hostname, family: isIP(hostname) as 4 | 6 }] }
  }

  // Chế độ mock không gọi mạng nên không cần phân giải tên miền.
  if (options.skipDnsCheck) {
    return { url, addresses: [] }
  }

  const addresses = await resolveHostname(hostname)
  if (addresses.length === 0) {
    throw badRequest(
      `Không phân giải được tên miền "${hostname}"`,
      undefined,
      errorMeta('providers.domain_resolve_failed', { host: hostname }),
    )
  }

  if (!options.allowPrivate) {
    const blocked = addresses.find((item) => isBlockedAddress(item.address))
    if (blocked) {
      throw badRequest(
        `Tên miền "${hostname}" trỏ tới địa chỉ nội bộ (${blocked.address}), không được phép`,
        undefined,
        errorMeta('providers.domain_private_address', { host: hostname, address: blocked.address }),
      )
    }
  }

  return { url, addresses }
}

/**
 * Ghép Base URL với đường dẫn endpoint mà không tạo dấu "/" thừa
 * và không tự thêm hay bỏ tiền tố /v1 do người dùng đã nhập.
 */
export function joinUrl(baseUrl: string, endpointPath: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const path = endpointPath.trim().replace(/^\/+/, '')
  return `${base}/${path}`
}
