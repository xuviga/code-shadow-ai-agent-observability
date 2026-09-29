#!/usr/bin/env bun
/**
 * Code Shadow Auto-Install
 * Запускается после npm install. Автоматически настраивает OpenCode.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const PLUGINS_DIR = join(CONFIG_DIR, "plugins", "code-shadow")

function findPluginArrayIndex(config: string): number {
  // JSONC may have comments — strip // and /* */ comments for parsing
  const stripped = config
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
  return stripped.indexOf('"plugin"')
}

function addPluginToConfig(config: string): string {
  if (!config.includes('"plugin"')) {
    const lastBrace = config.lastIndexOf("}")
    return config.substring(0, lastBrace) + ',\n  "plugin": ["opencode-code-shadow"]\n' + config.substring(lastBrace)
  }

  const idx = findPluginArrayIndex(config)
  if (idx === -1) {
    const lastBrace = config.lastIndexOf("}")
    return config.substring(0, lastBrace) + ',\n  "plugin": ["opencode-code-shadow"]\n' + config.substring(lastBrace)
  }

  // Find the array that follows this "plugin" key
  const bracketStart = config.indexOf("[", idx)
  if (bracketStart === -1) {
    const lastBrace = config.lastIndexOf("}")
    return config.substring(0, lastBrace) + ',\n  "plugin": ["opencode-code-shadow"]\n' + config.substring(lastBrace)
  }

  // Check if empty array
  const bracketEnd = config.indexOf("]", bracketStart)
  const between = config.substring(bracketStart + 1, bracketEnd).trim()
  if (between === "") {
    return config.substring(0, bracketStart + 1) + '"opencode-code-shadow"' + config.substring(bracketEnd)
  }

  // Non-empty array — prepend
  return config.substring(0, bracketStart + 1) + '"opencode-code-shadow", ' + config.substring(bracketStart + 1)
}

function main() {
  console.log("🕵️ Code Shadow — авто-установка...")

  // 1. Ensure config dir exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
    console.log("  ✓ Создана директория конфигурации")
  }

  // 2. Add plugin to opencode.jsonc if needed
  const configPath = join(CONFIG_DIR, "opencode.jsonc")
  let config: string

  if (existsSync(configPath)) {
    config = readFileSync(configPath, "utf-8")

    if (!config.includes("code-shadow")) {
      config = addPluginToConfig(config)
      writeFileSync(configPath, config, "utf-8")
      console.log("  ✓ Плагин добавлен в opencode.jsonc")
    } else {
      console.log("  ✓ Плагин уже в конфигурации")
    }
  } else {
    writeFileSync(configPath, '{\n  "plugin": ["opencode-code-shadow"]\n}\n', "utf-8")
    console.log("  ✓ Создан opencode.jsonc с плагином")
  }

  // 3. Create empty CRUSH.md if not exists (plugin will fill it on start)
  const crushPath = join(CONFIG_DIR, "CRUSH.md")
  if (!existsSync(crushPath)) {
    writeFileSync(crushPath, "# OpenCode Rules\n\n", "utf-8")
    console.log("  ✓ Создан CRUSH.md")
  }

  console.log("\n✅ Code Shadow установлен!")
  console.log("🔄 Перезапусти OpenCode чтобы активировать плагин.")
  console.log("📊 Статистика появится в правом сайдбаре автоматически.")
}

main()
