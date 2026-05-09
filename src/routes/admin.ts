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
    const [health, cseUsed, degradedFeeds, recentReferrals, categoryBreakdown, sourceCounts, recentWorkers, linkCoverage, brandCount] =
      await Promise.all([
        getHealthStats(),
        getCseQuotaUsed(),
        Promise.resolve(getDegradedFeeds()),
        pool.query(`
          SELECT company_name, reward, reward_type, referral_link, sources, discovered_at, category
          FROM referrals WHERE is_active = true
          ORDER BY discovered_at DESC LIMIT 20
        `),
        pool.query<{ category: string; count: number }>(`
          SELECT COALESCE(category, 'uncategorised') AS category, COUNT(*)::int AS count
          FROM referrals WHERE is_active = true
          GROUP BY category
          ORDER BY count DESC
        `),
        pool.query<{ source: string; count: number }>(`
          SELECT unnest(sources) AS source, COUNT(*)::int
          FROM referrals WHERE is_active = true
          GROUP BY source ORDER BY count DESC
        `),
        pool.query<{ worker_name: string; started_at: string; finished_at: string | null; status: string; items_processed: number; items_discovered: number; error_message: string | null }>(`
          SELECT worker_name, started_at, finished_at, status, items_processed, items_discovered, error_message
          FROM worker_runs ORDER BY started_at DESC LIMIT 20
        `),
        pool.query<{ with_link: number; total: number }>(`
          SELECT
            COUNT(*) FILTER (WHERE referral_link IS NOT NULL)::int AS with_link,
            COUNT(*)::int AS total
          FROM referrals WHERE is_active = true
        `),
        pool.query<{ count: number }>(`
          SELECT COUNT(DISTINCT company_name)::int AS count
          FROM referrals WHERE is_active = true AND company_name IS NOT NULL
        `),
      ])

    const html = renderDashboard({
      totalActive: health.totalActive,
      discoveredToday: health.discoveredToday,
      cseUsed,
      queuePending: queue.size,
      queueActive: queue.active,
      degradedFeeds,
      linkCoverage: linkCoverage.rows[0] ?? { with_link: 0, total: 0 },
      brands: brandCount.rows[0]?.count ?? 0,
      categories: categoryBreakdown.rows,
      sources: sourceCounts.rows,
      referrals: recentReferrals.rows,
      workers: recentWorkers.rows,
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

function timeAgo(ts: string | null): string {
  if (!ts) return '--'
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0
}

function renderDashboard(stats: Record<string, unknown>): string {
  const referrals = (stats.referrals as Array<Record<string, unknown>>) ?? []
  const sources = (stats.sources as Array<Record<string, unknown>>) ?? []
  const categories = (stats.categories as Array<Record<string, unknown>>) ?? []
  const workers = (stats.workers as Array<Record<string, unknown>>) ?? []
  const lc = stats.linkCoverage as { with_link: number; total: number } | undefined
  const linkPct = lc ? pct(lc.with_link, lc.total) : 0
  const linkCount = lc?.with_link ?? 0
  const linkTotal = lc?.total ?? 0
  const queuePending = (stats.queuePending as number) ?? 0
  const queueActive = (stats.queueActive as number) ?? 0
  const cseUsed = (stats.cseUsed as number) ?? 0
  const degradedFeeds = (stats.degradedFeeds as string[]) ?? []

  // ---- section builders ----

  // Stats cards
  const cards = [
    { label: 'Active referrals', value: stats.totalActive, klass: '' },
    { label: 'Discovered today', value: stats.discoveredToday, klass: '' },
    { label: 'With referral link', value: `${linkPct}% (${linkCount}/${linkTotal})`, klass: '' },
    { label: 'Distinct brands', value: stats.brands, klass: '' },
  ]
  let cardsHtml = ''
  for (const c of cards) {
    cardsHtml += `<div class="card"><div class="label">${esc(c.label)}</div><div class="value">${esc(c.value)}</div></div>`
  }

  // Queue & CSE status row
  let statusRow = ''
  {
    const csePct = Math.min(100, Math.round((cseUsed / 100) * 100))
    const cseColor = cseUsed > 80 ? 'status-error' : cseUsed > 50 ? 'status-warn' : 'status-ok'
    const queueColor = queuePending > 300 ? 'status-error' : queuePending > 100 ? 'status-warn' : 'status-ok'
    statusRow = `<div class="status-row">
      <span>Queue: <strong class="${queueColor}">${queuePending} pending</strong> / ${queueActive} active</span>
      <span>CSE quota: <strong class="${cseColor}">${cseUsed}</strong> / 100 today</span>
      ${degradedFeeds.length ? `<span class="warn">Degraded RSS: ${esc(degradedFeeds.join(', '))}</span>` : '<span class="success">All RSS feeds healthy</span>'}
    </div>`
  }

  // Worker table
  let workerRows = ''
  for (const w of workers) {
    const status = String(w.status ?? '')
    const sClass = status === 'completed' ? 'status-ok' : status === 'running' ? 'status-warn' : 'status-error'
    workerRows += `<tr>
      <td>${esc(w.worker_name)}</td>
      <td class="dim">${timeAgo(w.started_at as string)}</td>
      <td class="dim">${timeAgo(w.finished_at as string | null)}</td>
      <td><span class="badge badge-${status}">${esc(status)}</span></td>
      <td class="num">${esc(w.items_processed)}</td>
      <td class="num">${esc(w.items_discovered)}</td>
    </tr>`
  }

  // Category bars
  let categoryHtml = ''
  const maxCatCount = categories.length > 0 ? Math.max(...categories.map(c => Number(c.count) || 0)) : 1
  for (const cat of categories) {
    const count = Number(cat.count) || 0
    const barW = Math.max(1, Math.round((count / maxCatCount) * 100))
    const label = String(cat.category ?? 'uncategorised')
    categoryHtml += `<div class="bar-row">
      <span class="bar-label">${esc(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${barW}%"></div></div>
      <span class="bar-count">${count}</span>
    </div>`
  }

  // Source breakdown
  let sourceHtml = ''
  const maxSrcCount = sources.length > 0 ? Math.max(...sources.map(s => Number(s.count) || 0)) : 1
  for (const s of sources) {
    const count = Number(s.count) || 0
    const barW = Math.max(1, Math.round((count / maxSrcCount) * 100))
    sourceHtml += `<div class="bar-row">
      <span class="bar-label">${esc(s.source)}</span>
      <div class="bar-track"><div class="bar-fill bar-src" style="width:${barW}%"></div></div>
      <span class="bar-count">${count}</span>
    </div>`
  }

  // Referral rows
  let referralRows = ''
  for (const r of referrals) {
    const hasLink = r.referral_link != null && String(r.referral_link).length > 0
    const linkIcon = hasLink ? '<span class="link-ok">&check;</span>' : '<span class="link-missing">&times;</span>'
    const sourcesArr = (r.sources as string[]) ?? []
    const primarySource = sourcesArr[0] ?? 'unknown'
    const cat = (r.category as string) || '--'
    referralRows += `<tr>
      <td>${esc(r.company_name)}</td>
      <td>${esc(r.reward)}</td>
      <td class="dim">${esc(cat)}</td>
      <td class="center">${linkIcon}</td>
      <td><span class="source-tag">${esc(primarySource)}</span></td>
      <td class="dim" style="font-size:12px">${new Date(r.discovered_at as string).toLocaleString()}</td>
    </tr>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>ReferralRadar Admin</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px 20px;background:#0d1117;color:#c9d1d9;line-height:1.5}
  h1{color:#58a6ff;font-size:20px;margin-bottom:4px}
  .subtitle{font-size:12px;color:#8b949e;margin-bottom:20px}
  h2{color:#f0f6fc;font-size:15px;margin:24px 0 10px;border-bottom:1px solid #30363d;padding-bottom:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:12px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px}
  .card .label{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  .card .value{font-size:28px;font-weight:700;color:#58a6ff}
  .status-row{display:flex;gap:24px;flex-wrap:wrap;font-size:13px;color:#8b949e;margin-bottom:8px}
  .status-row strong{font-weight:600}
  .status-ok{color:#3fb950}
  .status-warn{color:#d29922}
  .status-error{color:#f85149}
  .success{color:#3fb950;font-size:13px}
  .warn{color:#d29922;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #21262d}
  th{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
  tr:hover{background:rgba(88,166,255,.04)}
  .dim{color:#8b949e}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .center{text-align:center}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:capitalize}
  .badge-completed{background:rgba(63,185,80,.15);color:#3fb950}
  .badge-running{background:rgba(210,153,34,.15);color:#d29922}
  .badge-failed{background:rgba(248,81,73,.15);color:#f85149}
  .link-ok{color:#3fb950;font-weight:700;font-size:16px}
  .link-missing{color:#f85149;font-weight:700;font-size:16px}
  .source-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;background:rgba(88,166,255,.12);color:#58a6ff}
  .bar-row{display:flex;align-items:center;gap:10px;margin:4px 0}
  .bar-label{width:140px;font-size:13px;color:#c9d1d9;text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{flex:1;height:8px;background:#21262d;border-radius:4px;overflow:hidden}
  .bar-fill{height:100%;background:linear-gradient(90deg,#58a6ff,#3fb950);border-radius:4px;min-width:1px;transition:width .3s}
  .bar-fill.bar-src{background:linear-gradient(90deg,#d29922,#f0883e)}
  .bar-count{width:50px;font-size:13px;color:#8b949e;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0}
  .empty{color:#8b949e;font-style:italic;font-size:13px;padding:8px 0}
  .footer{font-size:11px;color:#484f58;margin-top:28px;text-align:center}
  .refresh-note{display:inline-block;margin-left:6px}
</style>
</head>
<body>
<h1>ReferralRadar</h1>
<p class="subtitle">Admin Dashboard &mdash; <span class="dim" id="countdown">refreshing in 60s</span></p>

<h2>Overview</h2>
<div class="grid">${cardsHtml}</div>
<div>${statusRow}</div>

<h2>Worker Status</h2>
${workers.length === 0
  ? '<p class="empty">No worker runs recorded yet.</p>'
  : `<table>
  <thead><tr><th>Worker</th><th>Started</th><th>Finished</th><th>Status</th><th class="num">Processed</th><th class="num">Discovered</th></tr></thead>
  <tbody>${workerRows}</tbody></table>`}

<h2>Category Breakdown</h2>
${categories.length === 0
  ? '<p class="empty">No categories yet.</p>'
  : categoryHtml}

<h2>Source Breakdown</h2>
${sources.length === 0
  ? '<p class="empty">No sources yet.</p>'
  : sourceHtml}

<h2>Recent Referrals (${referrals.length})</h2>
${referrals.length === 0
  ? '<p class="empty">No referrals yet.</p>'
  : `<table>
  <thead><tr><th>Company</th><th>Reward</th><th>Category</th><th class="center">Link</th><th>Source</th><th>Discovered</th></tr></thead>
  <tbody>${referralRows}</tbody></table>`}

<p class="footer">Auto-refreshes every 60 seconds &middot; <span id="timer">60</span>s until next refresh</p>
<script>
  let secs = 60
  const el = document.getElementById('timer')
  setInterval(() => { secs--; if (el) el.textContent = secs; if (secs <= 0) secs = 60 }, 1000)
</script>
</body></html>`
}

export default router
