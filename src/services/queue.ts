import { logger } from '../logger.js'
import { fetch } from './fetcher.js'
import { extract } from './extractor.js'
import { storeReferral } from './deduper.js'

interface Job {
  url: string
  source: string
  meta: {
    reddit_post_id?: string
    reddit_score?: number
    reddit_comments?: number
    feed_guid?: string
    search_query?: string
  }
}

const LOW_MAX = 500
const HIGH_MAX = 50
const CONCURRENCY = 3
const TIMEOUT_MS = 30_000

class PriorityQueue {
  private high: Array<Job> = []
  private low: Array<Job> = []
  private processing = 0

  enqueue(item: Job, priority: 'high' | 'low' = 'low'): boolean {
    const target = priority === 'high' ? this.high : this.low
    const max = priority === 'high' ? HIGH_MAX : LOW_MAX
    if (target.length >= max) {
      logger.warn({ queueType: priority, size: target.length }, 'queue full')
      return false
    }
    target.push(item)
    this.drain()
    return true
  }

  private async drain() {
    while (this.processing < CONCURRENCY) {
      const item = this.high.shift() ?? this.low.shift()
      if (!item) break
      this.processing++
      this.process(item).finally(() => {
        this.processing--
        this.drain()
      })
    }
  }

  private async process(item: Job) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const { html } = await fetch(item.url, { signal: controller.signal })
      const extracted = await extract(html, item.url)
      if (!extracted) return
      // UK filter check happens upstream before enqueue; store directly
      await storeReferral(
        item.url,
        extracted,
        item.source,
        'unknown', // UK signal should be passed from upstream
        item.meta.reddit_post_id,
        item.meta.reddit_score,
        item.meta.reddit_comments,
      )
    } catch (err) {
      logger.warn({ err, url: item.url }, 'queue processing failed')
    } finally {
      clearTimeout(timer)
    }
  }

  get size() { return this.high.length + this.low.length }
  get active() { return this.processing }
}

export const queue = new PriorityQueue()
