import * as fs from 'node:fs'
import * as path from 'node:path'
import dotenv from 'dotenv'

interface ClaudeConfig {
  env?: Record<string, string>
}

function readJsonEnv(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed: ClaudeConfig = JSON.parse(raw)
    if (parsed.env && typeof parsed.env === 'object') {
      return parsed.env
    }
  } catch {
    // File doesn't exist or is invalid JSON — silently skip
  }
  return {}
}

export function loadEnv(): void {
  const home = process.env.HOME || '~'

  const globalConfigEnv = readJsonEnv(path.join(home, '.claude.json'))
  Object.assign(process.env, globalConfigEnv)

  const settingsEnv = readJsonEnv(path.join(home, '.claude', 'settings.json'))
  Object.assign(process.env, settingsEnv)

  dotenv.config({ override: true })
}
