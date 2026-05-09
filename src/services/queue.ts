import { logger } from '../logger.js'
import { fetch } from './fetcher.js'
import { extract } from './extractor.js'
import { storeReferral } from './deduper.js'
import { enqueueJob, dequeueJobs, completeJob, retryOrDeadLetter, recoverStuckQueueJobs, updateSubmissionStatus, type QueueJob } from '../db/queries.js'

const CONCURRENCY = 3
const POLL_INTERVAL_MS = 5_000
const TIMEOUT_MS = 30_000

class DurableQueue {
  private processing = 0
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      const stuck = await recoverStuckQueueJobs()
      if (stuck.length > 0) {
        logger.info({ count: stuck.length }, 'recovered stuck queue jobs')
      }
    } catch (err) {
      logger.warn({ err }, 'queue recovery failed')
    }

    this.poll()
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
    logger.info({ concurrency: CONCURRENCY, pollInterval: POLL_INTERVAL_MS }, 'durable queue started')
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    logger.info('queue stopped')
  }

  private async poll(): Promise<void> {
    if (!this.running) return

    while (this.processing < CONCURRENCY) {
      const jobs = await dequeueJobs(1)
      if (jobs.length === 0) break

      const job = jobs[0]!
      this.processing++
      this.processJob(job).finally(() => {
        this.processing--
      })
    }
  }

  private async processJob(job: QueueJob): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const { html } = await fetch(job.url, { signal: controller.signal })
      const extracted = await extract(html, job.url)
      if (!extracted) {
        await completeJob(job.id)
        return
      }

      const storedId = await storeReferral(
        job.url,
        extracted,
        job.source,
        job.uk_signal ?? 'unknown',
        job.reddit_post_id,
        job.reddit_score,
        job.reddit_comments,
      )

      await completeJob(job.id)

      if (job.submission_id && storedId) {
        await updateSubmissionStatus(job.submission_id, 'processed', storedId)
      }
    } catch (err) {
      const errMsg = String(err)
      logger.warn({ err, url: job.url, jobId: job.id }, 'queue job failed')

      const result = await retryOrDeadLetter(job.id, errMsg)

      if (result === 'dead') {
        logger.warn({ url: job.url, jobId: job.id, attempts: job.attempts }, 'job moved to dead letter queue')
        if (job.submission_id) {
          await updateSubmissionStatus(job.submission_id, 'rejected', null, errMsg)
        }
      } else if (result === 'retry') {
        await enqueueJob({
          url: job.url,
          source: job.source,
          priority: job.attempts >= 2 ? 'low' : job.priority,
          ukSignal: job.uk_signal,
          redditPostId: job.reddit_post_id,
          redditScore: job.reddit_score,
          redditComments: job.reddit_comments,
          submissionId: job.submission_id ?? undefined,
        })
      }
    } finally {
      clearTimeout(timer)
    }
  }

  get size(): number {
    return this.processing
  }

  get active(): number {
    return this.processing
  }
}

export const queue = new DurableQueue()

export async function enqueueJobToDb(
  url: string,
  source: string,
  priority: 'high' | 'low' = 'low',
  ukSignal?: string,
  redditPostId?: string | null,
  redditScore?: number | null,
  redditComments?: number | null,
  submissionId?: string | null,
): Promise<string> {
  return enqueueJob({
    url,
    source,
    priority,
    ukSignal,
    redditPostId,
    redditScore,
    redditComments,
    submissionId,
  })
}
