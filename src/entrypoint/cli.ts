#!/usr/bin/env node

import { verifyApiKey } from '../services/api/client.js'
import dotenv from 'dotenv'
dotenv.config({ override: true })

const VERSION = '0.0.1'

/**
 * CLI 入口只做三件事：
 * 1. 解析启动参数
 * 2. 按需输出帮助或系统提示词
 * 3. 懒加载 Ink UI，避免纯命令模式也提前加载 React
 */
function main(): void {
  // --version 放在最前面是一个经典的 CLI 设计模式：版本号查询不应该触发任何重量级的模块加载
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(`cc-agent v${VERSION}`)
    process.exit(0)
  }

  // verifyApiKey()

  console.log('Hello, Agent CLI!')
}

main()
