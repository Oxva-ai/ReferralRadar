import { Router, type Request, type Response } from 'express'
import { pool } from '../db/pool.js'
import { getHealthStats, getCseQuotaUsed } from '../db/queries.js'
import { queue } from '../services/queue.js'
import { getDegradedFeeds } from '../workers/rss.js'

const router = Router()

router.get('/admin/dashboard', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const health = await getHealthStats()
    const cseUsed = await getCseQuotaUsed()
    const degradedFeeds = getDegradedFeeds()

    const [recentReferrals, sourceCounts] = await Promise.all([
      pool.query(`
        SELECT company_name, reward, reward_type, referral_link, sources, discovered_at
        FROM referrals WHERE is_active = true
        ORDER BY discovered_at DESC LIMIT 50
      `),
      pool.query(`
        SELECT unnest(sources) AS source, COUNT(*)::int
        FROM referrals WHERE is_active = true
        GROUP BY source ORDER BY count DESC
      `),
    ])

    const html = renderDashboard({
      totalActive: health.totalActive,
      discoveredToday: health.discoveredToday,
      discovered24h: health.discoveredToday,
      cseUsed,
      queuePending: queue.size,
      queueActive: queue.active,
      degradedFeeds,
      sources: sourceCounts.rows,
      referrals: recentReferrals.rows,
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
    return
  } catch (err) {
    res.status(500).json({ error: 'dashboard error' })
    return
  }
})

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderDashboard(stats: Record<string, unknown>): string {
  const referrals = (stats.referrals as Array<Record<string, unknown>>) ?? []
  const sources = (stats.sources as Array<Record<string, unknown>>) ?? []

  let rows = ''
  for (const r of referrals) {
    const sourcesArr = (r.sources as string[]) ?? []
    const sourceBadge = sourcesArr[0] ?? 'unknown'
    rows += `<tr>
      <td>${esc(r.company_name)}</td>
      <td>${esc(r.reward)}</td>
      <td><span class="badge">${esc(r.reward_type)}</span></td>
      <td style="font-size:12px">${esc(sourceBadge)}</td>
      <td style="font-size:12px;color:#8b949e">${new Date(r.discovered_at as string).toLocaleString()}</td>
    </tr>`
  }

  let sourceList = ''
  for (const s of sources) {
    sourceList += `<span class="badge badge-ok">${esc(s.source)}: ${s.count}</span> `
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Referral Discovery - Admin</title>
<style>
body{font-family:system-ui,sans-serif;max-width:960px;margin:0 auto;padding:20px;background:#0d1117;color:#c9d1d9}
h1{color:#58a6ff}h2{color:#f0f6fc;margin-top:24px;border-bottom:1px solid #30363d;padding-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:14px}
.card .label{font-size:11px;color:#8b949e;text-transform:uppercase}
.card .value{font-size:22px;font-weight:bold;color:#58a6ff}
.success{color:#3fb950}.warn{color:#d29922}.error{color:#f85149}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;margin:2px}
.badge-ok{background:#033a16;color:#3fb950}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d}
th{color:#8b949e;font-size:11px;text-transform:uppercase}
tr:hover{background:#161b22}
</style>
</head>
<body>
<h1>ReferralRadar</h1>
<div class="grid">
  <div class="card"><div class="label">Active</div><div class="value">${stats.totalActive}</div></div>
  <div class="card"><div class="label">Today</div><div class="value">${stats.discoveredToday}</div></div>
  <div class="card"><div class="label">Queue</div><div class="value">${stats.queuePending} / ${stats.queueActive}</div></div>
  <div class="card"><div class="label">Searches Used</div><div class="value">${stats.cseUsed} / 100</div></div>
</div>
<p style="font-size:12px;color:#8b949e">Sources: ${sourceList}</p>
${(stats.degradedFeeds as string[])?.length ? '<p class="warn">Degraded RSS: ' + esc(stats.degradedFeeds) + '</p>' : '<p class="success">All RSS feeds healthy</p>'}
<h2>Recent Referrals (${referrals.length})</h2>
<table>
<thead><tr><th>Company</th><th>Reward</th><th>Type</th><th>Source</th><th>Discovered</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" style="color:#8b949e">No referrals yet</td></tr>'}</tbody>
</table>
<p style="font-size:11px;color:#484f58;margin-top:20px">Auto-refreshes every 60 seconds</p>
</body></html>`
}

export default router
