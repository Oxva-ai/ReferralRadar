import { createHash } from 'node:crypto'

export function computeContentHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[£$€]\s?[\d,.]+/g, 'XXX')
    .replace(/[\d,]+/g, 'N')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
  return createHash('sha256').update(normalized).digest('hex')
}
