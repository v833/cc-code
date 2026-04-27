import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Usage } from '../types/message.js'

/**
 * 当前模型允许使用的理论上下文窗口上限。
 */
export const MODEL_CONTEXT_WINDOW = 200_000

/**
 * 自动触发 compact 前预留的安全缓冲区。
 *
 * 自动压缩通常发生在对话已经比较接近上限时，因此这里预留更多冗余，
 * 给后续回答、工具结果和额外系统提示留下空间。
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

/**
 * 手动 compact 时预留的安全缓冲区。
 *
 * 手动压缩往往由用户主动触发，可控性更高，因此缓冲区可以比自动压缩更小。
 */
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

/**
 * 普通文本的粗略字符 / token 比例。
 *
 * 这里并不追求精确 tokenizer 行为，而是用一个稳定、廉价的经验值来估算预算。
 */
const TEXT_CHARS_PER_TOKEN = 4

/**
 * JSON 文本的粗略字符 / token 比例。
 *
 * JSON 往往包含更多标点、引号和结构字符，因此这里用更保守的比例估算。
 */
const JSON_CHARS_PER_TOKEN = 2

/**
 * 每条消息本身附带的固定 token 开销估算。
 */
const MESSAGE_OVERHEAD_TOKENS = 12

/**
 * 工具调用块或工具结果块附带的固定 token 开销估算。
 */
const TOOL_BLOCK_OVERHEAD_TOKENS = 24

/**
 * 二进制内容块（如图片、文档）的固定估算值。
 *
 * 这些内容很难仅凭字符数推断，因此直接使用一个经验常量做近似。
 */
const FIXED_BINARY_BLOCK_TOKENS = 2_000

/**
 * 根据“字符数 / token”的经验比例，对一段文本做粗略 token 估算。
 */
function roughTokenCountEstimation(content: string, charsPerToken = TEXT_CHARS_PER_TOKEN): number {
  return Math.max(1, Math.round(content.length / charsPerToken))
}

/**
 * 对未知对象做 JSON 序列化后再估算 token。
 *
 * 这主要用于工具输入、工具结果或其他无法直接按纯文本处理的结构化数据。
 */
function estimateUnknownObjectTokens(value: unknown): number {
  return roughTokenCountEstimation(JSON.stringify(value ?? ''), JSON_CHARS_PER_TOKEN)
}

/**
 * 估算一条消息 `content` 字段对应的 token 数。
 *
 * `MessageParam["content"]` 既可能是纯字符串，也可能是由多个内容块组成的数组，
 * 因此这里需要按 block 类型分别估算。
 */
function estimateContentBlockTokens(content: MessageParam['content']): number {
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }

  if (!Array.isArray(content)) {
    return 0
  }

  return content.reduce((total, block) => {
    switch (block.type) {
      case 'text':
        return total + roughTokenCountEstimation(block.text)
      case 'tool_use':
        return (
          total +
          TOOL_BLOCK_OVERHEAD_TOKENS +
          // 工具名会直接进入请求内容，因此也需要计入预算。
          roughTokenCountEstimation(block.name) +
          // 工具输入通常是结构化对象，用 JSON 方式做近似更稳妥。
          estimateUnknownObjectTokens(block.input)
        )
      case 'tool_result': {
        // 工具结果可能是字符串，也可能是结构化数据，统一先转成可估算的文本表示。
        const serialized =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        return (
          total +
          TOOL_BLOCK_OVERHEAD_TOKENS +
          roughTokenCountEstimation(serialized, JSON_CHARS_PER_TOKEN)
        )
      }
      case 'image':
      case 'document':
        // 二进制块无法像文本一样按字符估算，直接走固定经验值。
        return total + FIXED_BINARY_BLOCK_TOKENS
      default:
        // 对未来新增但当前未知的 block 类型做兜底估算，避免直接漏算。
        return total + estimateUnknownObjectTokens(block)
    }
  }, 0)
}

/**
 * 估算单条消息的总 token 数，包括消息自身固定开销和内容开销。
 */
export function estimateMessageTokens(message: MessageParam): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentBlockTokens(message.content)
}

/**
 * 对整段消息列表做粗略 token 估算。
 *
 * 最后的 `4 / 3` 放大系数用于给整体误差留出安全余量，避免低估后导致上下文预算判断过于乐观。
 */
export function roughTokenCountEstimationForMessages(messages: readonly MessageParam[]): number {
  const rawEstimate = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  return Math.ceil((rawEstimate * 4) / 3)
}

/**
 * 估算 system prompt 本身消耗的 token。
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  return roughTokenCountEstimation(systemPrompt) + MESSAGE_OVERHEAD_TOKENS
}

/**
 * 从服务端返回的 usage 统计中计算总 token 数。
 *
 * 这里会把普通输入、缓存创建输入、缓存命中读取输入以及输出全部加总，
 * 得到一个更接近真实账单口径的总量。
 */
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

/**
 * 结合“真实 usage”与“本地估算”来推断当前对话总 token 数。
 *
 * 如果我们已经拿到某个历史锚点之前的真实 usage，就只对锚点之后的新消息做估算，
 * 这样通常会比从头全量估算更接近真实值。
 */
export function tokenCountWithEstimation(
  messages: readonly MessageParam[],
  options?: { usage?: Usage; usageAnchorIndex?: number; systemPrompt?: string }
): number {
  const systemPromptTokens = options?.systemPrompt
    ? estimateSystemPromptTokens(options.systemPrompt)
    : 0

  if (options?.usage && options.usageAnchorIndex !== undefined && options.usageAnchorIndex >= 0) {
    // 真实 usage 作为前缀基线，只对其后的消息后缀做近似估算。
    const suffix = messages.slice(options.usageAnchorIndex + 1)
    return (
      getTokenCountFromUsage(options.usage) +
      roughTokenCountEstimationForMessages(suffix) +
      systemPromptTokens
    )
  }

  return roughTokenCountEstimationForMessages(messages) + systemPromptTokens
}

/**
 * 当前会话的 token 预算快照。
 *
 * `effectiveContextWindow` 是在理论窗口上限之外再减去一层保守保留区后，
 * 真正用于预算判断的可用窗口。
 */
export interface TokenBudgetSnapshot {
  estimatedConversationTokens: number
  contextWindow: number
  effectiveContextWindow: number
  autoCompactThreshold: number
  manualCompactThreshold: number
}

/**
 * 构建一份用于 UI 或调度逻辑消费的 token 预算快照。
 *
 * 这里同时给出：
 * - 理论上下文窗口
 * - 实际用于判断的保守窗口
 * - 自动 / 手动 compact 的触发阈值
 */
export function buildTokenBudgetSnapshot(
  messages: readonly MessageParam[],
  options?: { usage?: Usage; usageAnchorIndex?: number; systemPrompt?: string }
): TokenBudgetSnapshot {
  const estimatedConversationTokens = tokenCountWithEstimation(messages, options)
  const contextWindow = MODEL_CONTEXT_WINDOW
  // 再额外保留 20k，给回答生成、系统开销以及估算误差预留空间。
  const effectiveContextWindow = contextWindow - 20_000
  return {
    estimatedConversationTokens,
    contextWindow,
    effectiveContextWindow,
    autoCompactThreshold: effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS,
    manualCompactThreshold: effectiveContextWindow - MANUAL_COMPACT_BUFFER_TOKENS
  }
}
