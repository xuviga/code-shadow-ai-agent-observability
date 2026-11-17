import * as path from "node:path"

const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i

function isAbsoluteProjectPath(filePath: string): boolean {
  return (
    WINDOWS_DRIVE_PATH.test(filePath) ||
    filePath.startsWith("/") ||
    filePath.startsWith("\\\\") ||
    path.isAbsolute(filePath)
  )
}

function collapseDuplicateSlashes(value: string): string {
  // Preserve a leading `//` (UNC) instead of collapsing it to a single slash.
  if (value.startsWith("//")) {
    return "//" + value.replace(/^\/+/, "").replace(/\/{2,}/g, "/")
  }
  return value.replace(/\/{2,}/g, "/")
}

/** Absolute, forward-slash path for a project file. */
export function normalizeProjectPath(projectRoot: string, filePath: string): string {
  if (!filePath) return ""
  const absolute = isAbsoluteProjectPath(filePath)
  // Without a project root there is nothing to resolve against; do not invent
  // process.cwd() here (it may be the plugin host directory, not the project).
  if (!absolute && !projectRoot) {
    return collapseDuplicateSlashes(filePath.replace(/\\/g, "/"))
  }
  const resolved = absolute ? filePath : path.resolve(projectRoot, filePath)
  return collapseDuplicateSlashes(resolved.replace(/\\/g, "/"))
}
