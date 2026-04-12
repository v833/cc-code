import Anthropic from '@anthropic-ai/sdk'

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'
export const DEFAULT_MAX_TOKENS = 8096

let clientInstance: Anthropic | null = null

export function getAnthropicClient(options?: { apiKey?: string; baseURL?: string }): Anthropic {
  if (clientInstance && !options) {
    return clientInstance
  }

  const client = new Anthropic({
    apiKey: options?.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN,
    baseURL: options?.baseURL ?? process.env.ANTHROPIC_BASE_URL
  })

  if (!options) {
    clientInstance = client
  }

  return client
}

export async function verifyApiKey(apiKey?: string): Promise<boolean> {
  try {
    const client = getAnthropicClient(apiKey ? { apiKey } : undefined)
    await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }]
    })
    return true
  } catch {
    return false
  }
}

export function resetClient(): void {
  clientInstance = null
}
