import pino from 'pino'
import { correlation } from './correlation.js'
import { config } from './config.js'

export const logger = pino({
  level: config.LOG_LEVEL,
  formatters: {
    level(label) {
      return { level: label }
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    return { requestId: correlation.getRequestId() }
  },
})
