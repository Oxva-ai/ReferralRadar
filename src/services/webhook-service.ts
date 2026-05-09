import { pool } from '../db/pool.js'
import { logger } from '../logger.js'

interface Webhook {
  id: string
  url: string
  events: string[]
  secret: string | null
  is_active: boolean
}

interface WebhookPayload {
  event: 'referral.created' | 'referral.updated'
  referral_id: string
  company_name: string | null
  reward: string | null
  reward_numeric: number | null
  referral_link: string | null
  domain: string | null
  discovered_at: string
  timestamp: string
}

export async function getWebhooks(): Promise<Webhook[]> {
  const result = await pool.query<Webhook>(
    `SELECT id, url, events, secret, is_active FROM webhooks WHERE is_active = true`,
  )
  return result.rows
}

export async function createWebhook(url: string, events: string[], secret?: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO webhooks (url, events, secret) VALUES ($1, $2, $3) RETURNING id`,
    [url, events, secret ?? null],
  )
  return result.rows[0]!.id
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM webhooks WHERE id = $1 RETURNING id',
    [id],
  )
  return (result.rowCount ?? 0) > 0
}

export async function getDeliveryHistory(webhookId: string, limit: number = 50): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query(
    `SELECT id, event, status, response_code, response_body, attempted_at
     FROM webhook_deliveries
     WHERE webhook_id = $1
     ORDER BY attempted_at DESC
     LIMIT $2`,
    [webhookId, limit],
  )
  return result.rows
}

async function deliver(webhook: Webhook, payload: WebhookPayload): Promise<void> {
  const body = JSON.stringify(payload)
  const signature = webhook.secret
    ? await createSignature(webhook.secret, body)
    : null

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ReferralRadar-Webhook/1.0',
        ...(signature ? { 'X-Webhook-Signature': signature } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    await pool.query(
      `INSERT INTO webhook_deliveries (webhook_id, event, status, response_code, response_body)
       VALUES ($1, $2, $3, $4, $5)`,
      [webhook.id, payload.event, response.ok ? 'delivered' : 'failed', response.status, await response.text().catch(() => null)],
    )
  } catch (err) {
    logger.warn({ err, webhook: webhook.id, url: webhook.url }, 'webhook delivery failed')
    await pool.query(
      `INSERT INTO webhook_deliveries (webhook_id, event, status, response_code)
       VALUES ($1, $2, 'failed', 0)`,
      [webhook.id, payload.event],
    )
  }
}

async function createSignature(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function fireEvent(event: 'referral.created' | 'referral.updated', payload: Omit<WebhookPayload, 'event' | 'timestamp'>): Promise<void> {
  const webhooks = await getWebhooks()
  const matching = webhooks.filter(w => w.events.includes(event))
  if (matching.length === 0) return

  const fullPayload: WebhookPayload = {
    event,
    ...payload,
    timestamp: new Date().toISOString(),
  }

  await Promise.allSettled(
    matching.map(w => deliver(w, fullPayload).catch(err => {
      logger.error({ err, webhook: w.id }, 'webhook deliver failed')
    }))
  )
}
