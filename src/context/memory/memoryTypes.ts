/**
 * Agent 允许持久化保存的记忆分类。
 *
 * 这里刻意将取值控制在一个很小且固定的集合里，方便提示词层和写入工具
 * 在分类记忆时共享同一套稳定语义，避免出现自由扩展后难以约束的类型漂移。
 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * 每个记忆 markdown 文件 frontmatter 中保存的结构化元数据。
 *
 * `name` 是给人读的标题，`description` 是展示在索引中的一句话摘要，
 * `type` 则用于驱动提示词层对这条记忆的使用方式。
 */
export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
}

/**
 * `MEMORY.md` 中使用的最小索引条目。
 *
 * 入口索引只保留轻量级指针，目的是让 agent 能先快速浏览记忆清单，
 * 再决定要不要继续读取完整文档，而不是一开始就把所有内容都塞进上下文。
 */
export interface MemoryEntry {
  fileName: string
  filePath: string
  title: string
  hook: string
}

/**
 * 运行时类型守卫，用于校验从 frontmatter 或工具输入中解析出的类型值。
 */
export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && MEMORY_TYPES.includes(value as MemoryType)
}

/**
 * 生成提示词中的记忆校验规则，告诉模型应该如何判断一条记忆是否可用。
 *
 * 这些规则的核心目标是保证记忆长期可用且足够可信：
 * 只存储难以从仓库直接恢复的事实，并且在真正依赖涉及路径或符号名的记忆前，
 * 先回到当前代码状态中进行复核。
 */
export function buildMemoryValidationGuidance(): string[] {
  return [
    'Project memory stores only facts that cannot be derived reliably from the current repo state.',
    'Do not save code structure, file contents, or facts that can be re-read from the workspace.',
    'If the user says to ignore memory, proceed as if project memory were empty.',
    'Before relying on a memory that names a file path, check that the file still exists.',
    'Before relying on a memory that names a function, flag, or symbol, grep or read the current code to confirm it still exists.'
  ]
}
