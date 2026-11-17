// =============================================================================
// Code Shadow — Proof-Carrying Change (Change Passport)
// =============================================================================
// Pure analysis helpers for the change passport: almost-right code scanning,
// destructive-command classification, deterministic hashing, risk scoring and
// a review packet that a human can read without replaying the agent session.
// =============================================================================

import { createHash } from "node:crypto"
import type {
  ChangePassport,
  PassportFinding,
  PassportSeverity,
} from "./types"

const MAX_SCAN_BYTES = 512 * 1024
const HASH_VERSION = 1

const SCANNABLE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "go", "rs", "java", "kt", "kts", "cs", "rb", "php",
  "swift", "dart", "c", "h", "cpp", "hpp", "cc", "cxx",
  "scala", "sh", "bash", "zsh", "ps1", "sql", "json", "jsonc",
  "yaml", "yml", "toml",
])

const IGNORED_PATH = /(^|\/)(node_modules|dist|build|coverage|\.git|\.next|\.cache|vendor|__pycache__|\.venv|venv)(\/|$)/i

export function isScannableFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  if (!normalized || IGNORED_PATH.test(normalized)) return false
  if (/\.min\.(js|css)$/i.test(normalized) || /\.map$/i.test(normalized)) return false
  const extension = normalized.split(".").pop()?.toLowerCase() ?? ""
  return SCANNABLE_EXTENSIONS.has(extension)
}

type AlmostRightRule = {
  id: string
  severity: PassportSeverity
  pattern: RegExp
  message: string
}

const ALMOST_RIGHT_RULES: AlmostRightRule[] = [
  {
    id: "silent-catch",
    severity: "error",
    pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    message: "Пустой catch скрывает ошибку; исправь причину или запиши явную обработку",
  },
  {
    id: "except-pass",
    severity: "error",
    pattern: /\bexcept\b[^:]*:\s*pass\b/,
    message: "except: pass подавляет ошибку без обработки",
  },
  {
    id: "ts-ignore",
    severity: "warning",
    pattern: /@ts-(?:ignore|expect-error)/,
    message: "Подавление TypeScript-диагностики без объяснения",
  },
  {
    id: "eslint-disable",
    severity: "warning",
    pattern: /eslint-disable/,
    message: "Отключение ESLint-правила; нужно обоснование",
  },
  {
    id: "as-any",
    severity: "info",
    pattern: /\bas\s+any\b|:\s*any\b/,
    message: "Приведение к any снижает проверяемость типа",
  },
  {
    id: "test-disabled",
    severity: "critical",
    pattern: /\b(?:describe|it|test)\.(?:skip|only)\b|\bx(?:it|describe)\s*\(/,
    message: "Тест отключён или выделен; это меняет доказательную базу",
  },
  {
    id: "masked-exit-code",
    severity: "critical",
    pattern: /\|\|\s*(?:true|:)\b|--no-verify\b/,
    message: "Маскировка кода возврата или обход pre-commit проверок",
  },
  {
    id: "process-exit-zero",
    severity: "warning",
    pattern: /process\.exit\(\s*0\s*\)/,
    message: "Принудительный успешный exit может скрыть ошибку",
  },
  {
    id: "eval",
    severity: "warning",
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    message: "Динамическое исполнение кода требует отдельной проверки",
  },
  {
    id: "dangerous-html",
    severity: "warning",
    pattern: /dangerouslySetInnerHTML/,
    message: "Потенциальный XSS-вектор в JSX",
  },
  {
    id: "sql-drop",
    severity: "critical",
    pattern: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i,
    message: "Разрушительная SQL-операция",
  },
  {
    id: "sql-delete-without-where",
    severity: "critical",
    pattern: /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i,
    message: "DELETE без WHERE может удалить всю таблицу",
  },
  {
    id: "todo-marker",
    severity: "info",
    pattern: /\b(?:TODO|FIXME|HACK)\b/,
    message: "Незавершённый участок кода",
  },
  {
    id: "not-implemented",
    severity: "warning",
    pattern: /not\s+implemented|notImplemented|NOT_IMPLEMENTED/i,
    message: "Заглушка вместо реализации",
  },
]

const DESTRUCTIVE_RULES: Array<{
  id: string
  severity: PassportSeverity
  pattern: RegExp
  message: string
}> = [
  { id: "rm-recursive", severity: "critical", pattern: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/i, message: "Реcursive force delete" },
  { id: "remove-item-recursive", severity: "critical", pattern: /\bremove-item\b[^\n]*-recurse[^\n]*-force/i, message: "PowerShell recursive force delete" },
  { id: "remove-item-force-recurse", severity: "critical", pattern: /\bremove-item\b[^\n]*-force[^\n]*-recurse/i, message: "PowerShell force recursive delete" },
  { id: "rd-s-q", severity: "critical", pattern: /\b(?:rd|rmdir)\s+\/s\s+\/q\b/i, message: "Windows recursive directory delete" },
  { id: "del-force", severity: "critical", pattern: /\bdel\s+\/[fsq]\b/i, message: "Windows force delete" },
  { id: "git-reset-hard", severity: "critical", pattern: /\bgit\s+reset\s+--hard\b/i, message: "Откат рабочего дерева с потерей изменений" },
  { id: "git-clean-fd", severity: "critical", pattern: /\bgit\s+clean\s+-[a-z]*[fd]/i, message: "Удаление untracked/dirty файлов" },
  { id: "drop-table", severity: "critical", pattern: /\bdrop\s+(?:database|table)\b/i, message: "Удаление таблицы/базы" },
  { id: "truncate-table", severity: "critical", pattern: /\btruncate\s+table\b/i, message: "Очистка таблицы" },
  { id: "delete-without-where", severity: "critical", pattern: /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i, message: "DELETE без WHERE" },
  { id: "mkfs-dd", severity: "critical", pattern: /\bmkfs\b|\bdd\s+if=/i, message: "Операция уровня файловой системы" },
  { id: "format-drive", severity: "critical", pattern: /\bformat\s+[a-z]:/i, message: "Форматирование диска" },
  { id: "shutdown", severity: "critical", pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, message: "Остановка/перезагрузка хоста" },
  { id: "pkill-force", severity: "critical", pattern: /\bpkill\s+-f\b|\bkill\s+-9\b/i, message: "Широкое убийство процессов" },
  { id: "terraform-destroy", severity: "critical", pattern: /\bterraform\s+destroy\b/i, message: "Уничтожение инфраструктуры" },
  { id: "kubectl-delete", severity: "critical", pattern: /\bkubectl\s+delete\b/i, message: "Удаление Kubernetes-ресурсов" },
  { id: "docker-prune", severity: "critical", pattern: /\bdocker\s+system\s+prune\b/i, message: "Очистка Docker" },
  { id: "npm-publish", severity: "critical", pattern: /\bnpm\s+publish\b/i, message: "Публикация пакета" },
  { id: "curl-pipe-shell", severity: "critical", pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh|powershell|pwsh)\b/i, message: "Исполнение скачанного скрипта" },
  { id: "iwr-iex", severity: "critical", pattern: /\b(?:iwr|invoke-webrequest)\b[^\n]*\|\s*(?:iex|invoke-expression)\b/i, message: "Исполнение скачанного PowerShell" },
  { id: "git-push-force", severity: "warning", pattern: /\bgit\s+push\s+(?:--force|-f)\b/i, message: "Force push" },
  { id: "sudo", severity: "warning", pattern: /\bsudo\b/i, message: "Повышение привилегий" },
  { id: "chmod-777", severity: "warning", pattern: /\bchmod\s+777\b/i, message: "Слишком широкие права" },
  { id: "global-install", severity: "warning", pattern: /\bnpm\s+install\s+-g\b/i, message: "Глобальная установка пакета" },
]

function finding(
  kind: string,
  severity: PassportSeverity,
  file: string | null,
  line: number | null,
  message: string,
): PassportFinding {
  return { kind, severity, file, line, message }
}

/**
 * Masks string/regex literals before rule matching. Without this the scanner
 * would flag its own rule table (`pattern: /\|\| true/`, `message: "except: pass"`)
 * and test fixtures that intentionally contain bad snippets as strings.
 * Character positions are preserved so line numbers remain correct.
 */
function maskLiterals(line: string): string {
  const chars = line.split("")
  let state: "code" | "single" | "double" | "template" | "regex" | "lineComment" | "blockComment" = "code"
  let escaped = false
  let inClass = false

  const maskFrom = (index: number): void => {
    if (index < chars.length) chars[index] = " "
  }

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]
    if (state === "lineComment") {
      maskFrom(index)
      continue
    }
    if (state === "blockComment") {
      // Use non-whitespace masking so `catch { /* comment */ }` is not reduced
      // to an "empty catch" by the scanner.
      chars[index] = "x"
      if (char === "*" && chars[index + 1] === "/") {
        chars[index + 1] = "x"
        state = "code"
        index++
      }
      continue
    }
    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`"
      maskFrom(index)
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) state = "code"
      continue
    }
    if (state === "regex") {
      maskFrom(index)
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === "[") inClass = true
      else if (char === "]") inClass = false
      else if (char === "/" && !inClass) state = "code"
      continue
    }

    // code
    if (char === "/" && chars[index + 1] === "/") {
      state = "lineComment"
      maskFrom(index)
      continue
    }
    if (char === "/" && chars[index + 1] === "*") {
      state = "blockComment"
      maskFrom(index)
      maskFrom(index + 1)
      index++
      continue
    }
    if (char === "'") {
      state = "single"
      maskFrom(index)
      continue
    }
    if (char === '"') {
      state = "double"
      maskFrom(index)
      continue
    }
    if (char === "`") {
      state = "template"
      maskFrom(index)
      continue
    }
    if (char === "/") {
      // A regex literal usually follows an operator/punctuation or starts a
      // line. `/` after an identifier is division and stays untouched.
      let previous = index - 1
      while (previous >= 0 && /\s/.test(chars[previous])) previous--
      const regexContext =
        previous < 0 || /[=(:,!&|?{};[\]]/.test(chars[previous])
      if (regexContext && chars[index + 1] !== "/") {
        state = "regex"
        inClass = false
        maskFrom(index)
      }
    }
  }
  return chars.join("")
}

/** A test file by path, mirroring the convention used by the test runner. */
function isTestFilePath(filePath: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath)
}

/** An assertion call (`expect(`, `assert(`, `assert.`, `should(`). */
const ASSERTION_CALL = /\b(?:expect|assert|should)\s*[.(]/

/**
 * An assertion statement, including Python's `assert value`. Used on diff
 * lines to notice that a test lost its assertion without gaining a new one.
 */
const ASSERTION_STATEMENT = /\bexpect\s*\(|\bassert\b|\bshould\s*\(/

/**
 * Applies the almost-right rules to a single line. Shared by the full-file
 * scanner and the diff scanner so both report identical findings.
 */
function scanLine(
  filePath: string,
  line: string,
  lineNumber: number,
  isTestFile: boolean,
): PassportFinding[] {
  const masked = maskLiterals(line)
  const findings: PassportFinding[] = []
  for (const rule of ALMOST_RIGHT_RULES) {
    // TODO/FIXME in a test documents missing coverage; in a diff seal it is
    // only info noise, not a signal about the current change.
    if (rule.id === "todo-marker" && isTestFile) continue
    if (!rule.pattern.test(masked)) continue
    findings.push(finding(rule.id, rule.severity, filePath, lineNumber, rule.message))
  }
  return findings
}

/**
 * Scans one file's current content for "almost right" patterns: code that can
 * look complete while suppressing an error, disabling a test or hiding a
 * destructive operation. Returns one finding per rule/line.
 *
 * This is the full-file scanner: use it for new/untracked files. For files that
 * already exist in git, prefer `scanDiffForAlmostRight` so untouched legacy
 * code does not produce findings for the current change.
 */
export function scanAlmostRight(filePath: string, content: string): PassportFinding[] {
  if (!filePath || !content) return []
  if (content.length > MAX_SCAN_BYTES) content = content.slice(0, MAX_SCAN_BYTES)
  const findings: PassportFinding[] = []
  const isTestFile = isTestFilePath(filePath)
  const lines = content.split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    findings.push(...scanLine(filePath, lines[index], index + 1, isTestFile))
  }

  // A test file without assertions is usually a false proof of verification.
  if (isTestFile) {
    const hasAssertion = ASSERTION_CALL.test(content)
    if (!hasAssertion) {
      findings.push(
        finding(
          "tests-without-assertions",
          "error",
          filePath,
          1,
          "Тестовый файл не содержит expect/assert — он не доказывает поведение",
        ),
      )
    }
  }

  return findings
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Scans only the added lines of a unified diff (`git diff --unified=0`).
 * Findings point at new-file line numbers, so they line up with the current
 * content of `filePath`. Removed assertions are reported when a diff drops an
 * `expect(`/`assert`/`should(` line without adding another assertion.
 */
export function scanDiffForAlmostRight(diffText: string, filePath: string): PassportFinding[] {
  if (!diffText || !filePath) return []
  const findings: PassportFinding[] = []
  const seen = new Set<string>()
  const isTestFile = isTestFilePath(filePath)
  let inHunk = false
  let newLine = 0
  let hunkNewLine = 0
  let removedAssertionLine: number | null = null
  let addedAssertion = false

  const push = (items: PassportFinding[]): void => {
    for (const item of items) {
      const key = `${item.kind}:${item.line}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push(item)
    }
  }

  for (const raw of diffText.split(/\r?\n/)) {
    const hunk = HUNK_HEADER.exec(raw)
    if (hunk) {
      hunkNewLine = Number(hunk[1])
      newLine = hunkNewLine
      inHunk = true
      continue
    }
    if (!inHunk) {
      // File headers (`diff --git`, `index`, `---`, `+++`, modes, rename
      // metadata, `Binary files ... differ`) are ignored outside hunks.
      continue
    }

    if (raw.startsWith("diff --git ")) {
      inHunk = false
      continue
    }
    if (raw.startsWith("\\")) continue // "\ No newline at end of file"

    if (raw.startsWith("+")) {
      const line = raw.slice(1)
      push(scanLine(filePath, line, newLine, isTestFile))
      if (ASSERTION_STATEMENT.test(line)) addedAssertion = true
      newLine++
      continue
    }
    if (raw.startsWith("-")) {
      if (removedAssertionLine === null && ASSERTION_STATEMENT.test(raw.slice(1))) {
        removedAssertionLine = hunkNewLine
      }
      continue
    }
    // Context lines (leading space) and, defensively, an empty line that lost
    // its leading space: both exist in the new file.
    newLine++
  }

  if (removedAssertionLine !== null && !addedAssertion) {
    findings.push(
      finding(
        "test-assertion-removed",
        "warning",
        filePath,
        removedAssertionLine,
        "Удалён expect/assert без замены — тест перестал доказывать поведение",
      ),
    )
  }

  return findings
}

/**
 * Classifies a shell command before execution. Critical findings are intended
 * to be blocked unless a passport explicitly allows destructive actions.
 */
const SHELL_TOOL_PATTERN = /^(bash|shell|exec|execute|command|run|terminal|powershell|pwsh|cmd)$/i

/** Only shell-like tools can execute a command; edit/write args may contain command text. */
export function isShellLikeTool(toolName: string): boolean {
  return SHELL_TOOL_PATTERN.test((toolName || "").trim())
}

export function isInspectionCommand(command: string): boolean {
  const tokens = (command || "").trim().split(/\s+/)
  const executable = (tokens[0] || "").replace(/^["']|["']$/g, "").toLowerCase()
  if (
    /^(select-string|grep|rg|findstr|get-content|get-childitem|dir|ls|cat|less|more|head|tail|echo|printf|write-output|write-host)$/.test(
      executable,
    )
  ) {
    return true
  }
  if (executable === "git") {
    return /^(status|diff|log|show|grep|rev-parse|branch|remote)$/i.test(tokens[1] || "")
  }
  return false
}

export function classifyDestructiveCommand(command: string): PassportFinding[] {
  const value = (command || "").trim()
  if (!value) return []
  // Search/inspection commands often contain destructive words as grep
  // patterns (`Select-String -Pattern 'rm -rf|DROP TABLE'`); they are not
  // executions. A chained destructive command after `;` is out of scope here.
  if (isInspectionCommand(value)) return []
  const findings: PassportFinding[] = []
  const seen = new Set<string>()
  for (const rule of DESTRUCTIVE_RULES) {
    if (!rule.pattern.test(value)) continue
    if (seen.has(rule.id)) continue
    seen.add(rule.id)
    findings.push(
      finding(
        rule.id,
        rule.severity,
        null,
        null,
        `${rule.message}: ${value.slice(0, 180)}`,
      ),
    )
  }
  return findings
}

export function isDestructiveCommand(command: string): boolean {
  return classifyDestructiveCommand(command).some(
    (item) => item.severity === "critical" || item.severity === "error",
  )
}

export function fileContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`
}

/**
 * Deterministic passport hash. `prevHash` is part of the payload, so changing
 * any earlier passport breaks the chain for every later one.
 */
export function computePassportHash(passport: ChangePassport): string {
  const payload = {
    version: HASH_VERSION,
    id: passport.id,
    projectRoot: passport.projectRoot,
    sessionId: passport.sessionId,
    taskId: passport.taskId,
    contractId: passport.contractId,
    intent: passport.intent,
    status: passport.status,
    riskScore: passport.riskScore,
    riskLevel: passport.riskLevel,
    files: passport.files,
    evidenceIds: passport.evidenceIds,
    checks: passport.checks,
    findings: passport.findings,
    budgetTokens: passport.budgetTokens,
    tokensUsed: passport.tokensUsed,
    allowDestructive: passport.allowDestructive,
    agent: passport.agent,
    model: passport.model,
    baseRef: passport.baseRef,
    rollbackPlan: passport.rollbackPlan,
    sealedAt: passport.sealedAt,
    prevHash: passport.prevHash,
  }
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex")
}

const SEVERITY_WEIGHT: Record<PassportSeverity, number> = {
  info: 0,
  warning: 3,
  error: 15,
  critical: 30,
}

export function riskFromFindings(
  findings: PassportFinding[],
  options: {
    contractViolations?: number
    unverifiedRatio?: number
    breakageRate?: number
  } = {},
): { score: number; level: "low" | "medium" | "high" | "critical" } {
  const findingScore = findings.reduce(
    (sum, item) => sum + (SEVERITY_WEIGHT[item.severity] ?? 1),
    0,
  )
  const contractScore = Math.max(0, options.contractViolations ?? 0) * 15
  const evidenceScore = Math.max(0, Math.min(1, options.unverifiedRatio ?? 0)) * 20
  const historyScore = Math.max(0, Math.min(1, options.breakageRate ?? 0)) * 20
  const score = Math.max(0, Math.min(100, Math.round(findingScore + contractScore + evidenceScore + historyScore)))
  const level = score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "medium" : "low"
  return { score, level }
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

function shortHash(value: string | null): string {
  return value ? value.slice(0, 12) : "—"
}

function formatDate(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toISOString() : "—"
}

/**
 * Human-readable review packet. This is the artifact a reviewer can read
 * instead of reconstructing the agent's intent from a raw diff.
 */
export function buildReviewMarkdown(passport: ChangePassport): string {
  const lines: string[] = []
  lines.push(`# Change Passport: ${passport.id}`)
  lines.push("")
  lines.push(`> ${escapeMarkdown(passport.intent)}`)
  lines.push("")
  lines.push(`- **Status:** ${passport.status}`)
  lines.push(`- **Risk:** ${passport.riskScore}/100 (${passport.riskLevel})`)
  lines.push(`- **Project:** \`${passport.projectRoot}\``)
  lines.push(`- **Session:** ${passport.sessionId ?? "—"}`)
  lines.push(`- **Task:** ${passport.taskId ?? "—"}`)
  lines.push(`- **Contract:** ${passport.contractId ?? "—"}`)
  lines.push(`- **Agent / model:** ${passport.agent ?? "—"} / ${passport.model ?? "—"}`)
  lines.push(`- **Base ref:** ${passport.baseRef ?? "—"}`)
  lines.push(`- **Sealed:** ${formatDate(passport.sealedAt)}`)
  lines.push(`- **Hash:** \`${shortHash(passport.hash)}\`  (prev: \`${shortHash(passport.prevHash)}\`)`)
  lines.push(
    passport.keyId
      ? `- **Signature:** Ed25519 \`${passport.keyId}\` (DSSE/in-toto, ${formatDate(passport.signedAt)})`
      : "- **Signature:** — (unsigned)",
  )
  lines.push(`- **Tokens:** ${passport.tokensUsed}${passport.budgetTokens !== null ? ` / ${passport.budgetTokens}` : ""}`)
  lines.push("")

  lines.push("## Files")
  lines.push("")
  if (passport.files.length === 0) {
    lines.push("_No files recorded._")
  } else {
    lines.push("| File | Change | +/− | Hash |")
    lines.push("|---|---|---:|---|")
    for (const file of passport.files) {
      lines.push(
        `| \`${escapeMarkdown(file.path)}\` | ${file.editType} | +${file.linesAdded}/-${file.linesRemoved} | \`${shortHash(file.hash)}\` |`,
      )
    }
  }
  lines.push("")

  lines.push("## Checks")
  lines.push("")
  if (passport.checks.length === 0) {
    lines.push("_No checks recorded._")
  } else {
    lines.push("| Check | Status | Details |")
    lines.push("|---|---|---|")
    for (const check of passport.checks) {
      lines.push(
        `| ${escapeMarkdown(check.label)} | **${check.status}** | ${escapeMarkdown(check.details ?? "")} |`,
      )
    }
  }
  lines.push("")

  lines.push("## Findings")
  lines.push("")
  if (passport.findings.length === 0) {
    lines.push("_No findings._")
  } else {
    const order: PassportSeverity[] = ["critical", "error", "warning", "info"]
    const sorted = [...passport.findings].sort(
      (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
    )
    for (const item of sorted) {
      const location = item.file
        ? `\`${item.file}${item.line ? `:${item.line}` : ""}\``
        : "workspace"
      lines.push(`- **${item.severity.toUpperCase()}** ${location} — ${escapeMarkdown(item.message)}`)
    }
  }
  lines.push("")

  lines.push("## Evidence")
  lines.push("")
  if (passport.evidenceIds.length === 0) {
    lines.push("_No evidence linked._")
  } else {
    lines.push(passport.evidenceIds.map((id) => `- \`${id}\``).join("\n"))
  }
  lines.push("")

  lines.push("## Rollback")
  lines.push("")
  lines.push(passport.rollbackPlan ? escapeMarkdown(passport.rollbackPlan) : "_Not specified._")
  lines.push("")

  lines.push("## Reviewer checklist")
  lines.push("")
  lines.push("- [ ] Intent matches the actual change")
  lines.push("- [ ] No critical/error findings left unexplained")
  lines.push("- [ ] Evidence is verified and still reproducible")
  lines.push("- [ ] Contract violations resolved")
  lines.push("- [ ] Rollback plan is realistic")
  lines.push("")
  lines.push("_Generated by Code Shadow Proof-Carrying Change._")
  return lines.join("\n")
}
