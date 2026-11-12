// =============================================================================
// Code Shadow — path matching for Change Contracts
// =============================================================================
// Paths arrive as relative POSIX patterns from tools and as absolute
// platform-specific paths from OpenCode events. This module normalizes both
// and implements the glob subset used by contracts: *, **, ?.

export function normalizePathForMatch(value: string): string {
  const unified = value.replace(/\\/g, "/")

  // Keep the root anchor (UNC, POSIX root, or a Windows drive) while resolving
  // "." and ".." lexically. Contract checks must not be bypassable via "./"
  // or "src/../.env".
  let prefix = ""
  let rest = unified
  if (unified.startsWith("//")) {
    prefix = "//"
    rest = unified.slice(2)
  } else if (/^[A-Za-z]:\//.test(unified)) {
    prefix = unified.slice(0, 3) // "C:/"
    rest = unified.slice(3)
  } else if (unified.startsWith("/")) {
    prefix = "/"
    rest = unified.slice(1)
  }

  const stack: string[] = []
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop()
      } else if (!prefix) {
        stack.push("..")
      }
      continue
    }
    stack.push(segment)
  }

  let normalized = prefix + stack.join("/")
  if (!normalized) normalized = "."
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function stripProjectRoot(value: string, projectRoot?: string): string {
  if (!projectRoot) return value
  const root = normalizePathForMatch(projectRoot)
  if (!root) return value
  if (value === root) return ""
  if (value.startsWith(`${root}/`)) return value.slice(root.length + 1)
  return value
}

function escapeRegExp(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

function globToRegExp(pattern: string): RegExp {
  let expression = "^"
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++
        if (pattern[index + 1] === "/") {
          index++
          expression += "(?:.*/)?"
        } else {
          expression += ".*"
        }
      } else {
        expression += "[^/]*"
      }
    } else if (char === "?") {
      expression += "[^/]"
    } else {
      expression += escapeRegExp(char)
    }
  }
  expression += "$"
  return new RegExp(expression, process.platform === "win32" ? "i" : "")
}

/**
 * Returns true when `value` is covered by `pattern`.
 *
 * - `*` / `**` match everything.
 * - A pattern without wildcards matches the path itself or a directory prefix.
 * - `*` matches within one segment, `**` across segments, `?` one character.
 * - `projectRoot` is stripped from absolute values and patterns when possible.
 * - Windows separators and casing are normalized.
 */
export function pathMatches(pattern: string, value: string, projectRoot?: string): boolean {
  if (!pattern || value === undefined || value === null) return false
  let normalizedPattern = normalizePathForMatch(pattern)
  let normalizedValue = normalizePathForMatch(value)
  if (normalizedPattern === "*" || normalizedPattern === "**") return true
  normalizedPattern = stripProjectRoot(normalizedPattern, projectRoot)
  normalizedValue = stripProjectRoot(normalizedValue, projectRoot)
  if (!normalizedPattern) return false
  if (!normalizedPattern.includes("*") && !normalizedPattern.includes("?")) {
    return normalizedValue === normalizedPattern || normalizedValue.startsWith(`${normalizedPattern}/`)
  }
  return globToRegExp(normalizedPattern).test(normalizedValue)
}
