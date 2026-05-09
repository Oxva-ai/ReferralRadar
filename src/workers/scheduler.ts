import cron from 'node-cron'
import { logger } from '../logger.js'

type WorkerFn = () => Promise<void>

const locks = new Map<string, boolean>()

function mutex(key: string, fn: WorkerFn): WorkerFn {
  return async () => {
    if (locks.get(key)) return
    locks.set(key, true)
    try {
      await fn()
    } catch (err) {
      logger.error({ err, worker: key }, 'worker failed')
    } finally {
      locks.set(key, false)
    }
  }
}

const jobs: Array<cron.ScheduledTask> = []

export function schedule(cronExpr: string, name: string, fn: WorkerFn): void {
  const task = cron.schedule(cronExpr, mutex(name, fn))
  jobs.push(task)
  logger.info({ name, cron: cronExpr }, 'scheduled worker')
}

export function scheduleHourly(name: string, fn: WorkerFn): void {
  const task = cron.schedule('0 * * * *', mutex(name, fn))
  jobs.push(task)
  logger.info({ name, cron: '0 * * * *' }, 'scheduled hourly worker')
}

export function start(): void {
  logger.info({ workerCount: jobs.length }, 'scheduler started')
}

export function stop(): void {
  logger.info('stopping scheduler')
  for (const job of jobs) {
    job.stop()
  }
}
