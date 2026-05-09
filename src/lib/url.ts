export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (parsed.pathname.endsWith('/') && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'mc_cid', 'mc_eid']
    for (const param of trackingParams) {
      parsed.searchParams.delete(param)
    }
    return parsed.toString().replace(/\?$/, '')
  } catch {
    return url
  }
}
