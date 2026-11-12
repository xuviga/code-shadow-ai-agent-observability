// =============================================================================
// Code Shadow — lightweight import graph indexer
// =============================================================================
// The knowledge graph only had ADR reference edges. This module scans source
// files for imports and creates File/Module nodes with `imports` edges so the
// dependency_graph analyzer reflects real code dependencies.

import * as fs from "node:fs"
import * as path from "node:path"
import type { StorageEngine } from "./storage"
import { EdgeType, NodeType } from "./types"

const MAX_FILE_BYTES = 512 * 1024
const MAX_IMPORTS_PER_FILE = 200
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"]

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
]

function toProjectPath(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath)
  return (relative || path.basename(absolutePath)).replace(/\\/g, "/")
}

function isInsideProject(projectRoot: string, absolutePath: string): boolean {
  const relative = path.relative(projectRoot, absolutePath)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.add(match[1])
      if (specifiers.size >= MAX_IMPORTS_PER_FILE) return [...specifiers]
    }
  }
  return [...specifiers]
}

export function resolveImportSpecifier(projectRoot: string, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((extension) => base + extension),
    ...RESOLVE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile() && isInsideProject(projectRoot, candidate)) return candidate
    } catch {
      // Candidate does not exist.
    }
  }
  return null
}

/**
 * Indexes one source file: creates its File node, resolved File dependencies,
 * external Module nodes and `imports` edges. Returns the root node id.
 */
export function indexImports(storage: StorageEngine, projectRoot: string, filePath: string): number | null {
  try {
    const root = path.resolve(projectRoot)
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
    if (!isInsideProject(root, absolute)) return null
    const stat = fs.statSync(absolute)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null

    const source = fs.readFileSync(absolute, "utf8")
    const now = Date.now()
    const rootId = storage.upsertNode({
      nodeType: NodeType.File,
      name: path.basename(absolute),
      path: toProjectPath(root, absolute),
      metadata: { index_source: "import-scan" },
      createdAt: now,
      updatedAt: now,
      projectRoot: root,
    })
    if (rootId <= 0) return null

    for (const specifier of extractImportSpecifiers(source)) {
      const resolved = resolveImportSpecifier(root, absolute, specifier)
      let targetId: number | null = null
      if (resolved) {
        targetId = storage.upsertNode({
          nodeType: NodeType.File,
          name: path.basename(resolved),
          path: toProjectPath(root, resolved),
          metadata: null,
          createdAt: now,
          updatedAt: now,
          projectRoot: root,
        })
      } else if (!specifier.startsWith(".")) {
        targetId = storage.upsertNode({
          nodeType: NodeType.Module,
          name: specifier,
          path: null,
          metadata: { external: true },
          createdAt: now,
          updatedAt: now,
          projectRoot: root,
        })
      }
      if (targetId && targetId > 0) {
        storage.upsertEdge({
          sourceId: rootId,
          targetId,
          edgeType: EdgeType.Imports,
          weight: 1,
          evidenceCount: 1,
        })
      }
    }

    return rootId
  } catch {
    return null
  }
}
