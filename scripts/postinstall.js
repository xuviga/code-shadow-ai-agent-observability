import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(__dirname, "..")
const configDir = join(homedir(), ".config", "opencode")
const pluginsDir = join(configDir, "plugins", "code-shadow")
const tuiSrc = join(pkgDir, "tui-plugin.tsx")
const tuiDest = join(pluginsDir, "tui-plugin.tsx")
const tuiConfig = join(configDir, "tui.json")

try {
  if (!existsSync(tuiSrc)) {
    console.log("[code-shadow] tui-plugin.tsx not found, skipping TUI setup")
    process.exit(0)
  }

  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true })
  }

  const srcMtime = statSync(tuiSrc).mtimeMs
  const needCopy = !existsSync(tuiDest) || statSync(tuiDest).mtimeMs < srcMtime

  if (needCopy) {
    copyFileSync(tuiSrc, tuiDest)
    console.log("[code-shadow] TUI plugin copied to ~/.config/opencode/plugins/code-shadow/")
  }

  if (!existsSync(tuiConfig)) {
    writeFileSync(tuiConfig, JSON.stringify({ plugin: ["./plugins/code-shadow/tui-plugin.tsx"] }, null, 2) + "\n", "utf-8")
    console.log("[code-shadow] tui.json created — TUI sidebar ready on next launch")
  }
} catch (err) {
  console.error("[code-shadow] TUI setup error:", err.message)
}
