import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<string>()

export const correlation = {
  getRequestId: (): string => storage.getStore() ?? 'unknown',
  run: (id: string, fn: () => void) => storage.run(id, fn),
}
