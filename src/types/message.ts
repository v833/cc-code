export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

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

export interface UserMessage {
  role: 'user'
  content: string | ContentBlock[]
}

export interface AssistantMessage {
  type: 'assistant'
  content: string | ContentBlock[]
}

export type Message = UserMessage | AssistantMessage

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

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
  | StreamTextEvent // 文字增量
  | StreamToolUseStartEvent // 工具调用开始
  | StreamToolUseInputEvent // 工具参数 JSON 碎片
  | StreamMessageStartEvent // 消息开始
  | StreamMessageDoneEvent // 消息结束（含 usage）
  | StreamErrorEvent // 错误
