import * as fs from "node:fs/promises";
import * as path from "node:path";

const GLOBAL_AGENT_MD = path.join(process.env.HOME || "~", ".agent", "AGENT.md");
const AGENT_MD_NAME = "AGENT.md";

/**
 * AGENT.md 读取策略类似“目录继承”：
 * 全局文件 + 从根目录到当前 cwd 的逐级 AGENT.md 都会被拼进上下文。
 */
function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim();
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const raw = await fs.readFile(filePath, "utf-8");
    const stripped = stripHtmlComments(raw).trim();
    return stripped || null;
  } catch {
    return null;
  }
}

function getDirectoryChain(cwd: string): string[] {
  const resolved = path.resolve(cwd);
  const chain: string[] = [];
  let current = resolved;

  // 反向收集到根目录，再 reverse，得到从上到下的覆盖顺序。
  while (true) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return chain.reverse();
}

export async function getAgentMdFiles(cwd: string): Promise<string[]> {
  const files: string[] = [GLOBAL_AGENT_MD];
  for (const dir of getDirectoryChain(cwd)) {
    files.push(path.join(dir, AGENT_MD_NAME));
  }
  return files;
}

export async function loadAgentMdContext(cwd: string): Promise<string> {
  const files = await getAgentMdFiles(cwd);
  const loaded = await Promise.all(
    files.map(async (filePath) => {
      const content = await readIfExists(filePath);
      return content ? { filePath, content } : null;
    }),
  );

  const sections = loaded
    .filter((entry): entry is { filePath: string; content: string } => entry !== null)
    // 保留来源路径，便于模型理解每段规则是全局约束还是项目局部约束。
    .map((entry) => "# Source: " + entry.filePath + "\n" + entry.content);

  return sections.join("\n\n");
}
