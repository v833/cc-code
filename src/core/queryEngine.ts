import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import {
  query,
  type AgenticLoopEvent,
  type LoopTerminationReason,
} from "./agenticLoop.js";
import {
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRuleSet,
  type PermissionSettings,
} from "../permissions/permissions.js";
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";
import { formatProjectSessionHistory } from "../session/history.js";
import { getToolsApiParams } from "../tools/index.js";
import type { ToolContext } from "../tools/Tool.js";
import type { Usage } from "../types/message.js";

/**
 * QueryEngine 是“多轮会话编排层”：
 * - 负责维护整段会话 messages / usage / 当前模型
 * - 处理 slash command
 * - 为单次用户输入创建并消费 agentic loop
 *
 * 可以把它理解成 UI 和核心自治循环之间的桥。
 */
export type QueryEngineEvent =
  | AgenticLoopEvent
  | { type: "messages_updated"; messages: MessageParam[] }
  | { type: "usage_updated"; totalUsage: Usage; turnUsage: Usage }
  | { type: "command"; message: string; kind: "info" | "error" }
  | { type: "model_changed"; model: string; source: "default" | "session" }
  | { type: "session_cleared" };

export interface QueryEngineOptions {
  model: string;
  toolContext: ToolContext;
  initialMessages?: MessageParam[];
  initialUsage?: Usage;
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
}

export interface QueryEngineState {
  messages: MessageParam[];
  totalUsage: Usage;
  model: string;
  modelSource: "default" | "session";
}

function createEmptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

export class QueryEngine {
  private messages: MessageParam[];
  private totalUsage: Usage;
  private readonly defaultModel: string;
  private sessionModelOverride: string | null = null;
  private readonly toolContext: ToolContext;
  private readonly permissionMode?: PermissionMode;
  private readonly permissionSettings?: PermissionSettings;
  private readonly sessionPermissionRules?: PermissionRuleSet;
  private readonly onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  private abortController: AbortController | null = null;

  constructor(options: QueryEngineOptions) {
    this.messages = [...(options.initialMessages ?? [])];
    this.totalUsage = { ...(options.initialUsage ?? createEmptyUsage()) };
    this.defaultModel = options.model;
    this.toolContext = options.toolContext;
    this.permissionMode = options.permissionMode;
    this.permissionSettings = options.permissionSettings;
    this.sessionPermissionRules = options.sessionPermissionRules;
    this.onPermissionRequest = options.onPermissionRequest;
  }

  getState(): QueryEngineState {
    return {
      messages: [...this.messages],
      totalUsage: { ...this.totalUsage },
      model: this.getActiveModel(),
      modelSource: this.getModelSource(),
    };
  }

  interrupt(): boolean {
    if (!this.abortController) {
      return false;
    }
    this.abortController.abort();
    this.abortController = null;
    return true;
  }

  async *submitMessage(
    input: string,
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean; reason?: LoopTerminationReason }> {
    const trimmed = input.trim();
    if (!trimmed) {
      return { handled: false };
    }

    if (trimmed.startsWith("/")) {
      return yield* this.handleCommand(trimmed);
    }

    const userMessage: MessageParam = { role: "user", content: trimmed };
    this.messages = [...this.messages, userMessage];
    yield { type: "messages_updated", messages: [...this.messages] };

    // 每次用户提交都创建独立的 AbortController，保证当前轮可以被 Ctrl+C 中断。
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const systemParts = await buildSystemPrompt({ cwd: this.toolContext.cwd });
      const systemPrompt = renderSystemPrompt(systemParts);
      const tools = getToolsApiParams();

      // QueryEngine 只负责“为本次输入装配上下文并启动 loop”，
      // 不直接介入流式解析或工具执行细节。
      const loop = query({
        messages: [...this.messages],
        systemPrompt,
        tools,
        model: this.getActiveModel(),
        abortSignal: abortController.signal,
        toolContext: {
          ...this.toolContext,
          abortSignal: abortController.signal,
        },
        permissionMode: this.permissionMode,
        permissionSettings: this.permissionSettings,
        sessionPermissionRules: this.sessionPermissionRules,
        onPermissionRequest: this.onPermissionRequest,
      });

      while (true) {
        const { value, done } = await loop.next();
        if (done) {
          // 只有 loop 真正结束后，才把本轮累计出来的消息和 token usage 提交到会话状态。
          this.messages = [...value.state.messages];
          this.totalUsage = {
            input_tokens: this.totalUsage.input_tokens + value.usage.input_tokens,
            output_tokens: this.totalUsage.output_tokens + value.usage.output_tokens,
          };
          yield { type: "messages_updated", messages: [...this.messages] };
          yield {
            type: "usage_updated",
            totalUsage: { ...this.totalUsage },
            turnUsage: { ...value.usage },
          };
          return { handled: true, reason: value.reason };
        }

        yield value;

        switch (value.type) {
          case "assistant_message":
          case "tool_result_message":
            this.messages = [...this.messages, value.message];
            yield { type: "messages_updated", messages: [...this.messages] };
            break;
          default:
            break;
        }
      }
    } finally {
      this.abortController = null;
    }
  }

  private getActiveModel(): string {
    return this.sessionModelOverride ?? this.defaultModel;
  }

  private getModelSource(): "default" | "session" {
    return this.sessionModelOverride ? "session" : "default";
  }

  private async *handleCommand(command: string): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const [name, ...args] = command.slice(1).split(/\s+/).filter(Boolean);

    // 命令统一在 QueryEngine 内消费，UI 只负责展示结果，不直接理解命令语义。
    switch (name) {
      case "help":
        yield {
          type: "command",
          kind: "info",
          message: "Commands: /help /clear /cost /model [name|default] /history /exit /quit /bye",
        };
        return { handled: true };
      case "clear":
        this.messages = [];
        yield { type: "session_cleared" };
        yield { type: "messages_updated", messages: [] };
        yield { type: "command", kind: "info", message: "Conversation cleared." };
        return { handled: true };
      case "cost":
        yield {
          type: "command",
          kind: "info",
          message: `Session usage\n- Input tokens: ${this.totalUsage.input_tokens}\n- Output tokens: ${this.totalUsage.output_tokens}\n- Total tokens: ${this.totalUsage.input_tokens + this.totalUsage.output_tokens}`,
        };
        return { handled: true };
      case "model": {
        const nextModel = args.join(" ").trim();

        if (!nextModel) {
          yield {
            type: "command",
            kind: "info",
            message: [
              "Model status",
              `- Active model: ${this.getActiveModel()}`,
              `- Source: ${this.getModelSource()}`,
              `- Default model: ${this.defaultModel}`,
              this.sessionModelOverride ? `- Session override: ${this.sessionModelOverride}` : "- Session override: none",
              "- Usage: /model <name> to override for this session",
              "- Usage: /model default to clear the override",
            ].join("\n"),
          };
          return { handled: true };
        }

        if (nextModel === "default") {
          this.sessionModelOverride = null;
          const activeModel = this.getActiveModel();
          yield { type: "model_changed", model: activeModel, source: "default" };
          yield {
            type: "command",
            kind: "info",
            message: [
              "Model updated",
              `- Active model: ${activeModel}`,
              "- Source: default",
              "- Session override cleared",
            ].join("\n"),
          };
          return { handled: true };
        }

        this.sessionModelOverride = nextModel;
        yield { type: "model_changed", model: nextModel, source: "session" };
        yield {
          type: "command",
          kind: "info",
          message: [
            "Model updated",
            `- Active model: ${nextModel}`,
            "- Source: session",
            `- Default model remains: ${this.defaultModel}`,
          ].join("\n"),
        };
        return { handled: true };
      }
      case "history":
        yield {
          type: "command",
          kind: "info",
          message: await formatProjectSessionHistory(this.toolContext.cwd),
        };
        return { handled: true };
      default:
        yield {
          type: "command",
          kind: "error",
          message: `Unknown command: /${name}. Try /help.`,
        };
        return { handled: true };
    }
  }
}
