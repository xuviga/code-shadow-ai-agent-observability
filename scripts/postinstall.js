import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(__dirname, "..")
const configDir = join(homedir(), ".config", "opencode")
const pluginsDir = join(configDir, "plugins", "code-shadow")
const tuiConfig = join(configDir, "tui.json")
// OpenCode 2 needs the V2 adapter; the V1 panel is a dependency of it, not a
// separate entry (two entries would render two panels).
const tuiEntry = "./plugins/code-shadow/tui-v2.ts"
const legacyTuiEntry = "./plugins/code-shadow/tui-plugin.tsx"

// Both files are copied: tui-v2.ts imports the panel relative to its own
// directory, so they must stay side by side in the installed plugin folder.
const tuiFiles = [
  { name: "tui-plugin.tsx", src: join(pkgDir, "tui-plugin.tsx") },
  { name: "tui-v2.ts", src: join(pkgDir, "src", "tui-v2.ts") },
]

try {
  const available = tuiFiles.filter((file) => existsSync(file.src))
  if (available.length === 0) {
    console.log("[code-shadow] TUI sources not found, skipping TUI setup")
    process.exit(0)
  }
  if (available.length < tuiFiles.length) {
    const missing = tuiFiles.filter((file) => !existsSync(file.src)).map((file) => file.name)
    console.warn(`[code-shadow] missing TUI source(s): ${missing.join(", ")}`)
  }

  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true })
  }

  for (const file of available) {
    const dest = join(pluginsDir, file.name)
    const needCopy = !existsSync(dest) || statSync(dest).mtimeMs < statSync(file.src).mtimeMs
    if (needCopy) {
      copyFileSync(file.src, dest)
      console.log(`[code-shadow] ${file.name} copied to ~/.config/opencode/plugins/code-shadow/`)
    }
  }

  if (!existsSync(tuiConfig)) {
    writeFileSync(tuiConfig, JSON.stringify({ plugin: [tuiEntry] }, null, 2) + "\n", "utf-8")
    console.log("[code-shadow] tui.json created - TUI sidebar ready on next launch")
  } else {
    // Merge instead of overwriting an existing TUI config. Invalid JSON is left
    // untouched so a hand-written jsonc file is never destroyed.
    let parsed
    try {
      parsed = JSON.parse(readFileSync(tuiConfig, "utf-8"))
    } catch (parseError) {
      console.warn(
        `[code-shadow] tui.json is not valid JSON, leaving it unchanged: ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`,
      )
      parsed = null
    }

    if (parsed !== null) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        console.warn("[code-shadow] tui.json has an unexpected shape, leaving it unchanged")
      } else {
        const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : []
        // Exactly one Code Shadow entry: drop the legacy V1 panel and any
        // duplicate of the V2 adapter, keep every other plugin untouched.
        const withoutOurs = plugins.filter((entry) => entry !== legacyTuiEntry && entry !== tuiEntry)
        const merged = [...withoutOurs, tuiEntry]
        const changed =
          merged.length !== plugins.length ||
          merged.some((entry, index) => entry !== plugins[index]) ||
          !Array.isArray(parsed.plugin)

        if (changed) {
          parsed.plugin = merged
          writeFileSync(tuiConfig, JSON.stringify(parsed, null, 2) + "\n", "utf-8")
          const notes = []
          if (plugins.includes(legacyTuiEntry)) notes.push("legacy tui-plugin.tsx entry removed")
          if (!plugins.includes(tuiEntry)) notes.push("tui-v2.ts entry added")
          console.log(`[code-shadow] tui.json updated: ${notes.join(", ") || "plugin list normalized"}`)
        }
      }
    }
  }
} catch (err) {
  console.error("[code-shadow] TUI setup error:", err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
