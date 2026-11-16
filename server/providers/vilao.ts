/** Match only the documented Vilao API host, never lookalike domains. */
export function isVilaoBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return ['https:', 'http:'].includes(url.protocol) && url.hostname.toLowerCase() === 'api.vilao.ai'
  } catch {
    return false
  }
}
