import * as path from "node:path";

/**
 * 工具层统一走这里做路径归一化，避免每个工具各自实现 cwd 边界检查。
 */
export function expandHome(filePath: string): string {
  return filePath.startsWith("~")
    ? filePath.replace("~", process.env.HOME || "")
    : filePath;
}

export function resolveSafePath(filePath: string, cwd: string): string {
  return path.resolve(cwd, expandHome(filePath));
}

export function ensureInsideCwd(resolvedPath: string, cwd: string): void {
  const normalizedCwd = path.resolve(cwd);
  const relative = path.relative(normalizedCwd, resolvedPath);
  if (relative === "" || relative === ".") return;
  // path.relative 以 .. 开头，说明目标已经越过当前工作目录边界。
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the current working directory: ${resolvedPath}`);
  }
}

export function resolveWorkspacePath(filePath: string, cwd: string): string {
  const resolvedPath = resolveSafePath(filePath, cwd);
  ensureInsideCwd(resolvedPath, cwd);
  return resolvedPath;
}
