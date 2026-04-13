/**
 * Anthropic 的 message.content 不是单纯字符串，而是由多个内容块拼成：
 * - text: 模型自然语言输出
 * - tool_use: 模型发起工具调用
 * - tool_result: 工具执行结果回填给模型
 *
 * 这也是整个项目要围绕 ContentBlock[] 来建模的原因。
 */
export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

// ─── Message Types ─────────────────────────────────────────────────

export interface UserMessage {
  role: 'user'
  // 普通用户输入是 string；而工具回填时，role 也是 user，但 content 会是 tool_result block 数组。
  content: string | ContentBlock[]
}

export interface AssistantMessage {
  role: 'assistant'
  // assistant 可以在一条消息里同时“说话 + 调工具”，因此这里同样保留 block 结构。
  content: string | ContentBlock[]
}

export type Message = UserMessage | AssistantMessage

// ─── Usage Tracking ────────────────────────────────────────────────

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// ─── Stream Event Types ────────────────────────────────────────────

export interface StreamTextEvent {
  type: 'text'
  text: string
}

export interface StreamToolUseStartEvent {
  type: 'tool_use_start'
  id: string
  name: string
}

export interface StreamToolUseInputEvent {
  type: 'tool_use_input'
  id: string
  partial_json: string
}

export interface StreamMessageStartEvent {
  type: 'message_start'
  messageId: string
}

export interface StreamMessageDoneEvent {
  type: 'message_done'
  stopReason: string
  usage: Usage
}

export interface StreamErrorEvent {
  type: 'error'
  error: Error
}

export type StreamEvent =
  | StreamTextEvent
  | StreamToolUseStartEvent
  | StreamToolUseInputEvent
  | StreamMessageStartEvent
  | StreamMessageDoneEvent
  | StreamErrorEvent
