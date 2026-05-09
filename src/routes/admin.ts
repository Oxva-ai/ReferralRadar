import { Router, type Request, type Response } from 'express'
import { pool } from '../db/pool.js'
import { getHealthStats, getCseQuotaUsed } from '../db/queries.js'
import { queue } from '../services/queue.js'
import { getDegradedFeeds, getFeedHealth } from '../workers/rss.js'

const router = Router()

router.get('/admin/dashboard', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const health = await getHealthStats()
    const cseUsed = await getCseQuotaUsed()
    const degradedFeeds = getDegradedFeeds()

    // Extra stats
    const [typeCounts, sourceCounts, hourlyResult, extractionResult] = await Promise.all([
      pool.query('SELECT reward_type, COUNT(*)::int FROM referrals WHERE is_active = true GROUP BY reward_type ORDER BY count DESC'),
      pool.query('SELECT unnest(sources) AS source, COUNT(*)::int FROM referrals WHERE is_active = true GROUP BY source ORDER BY count DESC'),
      pool.query("SELECT COUNT(*)::int FROM referrals WHERE discovered_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE reward_type != 'unknown')::int FROM referrals"),
    ])

    const html = renderDashboard({
      totalActive: health.totalActive,
      discoveredToday: health.discoveredToday,
      discovered24h: hourlyResult.rows[0]?.count ?? 0,
      cseUsed,
      queuePending: queue.size,
      queueActive: queue.active,
      degradedFeeds,
      typeCounts: typeCounts.rows,
      sourceCounts: sourceCounts.rows,
      extractionTotal: extractionResult.rows[0]?.count ?? 0,
      extractionSuccess: extractionResult.rows[0]?.count_filtered ?? 0,
      feedHealth: getFeedHealth(),
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
    return
  } catch (err) {
    res.status(500).json({ error: 'dashboard error' })
    return
  }
})

function renderDashboard(stats: Record<string, unknown>): string {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Referral Discovery - Admin</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:0 auto;padding:20px;background:#0d1117;color:#c9d1d9}h1{color:#58a6ff}h2{color:#f0f6fc;margin-top:30px;border-bottom:1px solid #30363d;padding-bottom:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px}.card .label{font-size:12px;color:#8b949e;text-transform:uppercase}.card .value{font-size:24px;font-weight:bold;color:#58a6ff}.success{color:#3fb950}.warn{color:#d29922}.error{color:#f85149}.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;margin:2px}.badge-ok{background:#033a16;color:#3fb950}.badge-degraded{background:#3d2800;color:#d29922}.badge-error{background:#3d0000;color:#f85149}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{text-align:left;padding:8px;border-bottom:1px solid #30363d}th{color:#8b949e;font-size:12px;text-transform:uppercase}</style></head><body><h1>Referral Discovery Admin</h1><div class="grid"><div class="card"><div class="label">Active Referrals</div><div class="value">' + stats.totalActive + '</div></div><div class="card"><div class="label">Discovered Today</div><div class="value">' + stats.discoveredToday + '</div></div><div class="card"><div class="label">Discovered 24h</div><div class="value">' + stats.discovered24h + '</div></div><div class="card"><div class="label">CSE Quota Used</div><div class="value">' + stats.cseUsed + ' / 100</div></div><div class="card"><div class="label">Queue</div><div class="value">' + stats.queuePending + ' pending / ' + stats.queueActive + ' active</div></div></div>' + renderFeedHealth(stats) + '</body></html>'
}

function renderFeedHealth(stats: Record<string, unknown>): string {
  const degraded = stats.degradedFeeds as string[]
  let html = '<h2>RSS Feed Health</h2>'
  if (degraded.length > 0) {
    html += '<p class="warn">Degraded feeds: ' + degraded.join(', ') + '</p>'
  } else {
    html += '<p class="success">All feeds healthy</p>'
  }
  return html
}

export default router
