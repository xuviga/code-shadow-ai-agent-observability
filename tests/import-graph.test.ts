import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageEngine } from "../src/storage"
import { extractImportSpecifiers, indexImports } from "../src/import-graph"
import { createAnalyzeTool } from "../src/tools/analyze"
import { EdgeType } from "../src/types"

const databases: Array<{ storage: StorageEngine; directory: string }> = []

const config = {
  dbPath: "",
  retentionDays: 90,
  sessionRetentionDays: 365,
  batchSize: 10,
  flushIntervalMs: 5000,
  riskWarningThreshold: 0.6,
  riskErrorThreshold: 0.8,
  analyticsRecomputeIntervalMs: 3600000,
  maxDiffPreviewChars: 500,
  maxArgsPreviewChars: 200,
  disabledEventTypes: [],
  secretPatterns: [],
}

function createStorage(directory: string): StorageEngine {
  const storage = new StorageEngine({ ...config, dbPath: join(directory, "data.db") })
  databases.push({ storage, directory })
  return storage
}

afterEach(() => {
  while (databases.length > 0) {
    const item = databases.pop()!
    item.storage.close()
    try {
      rmSync(item.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Best-effort cleanup on Windows WAL handles.
    }
  }
})

describe("import graph", () => {
  test("extracts relative and external imports", () => {
    const source = [
      `import { b } from "./b"`,
      `import React from "react"`,
      `export * from "./c"`,
      `const x = require("./d")`,
      `import("./lazy")`,
    ].join("\n")
    expect(extractImportSpecifiers(source).sort()).toEqual(["./b", "./c", "./d", "./lazy", "react"])
  })

  test("indexes file and module nodes with imports edges", () => {
    const directory = mkdtempSync(join(tmpdir(), "code-shadow-imports-"))
    writeFileSync(join(directory, "a.ts"), `import { b } from "./b"\nimport React from "react"\nexport * from "./c"\n`)
    writeFileSync(join(directory, "b.ts"), `export const b = 1\n`)
    writeFileSync(join(directory, "c.ts"), `export const c = 2\n`)
    const storage = createStorage(directory)

    const rootId = indexImports(storage, directory, "a.ts")
    expect(rootId).toBeGreaterThan(0)

    const root = storage.searchNodes("a.ts", 10, directory)[0]
    expect(root.nodeType).toBe("file")
    expect(root.projectRoot).toBe(directory)

    const edges = storage.getEdgesForNode(root.id).filter((edge) => edge.edgeType === EdgeType.Imports)
    expect(edges).toHaveLength(3)
    expect(storage.getDependencyCount("a.ts")).toBe(3)

    const react = storage.searchNodes("react", 10, directory).find((node) => node.nodeType === "module")
    expect(react).toBeTruthy()
    expect(storage.searchNodes("b.ts", 10, directory)[0].nodeType).toBe("file")
  })

  test("dependency_graph returns indexed imports with node types", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-shadow-graph-"))
    writeFileSync(join(directory, "a.ts"), `import { b } from "./b"\nimport React from "react"\nexport * from "./c"\n`)
    writeFileSync(join(directory, "b.ts"), `export const b = 1\n`)
    writeFileSync(join(directory, "c.ts"), `export const c = 2\n`)
    const storage = createStorage(directory)
    const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    const tools = createAnalyzeTool(storage, config as never, log as never)
    const analyze = tools.code_shadow_analyze as {
      execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<{ output: string }>
    }

    const response = await analyze.execute(
      { query: "dependency_graph", target: "a.ts", project_root: directory, depth: 1 },
      { directory },
    )
    const graph = JSON.parse(response.output)
    expect(graph.nodes.some((node: { label: string; type: string }) => node.label === "react" && node.type === "module")).toBe(true)
    expect(graph.nodes.some((node: { id: string; type: string }) => node.id === "b.ts" && node.type === "file")).toBe(true)
    expect(graph.graphSummary).toContain("Импорты: 3")
  })
})
