export async function retry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; minTimeout?: number; factor?: number } = {},
): Promise<T> {
  const { retries = 3, minTimeout = 1000, factor = 2 } = options
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt === retries) break
      const delay = minTimeout * factor ** attempt
      await new Promise(r => setTimeout(r, delay))
    }
  }

  throw lastError
}
