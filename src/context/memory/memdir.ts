import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MemoryEntry, MemoryFrontmatter, MemoryType } from './memoryTypes.js'
import { isMemoryType } from './memoryTypes.js'

/**
 * 基于文件的项目记忆存储在仓库之外，路径形如
 * `~/.cc-agent/projects/<project-key>/memory`.
 *
 * 这个模块主要负责：
 * - 为每个项目解析出稳定的记忆存储目录
 * - 读取并校验 markdown 记忆文档
 * - 维护紧凑的 `MEMORY.md` 入口索引
 * - 针对当前请求挑选少量最相关的记忆
 */
export const MEMORY_ENTRYPOINT = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000
const MAX_RELEVANT_MEMORIES = 5
const CC_AGENT_HOME = path.join(os.homedir(), '.cc-agent')
const PROJECTS_DIR = path.join(CC_AGENT_HOME, 'projects')

/**
 * 完整加载后的记忆文档，既包含索引字段，也包含解析后的正文内容。
 */
export interface MemoryDocument extends MemoryEntry {
  frontmatter: MemoryFrontmatter
  body: string
}

/**
 * 规范化后的项目路径信息，用来把任意 `cwd` 映射回同一个持久化记忆目录。
 */
export interface ProjectPathInfo {
  gitRoot: string
  projectKey: string
  projectDir: string
}

/**
 * 生成可安全用于文件系统路径的 slug，供项目 key 和记忆文件名复用。
 */
function sanitizeSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'project'
  )
}

/**
 * 规范化面向用户展示的单行字段。
 *
 * 这样即使原始文本里存在多余空白，索引条目的展示结果仍然紧凑且稳定。
 */
function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 一个非常轻量的相关性打分函数：统计规范化后的查询词在候选文本中出现了多少次。
 *
 * 这里不追求复杂语义召回，而是优先保证检索过程可预测、低成本。
 */
function scoreTextMatch(haystack: string, terms: string[]): number {
  return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
}

/**
 * 从当前工作目录一路向上查找 `.git` 标记。
 *
 * 如果能找到仓库根目录，就把它作为项目身份的锚点；如果找不到，
 * 则退化为使用当前解析后的 `cwd` 本身来确定记忆存储归属。
 */
async function findCanonicalGitRoot(cwd: string): Promise<string> {
  let current = path.resolve(cwd)

  while (true) {
    try {
      await fs.stat(path.join(current, '.git'))
      return current
    } catch {
      // 当前层级不是仓库根，继续向上回溯。
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return path.resolve(cwd)
    }
    current = parent
  }
}

/**
 * 基于规范化后的 git 根目录生成稳定的项目 key。
 *
 * 可读的 basename 便于人在磁盘上辨认目录，哈希后缀则用于避免不同路径下
 * 同名项目发生冲突。
 */
export async function getProjectPathInfo(cwd: string): Promise<ProjectPathInfo> {
  const gitRoot = await findCanonicalGitRoot(cwd)
  const slugBase = sanitizeSlug(path.basename(gitRoot))
  const suffix = crypto.createHash('sha256').update(gitRoot).digest('hex').slice(0, 16)
  const projectKey = `${slugBase}-${suffix}`
  return {
    gitRoot,
    projectKey,
    projectDir: path.join(PROJECTS_DIR, projectKey)
  }
}

/**
 * 解析与当前 `cwd` 所属项目对应的记忆目录路径。
 */
export async function getProjectMemoryDir(cwd: string): Promise<string> {
  const { projectDir } = await getProjectPathInfo(cwd)
  return path.join(projectDir, 'memory')
}

/**
 * 确保磁盘上的记忆目录和入口索引文件都已存在。
 *
 * 入口文件采用懒创建方式，这样调用方在读取记忆前不需要额外处理“首次运行”
 * 这种特殊分支，只要调用这里就能拿到一个可用目录。
 */
export async function ensureMemoryDirExists(cwd: string): Promise<string> {
  const memoryDir = await getProjectMemoryDir(cwd)
  await fs.mkdir(memoryDir, { recursive: true })
  const entrypoint = path.join(memoryDir, MEMORY_ENTRYPOINT)
  try {
    await fs.access(entrypoint)
  } catch {
    await fs.writeFile(entrypoint, '# Project Memory\n\n', 'utf-8')
  }
  return memoryDir
}

/**
 * 解析记忆文件支持的最小 frontmatter 结构。
 *
 * 这里故意只支持系统真正需要的字段：`name`、`description`、`type`。
 * 一旦字段缺失、格式异常或类型不合法，就返回 `null`，让上层按无效记忆处理。
 */
function parseFrontmatter(raw: string): MemoryFrontmatter | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return null

  const fields = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
  }

  const name = fields.get('name')
  const description = fields.get('description')
  const type = fields.get('type')
  if (!name || !description || !type || !isMemoryType(type)) {
    return null
  }

  return {
    name: normalizeLine(name),
    description: normalizeLine(description),
    type
  }
}

/**
 * 去掉开头的 frontmatter，返回真正的 markdown 正文内容。
 */
function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
}

/**
 * 对 `MEMORY.md` 强制执行大小上限。
 *
 * 入口索引会进入提示词上下文，因此必须受控。这里先按行数截断，再按字节数截断，
 * 并在必要时附带警告，让模型知道自己拿到的是一份被裁剪过的索引。
 */
function truncateEntrypoint(raw: string): { content: string; warning?: string } {
  let content = raw
  let lineTruncated = false
  let byteTruncated = false

  const lines = content.split(/\r?\n/)
  if (lines.length > MAX_ENTRYPOINT_LINES) {
    // 先按整行裁剪，尽量保持 markdown 结构仍然可读。
    content = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    lineTruncated = true
  }

  while (Buffer.byteLength(content, 'utf-8') > MAX_ENTRYPOINT_BYTES && content.length > 0) {
    // 再按字节粒度继续收缩，确保最终不会超出上下文预算上限。
    content = content.slice(0, -1)
    byteTruncated = true
  }

  const warning =
    lineTruncated || byteTruncated
      ? `> WARNING: MEMORY.md was truncated${lineTruncated ? ' by line limit' : ''}${lineTruncated && byteTruncated ? ' and' : ''}${byteTruncated ? ' by byte limit' : ''}.`
      : undefined

  return { content: content.trim(), ...(warning ? { warning } : {}) }
}

/**
 * 把一条记忆条目渲染成入口索引中的单行指针。
 */
function buildPointerLine(entry: MemoryEntry): string {
  return `- [${normalizeLine(entry.title)}](${entry.fileName}) — ${normalizeLine(entry.hook)}`
}

/**
 * 读取会被注入系统提示词的紧凑型记忆索引。
 */
export async function readMemoryEntrypoint(cwd: string): Promise<string | null> {
  const memoryDir = await ensureMemoryDirExists(cwd)
  const entrypoint = path.join(memoryDir, MEMORY_ENTRYPOINT)
  const raw = await fs.readFile(entrypoint, 'utf-8')
  const truncated = truncateEntrypoint(raw)
  return [truncated.content, truncated.warning].filter(Boolean).join('\n\n') || null
}

/**
 * 从磁盘加载全部合法的 markdown 记忆文件。
 *
 * 对于缺少 frontmatter 或 frontmatter 非法的文件，这里会直接忽略，
 * 避免单个损坏文件拖垮整个项目的上下文构建流程。
 */
export async function listMemoryFiles(cwd: string): Promise<MemoryDocument[]> {
  const memoryDir = await ensureMemoryDirExists(cwd)
  const dirents = await fs.readdir(memoryDir, { withFileTypes: true })
  const docs = await Promise.all(
    dirents
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== MEMORY_ENTRYPOINT
      )
      .map(async (entry) => {
        const filePath = path.join(memoryDir, entry.name)
        const raw = await fs.readFile(filePath, 'utf-8')
        const frontmatter = parseFrontmatter(raw)
        // 无效记忆直接跳过，避免把半解析状态暴露给上游调用者。
        if (!frontmatter) return null
        return {
          fileName: entry.name,
          filePath,
          title: frontmatter.name,
          hook: frontmatter.description,
          frontmatter,
          body: stripFrontmatter(raw)
        } satisfies MemoryDocument
      })
  )

  return docs
    .filter((doc): doc is MemoryDocument => doc !== null)
    .sort((a, b) => a.fileName.localeCompare(b.fileName))
}

/**
 * 返回与当前查询最相关的一小组记忆文档。
 *
 * 检索策略刻意保持简单：
 * - 先对查询做规范化和分词
 * - 再根据标题、摘要、正文中的词项重叠做打分
 * - 跳过本轮对话中已经展示过的记忆
 * - 最后限制返回数量，控制提示词膨胀
 */
export async function loadRelevantMemories(
  cwd: string,
  query: string,
  options?: { alreadySurfaced?: ReadonlySet<string>; ignoreMemory?: boolean }
): Promise<string[]> {
  if (options?.ignoreMemory) return []

  const normalizedQuery = normalizeLine(query).toLowerCase()
  if (normalizedQuery.length < 3) return []

  const terms = normalizedQuery.split(/[^a-zA-Z0-9_\-\u4e00-\u9fff]+/).filter(Boolean)
  if (terms.length === 0) return []

  const docs = await listMemoryFiles(cwd)
  const scored = docs
    .filter((doc) => !(options?.alreadySurfaced?.has(doc.fileName) ?? false))
    .map((doc) => {
      // 同时搜索摘要元数据和正文，避免短查询因为关键词只出现在某一侧而漏召回。
      const haystack =
        `${doc.frontmatter.name}\n${doc.frontmatter.description}\n${doc.body}`.toLowerCase()
      return { doc, score: scoreTextMatch(haystack, terms) }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_MEMORIES)

  return scored.map((item) => {
    // 返回“索引头 + 正文”，既保留来源指针，也让模型能看到持久化记录本身。
    const header = buildPointerLine(item.doc)
    return `${header}\n\n${item.doc.body}`.trim()
  })
}

/**
 * 为记忆文档生成默认 markdown 文件名。
 */
function slugifyMemoryFileName(name: string): string {
  return sanitizeSlug(name).replace(/\.+/g, '-') + '.md'
}

/**
 * 根据当前全部记忆条目重建 `MEMORY.md`。
 *
 * 这里把入口文件视为“可再生索引”，因此每次都从规范化条目重新生成，
 * 而不是在旧文件上做增量补丁。
 */
async function rewriteEntrypoint(memoryDir: string, entries: MemoryEntry[]): Promise<void> {
  const entrypointPath = path.join(memoryDir, MEMORY_ENTRYPOINT)
  const unique = new Map<string, string>()
  for (const entry of entries) {
    // 以文件名作为唯一键；若有重复，后写入的同名条目会覆盖前者。
    unique.set(entry.fileName, buildPointerLine(entry))
  }

  const bodyLines = ['# Project Memory', '', ...[...unique.values()]]
  const truncated = truncateEntrypoint(bodyLines.join('\n'))
  const finalText = [truncated.content, truncated.warning].filter(Boolean).join('\n\n') + '\n'
  await fs.writeFile(entrypointPath, finalText, 'utf-8')
}

/**
 * 查找是否已经存在应当被更新的记忆文件，避免生成内容高度相似的重复文档。
 */
async function findExistingMemoryFile(
  cwd: string,
  name: string,
  description: string
): Promise<string | null> {
  const docs = await listMemoryFiles(cwd)
  const normalizedName = normalizeLine(name).toLowerCase()
  const normalizedDescription = normalizeLine(description).toLowerCase()

  const exact = docs.find((doc) => doc.frontmatter.name.toLowerCase() === normalizedName)
  if (exact) return exact.fileName

  const similar = docs.find((doc) => {
    const existing = `${doc.frontmatter.name} ${doc.frontmatter.description}`.toLowerCase()
    return existing.includes(normalizedName) || existing.includes(normalizedDescription)
  })

  return similar?.fileName ?? null
}

/**
 * 持久化写入或更新一条记忆文档，然后重新生成入口索引。
 *
 * 写入路径会统一把元数据整理进 frontmatter，从而保证后续读取阶段面对的
 * 始终是同一种文件结构。
 */
export async function writeProjectMemory(input: {
  cwd: string
  name: string
  description: string
  type: MemoryType
  content: string
  fileName?: string
}): Promise<{ filePath: string; fileName: string; updatedExisting: boolean }> {
  const memoryDir = await ensureMemoryDirExists(input.cwd)
  const existingFileName =
    input.fileName ?? (await findExistingMemoryFile(input.cwd, input.name, input.description))
  const fileName = existingFileName ?? slugifyMemoryFileName(input.name)
  const filePath = path.join(memoryDir, fileName)

  // 真正持久化的事实来源是 markdown 文件本身，索引只是每次写入后再生成的视图。
  const body = [
    '---',
    `name: ${normalizeLine(input.name)}`,
    `description: ${normalizeLine(input.description)}`,
    `type: ${input.type}`,
    '---',
    '',
    input.content.trim(),
    ''
  ].join('\n')

  await fs.writeFile(filePath, body, 'utf-8')
  const docs = await listMemoryFiles(input.cwd)
  // 通过重新解析后的文档来重建入口索引，确保索引始终与磁盘上的 frontmatter 一致。
  await rewriteEntrypoint(
    memoryDir,
    docs.map((doc) => ({
      fileName: doc.fileName,
      filePath: doc.filePath,
      title: doc.frontmatter.name,
      hook: doc.frontmatter.description
    }))
  )

  return { filePath, fileName, updatedExisting: Boolean(existingFileName) }
}

/**
 * 识别用户是否明确要求在当前请求中忽略项目记忆。
 *
 * 这里同时覆盖英文和中文常见说法。
 */
export function shouldIgnoreMemory(query: string): boolean {
  const normalized = query.toLowerCase()
  return [
    'ignore memory',
    "don't use memory",
    'do not use memory',
    '忽略记忆',
    '不要用记忆',
    '别用记忆'
  ].some((term) => normalized.includes(term))
}

/**
 * 生成告诉模型“如何使用这套磁盘记忆机制”的提示词说明。
 *
 * 这些说明会在模型决定读取或写入项目记忆前注入上下文，帮助它遵守这套
 * 文件化记忆约定。
 */
export function buildMemoryPromptInstructions(): string[] {
  return [
    'You have a persistent, file-based project memory system for this project.',
    'Use memory only for information that will be useful in future conversations and cannot be derived directly from the current repo state.',
    'Supported memory types: user, feedback, project, reference.',
    'When saving a memory, write one markdown file with frontmatter: name, description, type.',
    `After writing or updating a memory file, update ${MEMORY_ENTRYPOINT} with a one-line pointer in the form: - [Title](file.md) — one-line hook.`,
    `${MEMORY_ENTRYPOINT} is an index, not a place to store full memory content.`,
    `Keep ${MEMORY_ENTRYPOINT} under ${MAX_ENTRYPOINT_LINES} lines and ${MAX_ENTRYPOINT_BYTES} bytes.`,
    'Before creating a new memory, check whether an existing memory should be updated instead.'
  ]
}
