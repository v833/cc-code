/**
 * Tool Registry — Central registry for all available tools.
 *
 * 这里把“搜索、读写文件、执行 shell”明确拆成独立工具，而不是全部塞进 Bash：
 * - 模型更容易学会什么时候该用 Read / Grep / Glob
 * - 权限层可以更精细地区分只读与可写操作
 * - UI 也能更准确地展示工具语义
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "./Tool.js";
import { toolToApiParam } from "./Tool.js";
import { bashTool } from "./bashTool.js";
import { fileEditTool } from "./fileEditTool.js";
import { fileReadTool } from "./fileReadTool.js";
import { fileWriteTool } from "./fileWriteTool.js";
import { globTool } from "./globTool.js";
import { grepTool } from "./grepTool.js";

const ALL_TOOLS: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  globTool,
  grepTool,
  bashTool,
];

export function getAllTools(): Tool[] {
  // 统一从注册表过滤启用状态，避免上层关心单个工具是否可用。
  return ALL_TOOLS.filter((tool) => tool.isEnabled());
}

export function findToolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

export function getToolsApiParams(): Anthropic.Tool[] {
  return getAllTools().map(toolToApiParam);
}
