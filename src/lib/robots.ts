// This is a stub for robots.txt checking.
// The robots-parser package requires fetching the robots.txt file first.
// For now, we implement a minimal check.

export async function isAllowedByRobots(_url: string, _userAgent: string): Promise<boolean> {
  // In production, fetch domain/robots.txt and parse with robots-parser.
  // For Phase 1, we implement basic per-domain rate limiting instead.
  return true
}
