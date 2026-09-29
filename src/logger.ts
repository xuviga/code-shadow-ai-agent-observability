// =============================================================================
// Code Shadow — Логгер
// File-based logger writing to ~/.config/opencode/shadow/shadow.log
// Avoids console.log to prevent corrupting the terminal TUI.
// =============================================================================

import * as fs from "node:fs"
import * as path from "node:path"
import { homedir } from "node:os"

const LOG_DIR = path.join(homedir(), ".config", "opencode", "shadow")
const LOG_FILE = path.join(LOG_DIR, "shadow.log")

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

function writeLog(level: string, namespace: string, message: string, ...args: unknown[]): void {
  try {
    const now = new Date()
    const timestamp = now.toISOString().replace("T", " ").replace("Z", "")
    const extra = args.length > 0 ? " " + args.map(a => {
      if (a instanceof Error) return a.message + (a.stack ? "\n" + a.stack : "")
      return typeof a === "object" ? JSON.stringify(a) : String(a)
    }).join(" ") : ""

    const line = `${timestamp.substring(0, 23)} [CodeShadow][${namespace}] [${level}] ${message}${extra}\n`
    fs.appendFileSync(LOG_FILE, line, "utf-8")
  } catch {
    // Silently fail — logging should never crash the plugin
  }
}

export function createLogger(namespace: string) {
  return {
    debug: (message: string, ...args: unknown[]) => writeLog("DEBUG", namespace, message, ...args),
    info: (message: string, ...args: unknown[]) => writeLog("INFO", namespace, message, ...args),
    warn: (message: string, ...args: unknown[]) => writeLog("WARN", namespace, message, ...args),
    error: (message: string, ...args: unknown[]) => writeLog("ERROR", namespace, message, ...args),
  }
}
