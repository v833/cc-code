export function debugLog(scope: string, message: string, details?: Record<string, unknown>): void {
  if (!process.env.CC_AGENT_DEBUG) return
  const timestamp = new Date().toISOString()
  const suffix = details ? ` ${JSON.stringify(details)}` : ''
  console.error(`[cc-agent][${timestamp}][${scope}] ${message}${suffix}`)
}
