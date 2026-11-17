// =============================================================================
// Code Shadow — Tool Trust fingerprints
// =============================================================================
// Pure helpers for pinning a tool's name/description/input schema and for
// spotting descriptions that look like prompt-injection or exfiltration
// instructions. Storage writes stay in StorageEngine; the V2 adapter feeds
// `editor.list()` into `syncToolTrustBatch`.
// =============================================================================

import { createHash } from "node:crypto"
import { stableStringify } from "./passport"
import type { StorageEngine } from "./storage"
import type { ToolTrustRecord } from "./types"

/**
 * Tool descriptions are untrusted input from MCP servers and third-party
 * plugins. These heuristics intentionally err on the side of warning.
 */
const SUSPICIOUS_DESCRIPTION_PATTERNS: RegExp[] = [
  // "ignore previous instructions", "disregard the system prompt", ...
  /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,40}\b(?:previous|prior|above|system|developer|earlier)\b[\s\S]{0,20}\b(?:instructions?|prompts?|rules?|messages?)\b/i,
  /\b(?:system|developer)\s+prompt\b/i,
  /\bexfiltrat(?:e|es|ed|ion|ing)\b/i,
  // Reading local secrets.
  /\b(?:read|open|cat|access|dump|steal|collect)\b[\s\S]{0,60}(?:\.ssh\b|id_rsa|id_ed25519|ssh\s+key|private\s+key|\.aws\b|\.env\b)/i,
  // Sending credentials anywhere.
  /\b(?:send|post|upload|transmit|leak|share|forward)\b[\s\S]{0,60}\b(?:token|secret|credential|api[\s_-]?key|password|session\s+cookie)/i,
  // Hiding behaviour from the human.
  /\bdo\s+not\s+(?:tell|inform|notify|mention|alert|warn)\b[\s\S]{0,30}\b(?:the\s+)?(?:user|human|operator)\b/i,
  // Remote code piped straight into a shell.
  /\b(?:curl|wget)\b[^\n]{0,140}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|powershell|pwsh)\b/i,
  // Obfuscated secrets.
  /\bbase64\b[\s\S]{0,60}\b(?:secret|token|key|credential|password)/i,
  /\b(?:secret|token|key|credential|password)\b[\s\S]{0,60}\bbase64\b/i,
  // Prompt leakage / hidden instructions.
  /\b(?:reveal|print|show|output|repeat)\b[\s\S]{0,40}\b(?:system\s+prompt|hidden\s+instructions?|developer\s+message)/i,
  /\b(?:hidden|invisible|silent)\s+(?:instructions?|prompt|command)\b/i,
  // Russian equivalents of the most common injection phrases.
  /(?:игнорируй|проигнорируй|забудь)[\s\S]{0,40}(?:предыдущ\w*|системн\w*|прошл\w*)[\s\S]{0,20}(?:инструкц\w*|правил\w*|промпт\w*)/i,
  /системн\w*\s+промпт/i,
  /не\s+сообщай[\s\S]{0,30}пользовател\w*/i,
]

/** True when a tool description contains prompt-injection or exfiltration markers. */
export function isSuspiciousToolDescription(description: string): boolean {
  if (!description) return false
  return SUSPICIOUS_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description))
}

/** SHA-256 hex digest of a string. */
export function hashText(value: string): string {
  return createHash("sha256").update(value ?? "", "utf8").digest("hex")
}

/**
 * Stable fingerprint of the trust-relevant parts of a tool. Key order in the
 * schema object does not matter; a changed description, schema or name does.
 */
export function toolFingerprint(name: string, description: string, schema: unknown): string {
  return hashText(stableStringify({
    name,
    description,
    schema: schema === undefined ? null : schema,
  }))
}

/** A tool entry as reported by the V2 editor or by a scan payload. */
export interface ToolTrustCandidate {
  id?: unknown
  name?: unknown
  description?: unknown
  input?: unknown
  parameters?: unknown
  schema?: unknown
  server?: unknown
  serverName?: unknown
}

function candidateName(info: ToolTrustCandidate | null | undefined): string {
  const raw = info?.id ?? info?.name
  if (raw === undefined || raw === null) return ""
  return String(raw).trim()
}

function candidateSchema(info: ToolTrustCandidate | null | undefined): unknown {
  const schema = info?.input ?? info?.parameters ?? info?.schema
  return schema === undefined ? {} : schema
}

function candidateDescription(info: ToolTrustCandidate | null | undefined): string {
  return String(info?.description ?? "")
}

function candidateServer(info: ToolTrustCandidate | null | undefined): string | null {
  const raw = info?.serverName ?? info?.server
  if (raw === undefined || raw === null) return null
  const value = String(raw).trim()
  return value.length > 0 ? value : null
}

/**
 * Upserts every tool reported by the V2 editor, flags suspicious descriptions
 * and returns only the records worth surfacing (changed or suspicious).
 * Never throws: a single malformed tool must not break plugin setup.
 */
export function syncToolTrustBatch(
  storage: StorageEngine,
  projectRoot: string,
  tools: ReadonlyArray<ToolTrustCandidate | null | undefined>,
): ToolTrustRecord[] {
  const root = projectRoot || process.cwd()
  const results: ToolTrustRecord[] = []

  for (const info of tools ?? []) {
    try {
      const name = candidateName(info)
      if (!name) continue

      const description = candidateDescription(info)
      const schema = candidateSchema(info)
      const result = storage.upsertToolTrust({
        projectRoot: root,
        serverName: candidateServer(info),
        toolName: name,
        fingerprint: toolFingerprint(name, description, schema),
        descriptionHash: hashText(description),
        schemaHash: hashText(stableStringify(schema)),
        metadata: { source: "v2-tool-transform" },
      })

      let record = result.record
      if (isSuspiciousToolDescription(description)) {
        record = storage.setToolTrustStatus(root, name, "suspicious") ?? record
      }
      if (result.changed || record.status === "suspicious") results.push(record)
    } catch {
      // Never fail tool registration because one tool could not be pinned.
      continue
    }
  }

  return results
}
