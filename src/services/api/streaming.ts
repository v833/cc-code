import type Anthropic from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js'
import { getAnthropicClient, DEFAULT_MODEL, DEFAULT_MAX_TOKENS } from './client.js'
import type {
  AssistantMessage,
  ContentBlock,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
  Usage
} from '../../types/message.js'

export interface StreamRequestParams {
  messages: MessageParam[]
  model?: string
  maxTokens?: number
  system?: string
  tools?: Anthropic.Tool[]
  signal?: AbortSignal
}

// ─── Streaming Result ──────────────────────────────────────────────

export interface StreamResult {
  assistantMessage: AssistantMessage
  usage: Usage
  stopReason: string
}

export async function* streamMessage(
  params: StreamRequestParams
): AsyncGenerator<StreamEvent, StreamResult> {
  const client = getAnthropicClient()
  const model = params.model ?? DEFAULT_MODEL
  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS

  const requestParams: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: maxTokens,
    messages: params.messages,
    stream: true,
    ...(params.system && { system: params.system }),
    ...(params.tools && params.tools.length > 0 && { tools: params.tools })
  }

  const stream = client.messages.stream(requestParams, {
    signal: params.signal
  })

  const contentBlocks: ContentBlock[] = []
  let currentBlockIndex = -1
  let currentToolInputJson = ''
  let messageId = ''
  let stopReason = ''

  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0
  }
  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          messageId = event.message.id
          if (event.message.usage) {
            // 计算输入令牌数和输出令牌数
            usage.input_tokens = event.message.usage.input_tokens
            usage.output_tokens = event.message.usage.output_tokens
          }
          yield { type: 'message_start', messageId }
          break
        }

        case 'message_delta': {
          if (event.usage) {
            usage.output_tokens = event.usage.output_tokens
          }
          stopReason = event.delta.stop_reason ?? ''
          break
        }

        case 'message_stop': {
          yield { type: 'message_done', usage, stopReason }
          break
        }

        case 'content_block_start': {
          currentBlockIndex = event.index

          if (event.content_block.type === 'text') {
            contentBlocks[currentBlockIndex] = {
              type: 'text',
              text: ''
            }
          } else if (event.content_block.type === 'tool_use') {
            const block = event.content_block
            contentBlocks[currentBlockIndex] = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: {}
            }
            currentToolInputJson = ''
            yield { type: 'tool_use_start', id: block.id, name: block.name }
          }
          break
        }

        case 'content_block_delta': {
          const delta = event.delta

          if (delta.type === 'text_delta') {
            const block = contentBlocks[event.index] as TextBlock
            block.text += delta.text
            yield { type: 'text', text: delta.text }
          } else if (delta.type === 'input_json_delta') {
            currentToolInputJson += delta.partial_json
            yield {
              type: 'tool_use_input',
              id: (contentBlocks[currentBlockIndex] as ToolUseBlock).id,
              partial_json: delta.partial_json
            }
          }
          break
        }

        case 'content_block_stop': {
          const block = contentBlocks[event.index]
          if (block && block.type === 'tool_use' && currentToolInputJson) {
            try {
              block.input = JSON.parse(currentToolInputJson)
            } catch (error) {
              block.input = { _raw: currentToolInputJson }
            }
            currentToolInputJson = ''
          }
          break
        }
      }
    }
  } catch (error) {
    yield {
      type: 'error',
      error: error instanceof Error ? error : new Error(String(error))
    }
  }

  return {
    assistantMessage: {
      type: 'assistant',
      content: contentBlocks
    },
    usage,
    stopReason
  }
}
