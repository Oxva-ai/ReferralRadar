import got from 'got'
import { logger } from '../logger.js'

// Circuit breaker: per-domain failure tracking
const circuitBreakerState = new Map<string, { consecutiveFailures: number; lastFailureAt: number }>()
const CIRCUIT_BREAKER_THRESHOLD = 5
const CIRCUIT_BREAKER_RESET_MS = 300_000 // 5 minutes

function isCircuitOpen(domain: string): boolean {
  const state = circuitBreakerState.get(domain)
  if (!state) return false
  if (state.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false
  // Reset after 5 minutes
  if (Date.now() - state.lastFailureAt > CIRCUIT_BREAKER_RESET_MS) {
    circuitBreakerState.delete(domain)
    return false
  }
  return true
}

function recordCircuitFailure(domain: string): void {
  const state = circuitBreakerState.get(domain) ?? { consecutiveFailures: 0, lastFailureAt: 0 }
  state.consecutiveFailures++
  state.lastFailureAt = Date.now()
  circuitBreakerState.set(domain, state)
}

function recordCircuitSuccess(domain: string): void {
  circuitBreakerState.delete(domain)
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
]

// Per-domain rate limiting: minimum 3s between requests to same domain
const domainLastRequest = new Map<string, number>()
const MIN_DOMAIN_DELAY = 3_000

async function delayForDomain(domain: string): Promise<void> {
  const last = domainLastRequest.get(domain) ?? 0
  const elapsed = Date.now() - last
  if (elapsed < MIN_DOMAIN_DELAY) {
    await new Promise(r => setTimeout(r, MIN_DOMAIN_DELAY - elapsed))
  }
  domainLastRequest.set(domain, Date.now())
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

async function rotateUserAgent(): Promise<string> {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!
}

export interface FetchResult {
  html: string
  url: string
  statusCode: number
}

export async function fetch(url: string, opts?: { signal?: AbortSignal }): Promise<FetchResult> {
  const domain = getDomain(url)

  if (isCircuitOpen(domain)) {
    logger.warn({ domain }, 'circuit breaker open, skipping request')
    throw new Error(`Circuit breaker open for ${domain}`)
  }

  await delayForDomain(domain)

  const userAgent = await rotateUserAgent()
  logger.debug({ url }, 'fetching')

  try {
    const response = await got(url, {
      headers: { 'User-Agent': userAgent },
      http2: true,
      timeout: { request: 15_000 },
      retry: { limit: 2, statusCodes: [429, 502, 503, 504] },
      followRedirect: true,
      maxRedirects: 3,
      signal: opts?.signal,
    })
    recordCircuitSuccess(domain)
    return {
      html: response.body,
      url: response.url,
      statusCode: response.statusCode,
    }
  } catch (err) {
    recordCircuitFailure(domain)
    throw err
  }
}

export async function headCheck(url: string): Promise<{ statusCode: number; finalUrl: string }> {
  const domain = getDomain(url)
  await delayForDomain(domain)
  const userAgent = await rotateUserAgent()

  try {
    const response = await got(url, {
      method: 'HEAD',
      headers: { 'User-Agent': userAgent },
      http2: true,
      timeout: { request: 10_000 },
      followRedirect: true,
      maxRedirects: 3,
      throwHttpErrors: false,
    })
    return { statusCode: response.statusCode, finalUrl: response.url }
  } catch {
    return { statusCode: 0, finalUrl: url }
  }
}
