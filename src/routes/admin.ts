import { Router, type Request, type Response } from 'express'
import { pool } from '../db/pool.js'
import { getHealthStats } from '../db/queries.js'
import { queue } from '../services/queue.js'
import { getDegradedFeeds } from '../workers/rss.js'

import { run as runSearch } from '../workers/search.js'
import { run as runBrandSearch } from '../workers/brand-search.js'
import { run as runReddit, runTertiary as runRedditTertiary } from '../workers/reddit.js'
import { run as runCompetitor } from '../workers/competitor.js'
import { run as runRssPrimary, runSecondary as runRssSecondary, runTertiary as runRssTertiary } from '../workers/rss.js'
import { run as runPageMonitor } from '../workers/page-monitor.js'
import { run as runVerifier } from '../workers/verifier.js'
import { run as runUrlGuesser } from '../workers/url-guesser.js'
import { runRescore, runEngagementAggregation } from '../workers/rescore.js'

const router = Router()

//---- admin auth middleware ------------------------------------------------
router.use('/admin', (req: Request, res: Response, next) => {
  if (!req.isAdmin) {
    res.status(401).json({ error: 'admin access required' })
    return
  }
  next()
})

//---- worker name → fn map -------------------------------------------------
type WorkerFn = () => Promise<void>
const workerMap: Record<string, WorkerFn> = {
  search: runSearch,
  'brand-search': runBrandSearch,
  reddit: runReddit,
  'reddit-tertiary': runRedditTertiary,
  competitor: runCompetitor,
  'rss-primary': runRssPrimary,
  'rss-secondary': runRssSecondary,
  'rss-tertiary': runRssTertiary,
  'page-monitor': runPageMonitor,
  verifier: runVerifier,
  'url-guesser': runUrlGuesser,
  rescore: runRescore,
  'rescore-engage': runEngagementAggregation,
}

const workerLocks = new Set<string>()

//---- blocklist table init -------------------------------------------------
let blocklistTableReady = false
async function ensureBlockedDomainsTable(): Promise<void> {
  if (blocklistTableReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_domains (
      domain TEXT PRIMARY KEY,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  blocklistTableReady = true
}

//======== API ENDPOINTS ====================================================

// POST /admin/workers/:name/restart
router.post('/admin/workers/:name/restart', async (req: Request, res: Response) => {
  const name = param(req.params.name)
  const fn = workerMap[name]
  if (!fn) {
    res.status(404).json({ error: 'worker_not_found' })
    return
  }
  if (workerLocks.has(name)) {
    res.status(409).json({ error: 'worker_already_running' })
    return
  }

  workerLocks.add(name)
  fn().finally(() => workerLocks.delete(name))

  res.status(202).json({ status: 'started', worker: name })
})

// GET /admin/workers/:name
router.get('/admin/workers/:name', async (req: Request, res: Response) => {
  const name = param(req.params.name)
  try {
    const result = await pool.query(
      `SELECT id, worker_name, started_at, finished_at, status, items_processed, items_discovered, error_message
       FROM worker_runs WHERE worker_name = $1 ORDER BY started_at DESC LIMIT 50`,
      [name],
    )
    res.json({ data: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'internal_error' })
  }
})

// PATCH /admin/referrals/:id
router.patch('/admin/referrals/:id', async (req: Request, res: Response) => {
  const id = param(req.params.id)
  const { company_name, reward, category } = req.body ?? {}
  if (!company_name && !reward && !category) {
    res.status(400).json({ error: 'no fields to update' })
    return
  }

  try {
    const sets: string[] = []
    const vals: unknown[] = []
    let idx = 1

    if (company_name !== undefined) {
      sets.push(`company_name = $${idx++}`)
      vals.push(company_name)
    }
    if (reward !== undefined) {
      sets.push(`reward = $${idx++}`)
      vals.push(reward)
    }
    if (category !== undefined) {
      sets.push(`category = $${idx++}`)
      vals.push(category)
    }
    sets.push(`updated_at = NOW()`)
    vals.push(id)

    const result = await pool.query(
      `UPDATE referrals SET ${sets.join(', ')} WHERE id = $${idx} AND is_active = true RETURNING id, company_name, reward, category`,
      vals,
    )
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json({ status: 'ok', data: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'internal_error' })
  }
})

// DELETE /admin/referrals/:id
router.delete('/admin/referrals/:id', async (req: Request, res: Response) => {
  const id = param(req.params.id)
  try {
    const result = await pool.query(
      'UPDATE referrals SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true RETURNING id',
      [id],
    )
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json({ status: 'deleted', id })
  } catch (err) {
    res.status(500).json({ error: 'internal_error' })
  }
})

// POST /admin/referrals/batch-categorize
router.post('/admin/referrals/batch-categorize', async (req: Request, res: Response) => {
  const { ids, category } = req.body ?? {}
  if (!Array.isArray(ids) || ids.length === 0 || typeof category !== 'string' || !category.trim()) {
    res.status(400).json({ error: 'ids (array) and category (string) required' })
    return
  }

  try {
    const result = await pool.query(
      `UPDATE referrals SET category = $1, updated_at = NOW()
       WHERE id = ANY($2::uuid[]) AND is_active = true RETURNING id`,
      [category.trim(), ids],
    )
    res.json({ status: 'ok', updated: result.rowCount })
  } catch (err) {
    res.status(500).json({ error: 'internal_error' })
  }
})

// GET /admin/blocklist
router.get('/admin/blocklist', async (_req: Request, res: Response) => {
  try {
    await ensureBlockedDomainsTable()
    const result = await pool.query<{ domain: string; added_at: string }>(
      'SELECT domain, added_at FROM blocked_domains ORDER BY domain',
    )
    res.json({ data: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'internal_error' })
  }
})

// POST /admin/blocklist
router.post('/admin/blocklist', async (req: Request, res: Response) => {
  const { domain } = req.body ?? {}
  if (typeof domain !== 'string' || !domain.trim()) {
    res.status(400).json({ error: 'domain required' })
    return
  }

  try {
    await ensureBlockedDomainsTable()
    const clean = domain.trim().toLowerCase().replace(/^www\./, '')
    await pool.query(
      'INSERT INTO blocked_domains (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING',
      [clean],
    )
    res.status(201).json({ status: 'added', domain: clean })
  } catch (err) {
    res.status(500).json({ error: 'internal_error' })
  }
})

// DELETE /admin/blocklist/:domain
router.delete('/admin/blocklist/:domain', async (req: Request, res: Response) => {
  const domain = param(req.params.domain)
  try {
    await ensureBlockedDomainsTable()
    const result = await pool.query(
      'DELETE FROM blocked_domains WHERE domain = $1 RETURNING domain',
      [domain],
    )
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json({ status: 'deleted', domain })
  } catch (err) {
    res.status(500).json({ error: 'internal_error' })
  }
})

//---- helpers --------------------------------------------------------------
function param(p: unknown): string {
  if (typeof p === 'string') return p
  if (Array.isArray(p) && p.length > 0) return String(p[0])
  return ''
}

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

//---- dashboard GET --------------------------------------------------------
router.get('/admin/dashboard', async (_req: Request, res: Response) => {
  try {
    const [
      health,
      degradedFeeds,
      recentReferrals,
      categoryBreakdown,
      sourceCounts,
      workers,
      linkCoverage,
      brandCount,
    ] = await Promise.all([
      getHealthStats(),
      Promise.resolve(getDegradedFeeds()),
      pool.query(`
        SELECT * FROM referrals WHERE is_active = true
        ORDER BY discovered_at DESC LIMIT 20
      `),
      pool.query<{ category: string; count: number }>(`
        SELECT COALESCE(category, 'uncategorised') AS category, COUNT(*)::int AS count
        FROM referrals WHERE is_active = true
        GROUP BY category ORDER BY count DESC
      `),
      pool.query<{ source: string; count: number }>(`
        SELECT unnest(sources) AS source, COUNT(*)::int
        FROM referrals WHERE is_active = true
        GROUP BY source ORDER BY count DESC
      `),
      pool.query<{ worker_name: string; started_at: string; finished_at: string | null; status: string; items_processed: number; items_discovered: number; error_message: string | null }>(`
        SELECT DISTINCT ON (worker_name) worker_name, started_at, finished_at, status, items_processed, items_discovered, error_message
        FROM worker_runs ORDER BY worker_name, started_at DESC
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
      serperUsed: 0,
      serperLimit: 83,
      braveUsed: 0,
      braveLimit: 66,
      queuePending: queue.size,
      queueActive: queue.active,
      degradedFeeds,
      linkCoverage: linkCoverage.rows[0] ?? { with_link: 0, total: 0 },
      brands: brandCount.rows[0]?.count ?? 0,
      categories: categoryBreakdown.rows,
      sources: sourceCounts.rows,
      referrals: recentReferrals.rows,
      workers: workers.rows,
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch {
    res.status(500).json({ error: 'dashboard error' })
  }
})

//======== RENDER ===========================================================

interface DashboardData {
  totalActive: number
  discoveredToday: number
  serperUsed: number
  serperLimit: number
  braveUsed: number
  braveLimit: number
  queuePending: number
  queueActive: number
  degradedFeeds: string[]
  linkCoverage: { with_link: number; total: number }
  brands: number
  categories: Array<{ category: string; count: number }>
  sources: Array<{ source: string; count: number }>
  referrals: Array<Record<string, unknown>>
  workers: Array<Record<string, unknown>>
}

function renderDashboard(d: DashboardData): string {
  const lc = d.linkCoverage
  const linkPct = pct(lc.with_link, lc.total)

  // Stats cards
  const cards = [
    { label: 'Active referrals', value: d.totalActive },
    { label: 'Discovered today', value: d.discoveredToday },
    { label: 'With referral link', value: `${linkPct}% (${lc.with_link}/${lc.total})` },
    { label: 'Distinct brands', value: d.brands },
  ]
  let cardsHtml = ''
  for (const c of cards) {
    cardsHtml += `<div class="card"><div class="label">${esc(c.label)}</div><div class="value">${esc(c.value)}</div></div>`
  }

  // Status row
  const queueColor = d.queuePending > 300 ? 'status-error' : d.queuePending > 100 ? 'status-warn' : 'status-ok'
  const statusRow = `<div class="status-row">
    <span>Queue: <strong class="${queueColor}">${d.queuePending} pending</strong> / ${d.queueActive} active</span>
    <span>Serper: <strong>${d.serperUsed}</strong> / ${d.serperLimit} today</span>
    <span>Brave: <strong>${d.braveUsed}</strong> / ${d.braveLimit} today</span>
    ${d.degradedFeeds.length ? `<span class="warn">Degraded RSS: ${esc(d.degradedFeeds.join(', '))}</span>` : '<span class="success">All RSS feeds healthy</span>'}
  </div>`

  // Category bars
  let categoryHtml = ''
  const maxCat = d.categories.length > 0 ? Math.max(...d.categories.map(c => c.count)) : 1
  for (const cat of d.categories) {
    const barW = Math.max(1, Math.round((cat.count / maxCat) * 100))
    categoryHtml += `<div class="bar-row">
      <span class="bar-label">${esc(cat.category)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${barW}%"></div></div>
      <span class="bar-count">${cat.count}</span>
    </div>`
  }

  // Source bars
  let sourceHtml = ''
  const maxSrc = d.sources.length > 0 ? Math.max(...d.sources.map(s => s.count)) : 1
  for (const s of d.sources) {
    const barW = Math.max(1, Math.round((s.count / maxSrc) * 100))
    sourceHtml += `<div class="bar-row">
      <span class="bar-label">${esc(s.source)}</span>
      <div class="bar-track"><div class="bar-fill bar-src" style="width:${barW}%"></div></div>
      <span class="bar-count">${s.count}</span>
    </div>`
  }

  // Referral rows
  let referralRows = ''
  for (const r of d.referrals) {
    const id = String(r.id ?? '')
    const hasLink = r.referral_link != null && String(r.referral_link).length > 0
    const linkIcon = hasLink ? '<span class="link-ok">&check;</span>' : '<span class="link-missing">&times;</span>'
    const sourcesArr = (r.sources as string[]) ?? []
    const primarySource = sourcesArr[0] ?? 'unknown'
    const cat = (r.category as string) || '--'

    const dataJson = JSON.stringify({
      id, source_url: r.source_url, domain: r.domain, referral_link: r.referral_link,
      company_name: r.company_name, offer_text: r.offer_text, reward: r.reward,
      reward_numeric: r.reward_numeric, currency: r.currency, friend_reward: r.friend_reward,
      reward_type: r.reward_type, qualifying_spend: r.qualifying_spend, max_referrals: r.max_referrals,
      score: r.score, engagement_score: r.engagement_score, sources: r.sources,
      source_count: r.source_count, uk_signal_strength: r.uk_signal_strength,
      discovered_at: r.discovered_at, last_verified_at: r.last_verified_at, expires_at: r.expires_at,
      verification_failures: r.verification_failures, notes: r.notes, category: r.category,
      is_active: r.is_active, change_type: r.change_type,
    }).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

    referralRows += `<tr class="ref-row" data-id="${esc(id)}" data-json="${dataJson}" data-company="${esc(r.company_name)}" data-reward="${esc(r.reward)}" data-category="${esc(cat)}">
      <td class="cb-col"><input type="checkbox" class="ref-checkbox" data-id="${esc(id)}"></td>
      <td><a class="ref-link" href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.company_name)}</a></td>
      <td>${esc(r.reward)}</td>
      <td class="dim">${esc(cat)}</td>
      <td class="center">${linkIcon}</td>
      <td><span class="source-tag">${esc(primarySource)}</span></td>
      <td class="dim" style="font-size:12px">${new Date(r.discovered_at as string).toLocaleString()}</td>
      <td class="actions-col">
        <button class="btn-sm btn-edit" data-id="${esc(id)}">Edit</button>
        <button class="btn-sm btn-del" data-id="${esc(id)}">Del</button>
      </td>
    </tr>`
  }

  // Worker rows
  let workerRows = ''
  const workerNames = Object.keys(workerMap)
  for (const name of workerNames) {
    const latest = d.workers.find(w => w.worker_name === name)
    const status = latest ? String(latest.status ?? 'never_run') : 'never_run'
    const sClass = status === 'completed' ? 'badge-completed' : status === 'running' ? 'badge-running' : status === 'failed' ? 'badge-failed' : 'badge-dim'
    const isRunning = workerLocks.has(name)
    workerRows += `<tr class="worker-row" data-worker="${esc(name)}">
      <td>${esc(name)}</td>
      <td class="dim">${latest ? timeAgo(latest.started_at as string) : '--'}</td>
      <td class="dim">${latest ? timeAgo(latest.finished_at as string | null) : '--'}</td>
      <td><span class="badge ${sClass}">${isRunning ? 'running' : esc(status)}</span></td>
      <td class="num">${esc(latest?.items_processed ?? '--')}</td>
      <td class="num">${esc(latest?.items_discovered ?? '--')}</td>
      <td><button class="btn-sm btn-run" data-worker="${esc(name)}" ${isRunning ? 'disabled' : ''}>Run Now</button></td>
    </tr>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReferralRadar Admin</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:1100px;margin:0 auto;padding:24px 20px 60px;background:#F8FAFC;color:#1E293B;line-height:1.5}
  h1{color:#0F766E;font-size:20px;font-weight:700;margin-bottom:4px}
  .subtitle{font-size:12px;color:#64748B;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:12px}
  .card{background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;padding:18px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 12px rgba(0,0,0,.03)}
  .card .label{font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  .card .value{font-size:28px;font-weight:700;color:#1E293B}
  .status-row{display:flex;gap:24px;flex-wrap:wrap;font-size:13px;color:#64748B;margin-bottom:8px}
  .status-row strong{font-weight:600}
  .status-ok{color:#0F766E}
  .status-warn{color:#D97706}
  .status-error{color:#DC2626}
  .success{color:#0F766E;font-size:13px}
  .warn{color:#D97706;font-size:13px}

  /* tabs */
  .tab-bar{display:flex;gap:0;border-bottom:2px solid #E2E8F0;margin-bottom:20px}
  .tab-btn{background:none;border:none;color:#64748B;font-size:14px;font-weight:500;padding:10px 20px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:color .15s,border-color .15s}
  .tab-btn:hover{color:#1E293B}
  .tab-btn.active{color:#0F766E;border-bottom-color:#0F766E}
  .tab-panel{display:none}
  .tab-panel.active{display:block}

  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #E2E8F0}
  th{color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;position:sticky;top:0;background:#F8FAFC}
  tr:hover{background:#F8FAFC}
  .dim{color:#64748B}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .center{text-align:center}
  .cb-col{width:30px}
  .actions-col{width:120px;text-align:right;white-space:nowrap}

  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:capitalize}
  .badge-completed{background:rgba(15,118,110,.1);color:#0F766E}
  .badge-running{background:rgba(217,119,6,.1);color:#D97706}
  .badge-failed{background:rgba(220,38,38,.1);color:#DC2626}
  .badge-dim{background:rgba(100,116,139,.08);color:#64748B}
  .badge-never_run{background:rgba(100,116,139,.08);color:#64748B}

  .link-ok{color:#0F766E;font-weight:700;font-size:16px}
  .link-missing{color:#DC2626;font-weight:700;font-size:16px}
  .source-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;background:rgba(15,118,110,.1);color:#0F766E}
  .ref-link{color:#0F766E;text-decoration:none;cursor:pointer}
  .ref-link:hover{text-decoration:underline}

  .bar-row{display:flex;align-items:center;gap:10px;margin:4px 0}
  .bar-label{width:140px;font-size:13px;color:#1E293B;text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{flex:1;height:8px;background:#E2E8F0;border-radius:4px;overflow:hidden}
  .bar-fill{height:100%;background:#0F766E;border-radius:4px;min-width:1px;transition:width .3s}
  .bar-fill.bar-src{background:#D97706}
  .bar-count{width:50px;font-size:13px;color:#64748B;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0}
  .empty{color:#64748B;font-style:italic;font-size:13px;padding:8px 0}

  /* buttons */
  button{cursor:pointer;font-family:inherit;border:1px solid #E2E8F0;border-radius:8px;transition:background .15s,border-color .15s,opacity .15s}
  button:disabled{opacity:.4;cursor:not-allowed}
  .btn-sm{padding:3px 10px;font-size:12px;background:#FFFFFF;color:#1E293B}
  .btn-sm:hover:not(:disabled){background:#F8FAFC}
  .btn-edit{color:#0F766E;border-color:#0F766E;background:#FFFFFF}
  .btn-edit:hover:not(:disabled){background:rgba(15,118,110,.06)}
  .btn-del{color:#DC2626;border-color:#DC2626;background:#FFFFFF;margin-left:4px}
  .btn-del:hover:not(:disabled){background:rgba(220,38,38,.06)}
  .btn-run{color:#0F766E;border-color:#0F766E;background:#FFFFFF}
  .btn-run:hover:not(:disabled){background:rgba(15,118,110,.06)}
  .btn-primary{padding:6px 16px;font-size:13px;background:#0F766E;color:#FFFFFF;border-color:#0F766E}
  .btn-primary:hover:not(:disabled){background:#0D6B63}
  .btn-secondary{padding:6px 16px;font-size:13px;background:#FFFFFF;color:#0F766E;border-color:#0F766E}
  .btn-secondary:hover:not(:disabled){background:rgba(15,118,110,.06)}

  /* toolbar */
  .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
  .toolbar input,.toolbar select{padding:5px 10px;font-size:13px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px;color:#1E293B;font-family:inherit}
  .toolbar input{min-width:200px}
  .toolbar input:focus,.toolbar select:focus{outline:none;border-color:#0F766E;box-shadow:0 0 0 3px rgba(15,118,110,.15)}

  /* modal */
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.4);backdrop-filter:blur(4px);z-index:100;align-items:center;justify-content:center}
  .modal-overlay.open{display:flex}
  .modal{background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;max-width:600px;width:90%;max-height:85vh;overflow-y:auto;padding:24px;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.08)}
  .modal h2{font-size:16px;color:#1E293B;margin-bottom:16px}
  .modal .close{position:absolute;top:12px;right:16px;background:none;border:none;color:#64748B;font-size:22px;line-height:1;cursor:pointer;padding:4px}
  .modal .close:hover{color:#DC2626}
  .modal dl{display:grid;grid-template-columns:140px 1fr;gap:6px 12px;font-size:13px}
  .modal dt{color:#64748B;font-weight:500;text-align:right}
  .modal dd{color:#1E293B;word-break:break-word}
  .modal dd a{color:#0F766E}
  .modal .form-group{margin-bottom:12px}
  .modal .form-group label{display:block;font-size:12px;color:#64748B;margin-bottom:4px;font-weight:500}
  .modal .form-group input,.modal .form-group select{padding:6px 10px;font-size:13px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px;color:#1E293B;font-family:inherit;width:100%}
  .modal .form-group input:focus,.modal .form-group select:focus{outline:none;border-color:#0F766E;box-shadow:0 0 0 3px rgba(15,118,110,.15)}
  .modal .form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .modal .confirm-text{font-size:14px;margin-bottom:16px;color:#1E293B}

  /* side panel */
  .side-panel{position:fixed;top:0;right:0;width:420px;max-width:100%;height:100vh;background:#FFFFFF;border-left:1px solid #E2E8F0;z-index:100;transform:translateX(100%);transition:transform .25s ease;overflow-y:auto;padding:24px;box-shadow:-4px 0 24px rgba(0,0,0,.06)}
  .side-panel.open{transform:translateX(0)}
  .side-panel .close{position:absolute;top:12px;right:16px;background:none;border:none;color:#64748B;font-size:22px;line-height:1;cursor:pointer;padding:4px}
  .side-panel .close:hover{color:#DC2626}
  .side-panel h3{font-size:15px;color:#1E293B;margin-bottom:16px}

  /* toasts */
  .toast-container{position:fixed;bottom:20px;right:20px;z-index:200;display:flex;flex-direction:column;gap:8px}
  .toast{padding:10px 18px;border-radius:8px;font-size:13px;animation:slideIn .25s ease;box-shadow:0 4px 12px rgba(0,0,0,.1);max-width:360px}
  .toast-success{background:rgba(15,118,110,.08);border:1px solid #0F766E;color:#0F766E}
  .toast-error{background:rgba(220,38,38,.08);border:1px solid #DC2626;color:#DC2626}
  @keyframes slideIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:translateX(0)}}

  /* blocklist */
  .bl-domain{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px;margin-bottom:6px;font-size:13px}
  .bl-add{display:flex;gap:8px;margin-top:12px}

  .ref-row{cursor:pointer}

  @media(max-width:768px){
    .side-panel{width:100%}
    .modal{width:95%;padding:16px}
    .modal dl{grid-template-columns:1fr}
    .modal dt{text-align:left}
    th,td{padding:5px 6px;font-size:11px}
    .actions-col{width:auto}
  }
</style>
</head>
<body>

<h1>ReferralRadar</h1>
<div class="subtitle">
  <span>Admin Dashboard</span>
  <button class="btn-sm" id="btn-refresh" title="Reload data">&#x21bb; Refresh</button>
</div>

<div class="tab-bar">
  <button class="tab-btn active" data-tab="overview">Overview</button>
  <button class="tab-btn" data-tab="referrals">Referrals</button>
  <button class="tab-btn" data-tab="workers">Workers</button>
  <button class="tab-btn" data-tab="blocklist">Blocklist</button>
</div>

<!-- OVERVIEW TAB -->
<div class="tab-panel active" id="tab-overview">
  <div class="grid">${cardsHtml}</div>
  <div>${statusRow}</div>
  <h3 style="margin:20px 0 10px;font-size:14px;font-weight:600;color:#1E293B">Category Breakdown</h3>
  ${d.categories.length === 0 ? '<p class="empty">No categories yet.</p>' : categoryHtml}
  <h3 style="margin:20px 0 10px;font-size:14px;font-weight:600;color:#1E293B">Source Breakdown</h3>
  ${d.sources.length === 0 ? '<p class="empty">No sources yet.</p>' : sourceHtml}
</div>

<!-- REFERRALS TAB -->
<div class="tab-panel" id="tab-referrals">
  <div class="toolbar">
    <input type="text" id="ref-search" placeholder="Search referrals...">
    <select id="batch-category">
      <option value="">Batch categorise…</option>
      <option value="banking">Banking</option>
      <option value="investing">Investing</option>
      <option value="utilities">Utilities</option>
      <option value="food_drink">Food &#x26; Drink</option>
      <option value="shopping">Shopping</option>
      <option value="fitness">Fitness</option>
      <option value="travel">Travel</option>
      <option value="crypto">Crypto</option>
      <option value="mobile">Mobile</option>
      <option value="energy">Energy</option>
      <option value="other">Other</option>
      <option value="spam">Spam</option>
    </select>
    <button class="btn-sm" id="btn-categorise">Categorise</button>
  </div>
  ${d.referrals.length === 0
    ? '<p class="empty">No referrals yet.</p>'
    : `<div style="overflow-x:auto"><table>
    <thead><tr><th class="cb-col"><input type="checkbox" id="select-all"></th><th>Company</th><th>Reward</th><th>Category</th><th class="center">Link</th><th>Source</th><th>Discovered</th><th class="actions-col">Actions</th></tr></thead>
    <tbody id="ref-tbody">${referralRows}</tbody></table></div>`}
</div>

<!-- WORKERS TAB -->
<div class="tab-panel" id="tab-workers">
  ${d.workers.length === 0 && workerNames.length === 0
    ? '<p class="empty">No worker runs recorded yet.</p>'
    : `<div style="overflow-x:auto"><table>
    <thead><tr><th>Worker</th><th>Last Start</th><th>Last End</th><th>Status</th><th class="num">Processed</th><th class="num">Discovered</th><th>Action</th></tr></thead>
    <tbody id="worker-tbody">${workerRows}</tbody></table></div>`}
</div>

<!-- BLOCKLIST TAB -->
<div class="tab-panel" id="tab-blocklist">
  <div id="bl-list"><p class="empty">Loading…</p></div>
  <div class="bl-add">
    <input type="text" id="bl-input" placeholder="example.com" style="flex:1;padding:6px 10px;font-size:13px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px;color:#1E293B">
    <button class="btn-primary" id="btn-bl-add">Add Domain</button>
  </div>
</div>

<!-- DETAIL MODAL -->
<div class="modal-overlay" id="detail-overlay">
  <div class="modal" id="detail-modal">
    <button class="close" id="detail-close">&times;</button>
    <h2 id="detail-title"></h2>
    <dl id="detail-dl"></dl>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn-sm btn-edit" id="detail-edit-btn">Edit Fields</button>
    </div>
  </div>
</div>

<!-- EDIT MODAL -->
<div class="modal-overlay" id="edit-overlay">
  <div class="modal" id="edit-modal">
    <button class="close" id="edit-close">&times;</button>
    <h2>Edit Referral</h2>
    <div class="form-group"><label>Company Name</label><input type="text" id="edit-company"></div>
    <div class="form-group"><label>Reward</label><input type="text" id="edit-reward"></div>
    <div class="form-group"><label>Category</label><select id="edit-category">
      <option value="">--</option>
      <option value="banking">Banking</option>
      <option value="investing">Investing</option>
      <option value="utilities">Utilities</option>
      <option value="food_drink">Food &#x26; Drink</option>
      <option value="shopping">Shopping</option>
      <option value="fitness">Fitness</option>
      <option value="travel">Travel</option>
      <option value="crypto">Crypto</option>
      <option value="mobile">Mobile</option>
      <option value="energy">Energy</option>
      <option value="other">Other</option>
      <option value="spam">Spam</option>
    </select></div>
    <div class="form-actions">
      <button class="btn-secondary" id="edit-cancel">Cancel</button>
      <button class="btn-primary" id="edit-save">Save</button>
    </div>
  </div>
</div>

<!-- CONFIRM MODAL -->
<div class="modal-overlay" id="confirm-overlay">
  <div class="modal" id="confirm-modal">
    <button class="close" id="confirm-close">&times;</button>
    <h2>Confirm Delete</h2>
    <p class="confirm-text" id="confirm-text"></p>
    <div class="form-actions">
      <button class="btn-secondary" id="confirm-cancel">Cancel</button>
      <button class="btn-primary" id="confirm-ok" style="background:#DC2626;border-color:#DC2626">Delete</button>
    </div>
  </div>
</div>

<!-- SIDE PANEL -->
<div class="side-panel" id="worker-panel">
  <button class="close" id="panel-close">&times;</button>
  <h3 id="panel-title">Worker History</h3>
  <div id="panel-content" class="dim">Loading…</div>
</div>

<div class="toast-container" id="toast-container"></div>

<script>
(function(){
  const key = new URLSearchParams(window.location.search).get('key')
  function api(path, opts) {
    opts = opts || {}
    opts.headers = opts.headers || {}
    if (key) {
      opts.headers['Authorization'] = 'Bearer ' + key
    }
    opts.credentials = 'same-origin'
    return fetch('/api/v1/' + path, opts)
  }

  //---- toasts ----
  const toastContainer = document.getElementById('toast-container')
  function toast(msg, type) {
    const el = document.createElement('div')
    el.className = 'toast toast-' + type
    el.textContent = msg
    toastContainer.appendChild(el)
    setTimeout(function(){ el.remove() }, 3500)
  }

  //---- tabs ----
  document.querySelectorAll('.tab-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active') })
      document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active') })
      btn.classList.add('active')
      var panel = document.getElementById('tab-' + btn.dataset.tab)
      if (panel) panel.classList.add('active')
      if (btn.dataset.tab === 'blocklist') loadBlocklist()
    })
  })

  //---- refresh ----
  document.getElementById('btn-refresh').addEventListener('click', function(){
    api('admin/dashboard').then(function(r){
      if (!r.ok) { toast('Refresh failed', 'error'); return }
      return r.text()
    }).then(function(html){
      if (!html) return
      document.open()
      document.write(html)
      document.close()
    })
  })

  //---- referrals: search ----
  var refSearch = document.getElementById('ref-search')
  if (refSearch) {
    refSearch.addEventListener('input', function(){
      var q = refSearch.value.toLowerCase()
      document.querySelectorAll('#ref-tbody .ref-row').forEach(function(row){
        var txt = (row.dataset.company + ' ' + row.dataset.reward + ' ' + row.dataset.category).toLowerCase()
        row.style.display = txt.includes(q) ? '' : 'none'
      })
    })
  }

  //---- referrals: select all ----
  var selectAll = document.getElementById('select-all')
  if (selectAll) {
    selectAll.addEventListener('change', function(){
      document.querySelectorAll('.ref-checkbox').forEach(function(cb){ cb.checked = selectAll.checked })
    })
  }

  //---- referrals: batch categorise ----
  document.getElementById('btn-categorise').addEventListener('click', function(){
    var cat = document.getElementById('batch-category').value
    if (!cat) { toast('Select a category first', 'error'); return }
    var ids = []
    document.querySelectorAll('.ref-checkbox:checked').forEach(function(cb){ ids.push(cb.dataset.id) })
    if (ids.length === 0) { toast('Select at least one referral', 'error'); return }
    api('admin/referrals/batch-categorize', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ids:ids, category:cat})
    }).then(function(r){ return r.json() }).then(function(d){
      if (d.status === 'ok') {
        toast('Updated ' + d.updated + ' referrals', 'success')
        setTimeout(function(){ document.getElementById('btn-refresh').click() }, 800)
      } else { toast(d.error || 'Failed', 'error') }
    })
  })

  //---- referrals: row click → detail modal ----
  var detailOverlay = document.getElementById('detail-overlay')
  var detailClose = document.getElementById('detail-close')
  var currentDetailId = null

  detailClose.addEventListener('click', function(){ detailOverlay.classList.remove('open') })
  detailOverlay.addEventListener('click', function(e){ if (e.target === detailOverlay) detailOverlay.classList.remove('open') })

  document.getElementById('ref-tbody')?.addEventListener('click', function(e){
    var row = e.target.closest('.ref-row')
    if (!row) return
    // ignore if clicking a button or checkbox
    if (e.target.closest('button') || e.target.closest('input[type=checkbox]') || e.target.closest('a')) return
    try {
      var data = JSON.parse(row.dataset.json.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    } catch(_) { return }
    currentDetailId = data.id
    document.getElementById('detail-title').textContent = data.company_name || 'Unknown'
    var dl = document.getElementById('detail-dl')
    var rows = [
      ['ID', data.id],
      ['Company', data.company_name],
      ['Reward', data.reward],
      ['Numeric', data.reward_numeric],
      ['Currency', data.currency],
      ['Friend Reward', data.friend_reward],
      ['Type', data.reward_type],
      ['Category', data.category || '--'],
      ['Qualifying Spend', data.qualifying_spend],
      ['Max Referrals', data.max_referrals],
      ['Score', data.score],
      ['Engagement', data.engagement_score],
      ['Change Type', data.change_type],
      ['Sources', Array.isArray(data.sources) ? data.sources.join(', ') : data.sources],
      ['Source Count', data.source_count],
      ['UK Signal', data.uk_signal_strength],
      ['Source URL', data.source_url ? '<a href="'+data.source_url+'" target="_blank">'+data.source_url+'</a>' : '--'],
      ['Referral Link', data.referral_link ? '<a href="'+data.referral_link+'" target="_blank">'+data.referral_link+'</a>' : '--'],
      ['Domain', data.domain],
      ['Offer Text', data.offer_text],
      ['Discovered', data.discovered_at ? new Date(data.discovered_at).toLocaleString() : '--'],
      ['Last Verified', data.last_verified_at ? new Date(data.last_verified_at).toLocaleString() : '--'],
      ['Expires', data.expires_at ? new Date(data.expires_at).toLocaleString() : '--'],
      ['Verif. Failures', data.verification_failures],
      ['Notes', data.notes],
      ['Active', data.is_active ? 'Yes' : 'No'],
    ]
    dl.innerHTML = rows.map(function(r){
      return '<dt>'+r[0]+'</dt><dd>'+(r[1] != null ? String(r[1]) : '--')+'</dd>'
    }).join('')
    detailOverlay.classList.add('open')
  })

  //---- detail → edit button ----
  document.getElementById('detail-edit-btn').addEventListener('click', function(){
    if (!currentDetailId) return
    var row = document.querySelector('#ref-tbody .ref-row[data-id="'+currentDetailId+'"]')
    if (!row) return
    try {
      var data = JSON.parse(row.dataset.json.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    } catch(_) { return }
    document.getElementById('edit-company').value = data.company_name || ''
    document.getElementById('edit-reward').value = data.reward || ''
    document.getElementById('edit-category').value = data.category || ''
    detailOverlay.classList.remove('open')
    document.getElementById('edit-overlay').classList.add('open')
  })

  //---- edit modal ----
  var editOverlay = document.getElementById('edit-overlay')
  document.getElementById('edit-close').addEventListener('click', function(){ editOverlay.classList.remove('open') })
  editOverlay.addEventListener('click', function(e){ if (e.target === editOverlay) editOverlay.classList.remove('open') })
  document.getElementById('edit-cancel').addEventListener('click', function(){ editOverlay.classList.remove('open') })
  document.getElementById('edit-save').addEventListener('click', function(){
    if (!currentDetailId) return
    var body = {
      company_name: document.getElementById('edit-company').value,
      reward: document.getElementById('edit-reward').value,
      category: document.getElementById('edit-category').value
    }
    api('admin/referrals/' + currentDetailId, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    }).then(function(r){ return r.json() }).then(function(d){
      if (d.status === 'ok') {
        toast('Saved', 'success')
        editOverlay.classList.remove('open')
        setTimeout(function(){ document.getElementById('btn-refresh').click() }, 600)
      } else { toast(d.error || 'Failed', 'error') }
    })
  })

  //---- delete button (inline) ----
  var confirmOverlay = document.getElementById('confirm-overlay')
  var deleteTargetId = null

  document.getElementById('confirm-close').addEventListener('click', function(){ confirmOverlay.classList.remove('open') })
  confirmOverlay.addEventListener('click', function(e){ if (e.target === confirmOverlay) confirmOverlay.classList.remove('open') })
  document.getElementById('confirm-cancel').addEventListener('click', function(){ confirmOverlay.classList.remove('open') })

  document.getElementById('ref-tbody')?.addEventListener('click', function(e){
    var btn = e.target.closest('.btn-del')
    if (!btn) return
    e.stopPropagation()
    var row = e.target.closest('.ref-row')
    deleteTargetId = btn.dataset.id
    var company = row ? (row.dataset.company || 'Unknown') : 'Unknown'
    document.getElementById('confirm-text').textContent = 'Delete "'+company+'"? This will mark the referral as inactive.'
    confirmOverlay.classList.add('open')
  })

  document.getElementById('confirm-ok').addEventListener('click', function(){
    if (!deleteTargetId) return
    api('admin/referrals/' + deleteTargetId, { method: 'DELETE' })
      .then(function(r){ return r.json() }).then(function(d){
        if (d.status === 'deleted') {
          toast('Deleted', 'success')
          confirmOverlay.classList.remove('open')
          setTimeout(function(){ document.getElementById('btn-refresh').click() }, 500)
        } else { toast(d.error || 'Failed', 'error') }
      })
  })

  //---- edit button (inline) ----
  document.getElementById('ref-tbody')?.addEventListener('click', function(e){
    var btn = e.target.closest('.btn-edit')
    if (!btn) return
    e.stopPropagation()
    currentDetailId = btn.dataset.id
    var row = document.querySelector('#ref-tbody .ref-row[data-id="'+currentDetailId+'"]')
    if (!row) return
    try {
      var data = JSON.parse(row.dataset.json.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    } catch(_) { return }
    document.getElementById('edit-company').value = data.company_name || ''
    document.getElementById('edit-reward').value = data.reward || ''
    document.getElementById('edit-category').value = data.category || ''
    editOverlay.classList.add('open')
  })

  //---- workers: run now ----
  document.getElementById('worker-tbody')?.addEventListener('click', function(e){
    var btn = e.target.closest('.btn-run')
    if (!btn || btn.disabled) return
    e.stopPropagation()
    var name = btn.dataset.worker
    api('admin/workers/' + name + '/restart', { method: 'POST' })
      .then(function(r){ return r.json() }).then(function(d){
        if (d.status === 'started') {
          toast('Worker "'+name+'" started', 'success')
          btn.disabled = true
          setTimeout(function(){ document.getElementById('btn-refresh').click() }, 1500)
        } else { toast(d.error || 'Failed', 'error') }
      })
  })

  //---- workers: click row → side panel ----
  var workerPanel = document.getElementById('worker-panel')
  document.getElementById('panel-close').addEventListener('click', function(){ workerPanel.classList.remove('open') })

  document.getElementById('worker-tbody')?.addEventListener('click', function(e){
    if (e.target.closest('button')) return
    var row = e.target.closest('.worker-row')
    if (!row) return
    var name = row.dataset.worker
    document.getElementById('panel-title').textContent = 'History: ' + name
    document.getElementById('panel-content').textContent = 'Loading…'
    workerPanel.classList.add('open')
    api('admin/workers/' + name).then(function(r){ return r.json() }).then(function(d){
      var data = d.data || []
      if (data.length === 0) {
        document.getElementById('panel-content').innerHTML = '<p class="empty">No run history.</p>'
        return
      }
      var html = '<table><thead><tr><th>Status</th><th>Started</th><th>Ended</th><th class="num">Proc.</th><th class="num">Disc.</th><th>Error</th></tr></thead><tbody>'
      data.forEach(function(run){
        var sClass = run.status === 'completed' ? 'badge-completed' : run.status === 'running' ? 'badge-running' : run.status === 'failed' ? 'badge-failed' : 'badge-dim'
        html += '<tr><td><span class="badge '+sClass+'">'+run.status+'</span></td>' +
          '<td class="dim">'+new Date(run.started_at).toLocaleString()+'</td>' +
          '<td class="dim">'+(run.finished_at ? new Date(run.finished_at).toLocaleString() : '--')+'</td>' +
          '<td class="num">'+run.items_processed+'</td>' +
          '<td class="num">'+run.items_discovered+'</td>' +
          '<td class="dim" style="max-width:150px;overflow:hidden;text-overflow:ellipsis">'+(run.error_message || '--')+'</td></tr>'
      })
      html += '</tbody></table>'
      document.getElementById('panel-content').innerHTML = html
    })
  })

  //---- blocklist ----
  function loadBlocklist() {
    api('admin/blocklist').then(function(r){ return r.json() }).then(function(d){
      var list = d.data || []
      var el = document.getElementById('bl-list')
      if (list.length === 0) { el.innerHTML = '<p class="empty">No blocked domains.</p>'; return }
      el.innerHTML = list.map(function(entry){
        return '<div class="bl-domain"><span>'+entry.domain+'</span><button class="btn-sm btn-del" data-domain="'+entry.domain+'">Remove</button></div>'
      }).join('')
    })
  }

  document.getElementById('btn-bl-add').addEventListener('click', function(){
    var input = document.getElementById('bl-input')
    var domain = input.value.trim()
    if (!domain) { toast('Enter a domain', 'error'); return }
    api('admin/blocklist', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({domain:domain})
    }).then(function(r){ return r.json() }).then(function(d){
      if (d.status === 'added') { toast('Added '+d.domain, 'success'); input.value = ''; loadBlocklist() }
      else { toast(d.error || 'Failed', 'error') }
    })
  })

  document.getElementById('bl-list').addEventListener('click', function(e){
    var btn = e.target.closest('.btn-del')
    if (!btn) return
    var domain = btn.dataset.domain
    if (!confirm('Remove '+domain+' from blocklist?')) return
    api('admin/blocklist/' + encodeURIComponent(domain), { method: 'DELETE' })
      .then(function(r){ return r.json() }).then(function(d){
        if (d.status === 'deleted') { toast('Removed '+d.domain, 'success'); loadBlocklist() }
        else { toast(d.error || 'Failed', 'error') }
      })
  })

  //---- keyboard ----
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') {
      detailOverlay.classList.remove('open')
      editOverlay.classList.remove('open')
      confirmOverlay.classList.remove('open')
      workerPanel.classList.remove('open')
    }
  })

  // blocklist input enter key
  document.getElementById('bl-input')?.addEventListener('keydown', function(e){
    if (e.key === 'Enter') document.getElementById('btn-bl-add').click()
  })

})()
</script>
</body></html>`
}

export default router
