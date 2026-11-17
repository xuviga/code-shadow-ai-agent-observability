import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageEngine } from "../src/storage"
import { createPassportTool } from "../src/tools/passport"
import {
  DSSE_PAYLOAD_TYPE,
  buildPassportStatement,
  defaultKeyDir,
  dssePae,
  loadOrCreateSigningKey,
  signStatement,
  statementDigest,
  verifyEnvelope,
} from "../src/attestation"
import { AgentType, SessionStatus, TaskStatus } from "../src/types"

const fixtures: Array<{ storage: StorageEngine; directory: string; project: string }> = []

const baseConfig = {
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
  destructiveActionPolicy: "block" as const,
}

function createFixture(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "code-shadow-attest-"))
  const project = join(directory, "project")
  mkdirSync(join(project, "src"), { recursive: true })
  writeFileSync(join(project, "src", "a.ts"), "export const value = 1\n", "utf8")
  const config = { ...baseConfig, dbPath: join(directory, "data.db"), ...overrides }
  const storage = new StorageEngine(config as never)
  const tool = createPassportTool(storage, config as never, {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  } as never)
  fixtures.push({ storage, directory, project })
  return { storage, tool, project, directory, config }
}

async function call(
  tools: Record<string, unknown>,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
) {
  const definition = tools.code_shadow_passport as {
    execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<{ output: string }>
  }
  return JSON.parse((await definition.execute(args, context)).output)
}

function createSession(storage: StorageEngine, project: string, id = "ses_attest") {
  const now = Date.now()
  storage.insertSession({
    id, agentType: AgentType.Build, status: SessionStatus.Active, startedAt: now,
    endedAt: null, durationMs: null, filesChangedCount: 1, toolsUsedCount: 0,
    errorsCount: 0, projectRoot: project, messageCount: 0, totalTokensUsed: 0,
    compactedFrom: null,
  })
  storage.insertFileEdit({
    filePath: "src/a.ts", sessionId: id, agentType: AgentType.Build,
    editType: "update" as never, diffPreview: "+export const value = 1",
    linesAdded: 1, linesRemoved: 0, timestamp: now, projectRoot: project,
    wasReverted: false, fileLanguage: "typescript",
  })
  return id
}

function createTask(storage: StorageEngine, project: string, sessionId: string) {
  return storage.createTask({
    projectRoot: project, sessionId, title: "Attested change", goal: "Prove the change",
    status: TaskStatus.Active, priority: 50, metadata: { auto_created: true },
  })
}

function verifyEvidence(storage: StorageEngine, project: string, taskId: string, sessionId: string) {
  storage.recordEvidence({
    projectRoot: project, taskId, sessionId, claim: "bun test passed",
    evidenceType: "command", source: "bash: bun test", status: "verified",
    confidence: 1, details: null,
  } as never)
}

afterEach(() => {
  while (fixtures.length > 0) {
    const item = fixtures.pop()!
    item.storage.close()
    try {
      rmSync(item.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Windows can hold WAL handles briefly.
    }
  }
})

describe("DSSE primitives", () => {
  test("PAE encodes type and body lengths as ASCII byte counts", () => {
    const encoded = dssePae("text/plain", Buffer.from("hello")).toString("utf8")
    expect(encoded).toBe("DSSEv1 10 text/plain 5 hello")
  })

  test("signs and verifies an in-toto statement", () => {
    const directory = mkdtempSync(join(tmpdir(), "code-shadow-keys-"))
    try {
      const key = loadOrCreateSigningKey({ keyDir: directory })
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: "src/a.ts", digest: { sha256: "abc" } }],
        predicateType: "https://code-shadow.dev/attestation/change-passport/v1",
        predicate: { passportId: "p1" },
      }
      const envelope = signStatement(statement, key)
      expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE)
      const verified = verifyEnvelope(envelope)
      expect(verified.valid).toBe(true)
      expect(verified.keyId).toBe(key.keyId)
      expect(verified.statement).toEqual(statement)
      expect(verified.error).toBeNull()

      // Same key is reused on the second load.
      const reloaded = loadOrCreateSigningKey({ keyDir: directory })
      expect(reloaded.keyId).toBe(key.keyId)
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    }
  })

  test("detects tampered payload, tampered signature and wrong keyid", () => {
    const directory = mkdtempSync(join(tmpdir(), "code-shadow-keys-"))
    try {
      const key = loadOrCreateSigningKey({ keyDir: directory })
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [],
        predicateType: "https://code-shadow.dev/attestation/change-passport/v1",
        predicate: { passportId: "p1", status: "sealed" },
      }
      const envelope = signStatement(statement, key)

      const tamperedPayload = JSON.parse(JSON.stringify(envelope))
      const payload = JSON.parse(Buffer.from(tamperedPayload.payload, "base64").toString("utf8"))
      payload.predicate.status = "blocked"
      tamperedPayload.payload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
      expect(verifyEnvelope(tamperedPayload).valid).toBe(false)

      const tamperedSignature = JSON.parse(JSON.stringify(envelope))
      const bytes = Buffer.from(tamperedSignature.signatures[0].sig, "base64")
      bytes[0] = bytes[0] ^ 0xff
      tamperedSignature.signatures[0].sig = bytes.toString("base64")
      expect(verifyEnvelope(tamperedSignature).valid).toBe(false)

      const wrongKeyId = JSON.parse(JSON.stringify(envelope))
      wrongKeyId.signatures[0].keyid = "deadbeef"
      expect(verifyEnvelope(wrongKeyId).error).toContain("keyid mismatch")
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    }
  })
})

describe("Signed passports", () => {
  test("seal signs the passport and verify reports a valid attestation", async () => {
    const { storage, tool, project, directory } = createFixture()
    const sessionId = createSession(storage, project)
    const task = createTask(storage, project, sessionId)
    verifyEvidence(storage, project, task.id, sessionId)
    const context = { sessionID: sessionId, directory: project, agent: "build" }

    const opened = await call(tool, { action: "open", intent: "Sign this change", task_id: task.id, files: ["src/a.ts"] }, context)
    const sealed = await call(tool, { action: "seal", passport_id: opened.passport.id }, context)

    expect(sealed.passport.status).toBe("sealed")
    expect(sealed.passport.keyId).toBeTruthy()
    expect(sealed.passport.signature).toBeTruthy()
    expect(sealed.passport.attestation).toBeTruthy()
    expect(sealed.passport.publicKey).toContain("BEGIN PUBLIC KEY")
    expect(sealed.passport.checks.find((item: any) => item.id === "passport-signed")?.status).toBe("pass")
    expect(sealed.passport.reviewMd).toContain("Signature:")

    const verified = await call(tool, { action: "verify", passport_id: opened.passport.id }, context)
    expect(verified.status).toBe("valid")
    expect(verified.signature.valid).toBe(true)
    expect(verified.signature.statement_digest_matches).toBe(true)
    expect(verified.signature.subject_count).toBeGreaterThan(0)

    // The key lives next to the shadow database, not in the repo.
    expect(defaultKeyDir(join(directory, "data.db"))).toBe(join(directory, "keys"))
  })

  test("verify flags a tampered statement and a stale file separately", async () => {
    const { storage, tool, project } = createFixture()
    const sessionId = createSession(storage, project)
    const task = createTask(storage, project, sessionId)
    verifyEvidence(storage, project, task.id, sessionId)
    const context = { sessionID: sessionId, directory: project, agent: "build" }
    const opened = await call(tool, { action: "open", intent: "Tamper check", task_id: task.id, files: ["src/a.ts"] }, context)
    const sealed = await call(tool, { action: "seal", passport_id: opened.passport.id }, context)

    // Change the attested payload but keep the original signature.
    const envelope = JSON.parse(sealed.passport.attestation)
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"))
    payload.predicate.intent = "Rewritten after the fact"
    envelope.payload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
    storage.updatePassport(opened.passport.id, { attestation: JSON.stringify(envelope) })

    const tampered = await call(tool, { action: "verify", passport_id: opened.passport.id }, context)
    expect(tampered.signature.valid).toBe(false)
    expect(tampered.status).toBe("tampered")
    expect(tampered.problems).toContain("signature_invalid")

    // Restore the signature; now only the working-tree file differs.
    storage.updatePassport(opened.passport.id, { attestation: sealed.passport.attestation })
    writeFileSync(join(project, "src", "a.ts"), "export const value = 2\n", "utf8")
    const stale = await call(tool, { action: "verify", passport_id: opened.passport.id }, context)
    expect(stale.signature.valid).toBe(true)
    expect(stale.status).toBe("stale")
    expect(stale.problems).toContain("files_changed")
  })

  test("requires a signature by default and blocks when the key cannot be created", async () => {
    const { storage, tool, project, directory, config } = createFixture()
    const sessionId = createSession(storage, project)
    const task = createTask(storage, project, sessionId)
    verifyEvidence(storage, project, task.id, sessionId)
    const context = { sessionID: sessionId, directory: project, agent: "build" }

    // A file where the key directory should be makes key creation fail.
    const blockedPath = join(directory, "not-a-directory")
    writeFileSync(blockedPath, "x", "utf8")
    ;(config as Record<string, unknown>).signingKeyDir = blockedPath

    const opened = await call(tool, { action: "open", intent: "No key", task_id: task.id }, context)
    const sealed = await call(tool, { action: "seal", passport_id: opened.passport.id }, context)
    expect(sealed.passport.status).toBe("blocked")
    expect(sealed.passport.attestation).toBeNull()
    const signedCheck = sealed.passport.checks.find((item: any) => item.id === "passport-signed")
    expect(signedCheck?.status).toBe("fail")
    expect(String(signedCheck?.details)).toBeTruthy()
  })

  test("policy off seals unsigned and verify accepts it explicitly", async () => {
    const { storage, tool, project } = createFixture({ passportSignaturePolicy: "off" })
    const sessionId = createSession(storage, project)
    const task = createTask(storage, project, sessionId)
    verifyEvidence(storage, project, task.id, sessionId)
    const context = { sessionID: sessionId, directory: project, agent: "build" }
    const opened = await call(tool, { action: "open", intent: "Unsigned", task_id: task.id, files: ["src/a.ts"] }, context)
    const sealed = await call(tool, { action: "seal", passport_id: opened.passport.id }, context)
    expect(sealed.passport.status).toBe("sealed")
    expect(sealed.passport.attestation).toBeNull()

    const verified = await call(tool, { action: "verify", passport_id: opened.passport.id }, context)
    expect(verified.status).toBe("valid")
    expect(verified.signature.present).toBe(false)
  })

  test("attest re-signs an existing passport and export produces a portable envelope", async () => {
    const { storage, tool, project } = createFixture()
    const sessionId = createSession(storage, project)
    const task = createTask(storage, project, sessionId)
    verifyEvidence(storage, project, task.id, sessionId)
    const context = { sessionID: sessionId, directory: project, agent: "build" }
    const opened = await call(tool, { action: "open", intent: "Export me", task_id: task.id, files: ["src/a.ts"] }, context)
    const sealed = await call(tool, { action: "seal", passport_id: opened.passport.id }, context)

    const firstEnvelope = JSON.parse(sealed.passport.attestation)
    const firstStatement = JSON.parse(Buffer.from(firstEnvelope.payload, "base64").toString("utf8"))
    expect(statementDigest(firstStatement)).toBe(sealed.passport.statementDigest)

    const resigned = await call(tool, { action: "attest", passport_id: opened.passport.id }, context)
    expect(resigned.key_id).toBe(sealed.passport.keyId)
    expect(verifyEnvelope(resigned.envelope).valid).toBe(true)

    const exported = await call(tool, { action: "export", passport_id: opened.passport.id }, context)
    expect(exported.exported.attestation).toBeTruthy()
    expect(exported.exported.intotoBundle).toBeTruthy()

    const envelopeFile = exported.exported.attestation as string
    const raw = JSON.parse(readFileSync(envelopeFile, "utf8"))
    expect(verifyEnvelope(raw).valid).toBe(true)

    // The standalone verifier must agree without the plugin or database.
    const script = join(process.cwd(), "scripts", "verify-passport.js")
    const output = execFileSync(process.execPath, [script, envelopeFile, "--json"], {
      encoding: "utf8",
    })
    const summary = JSON.parse(output)
    expect(summary.valid).toBe(true)
    expect(summary.passport_id).toBe(opened.passport.id)
    expect(summary.key_id).toBe(sealed.passport.keyId)
  })

  test("refuses to derive a key directory from an empty dbPath", () => {
    // A repo-relative `keys/` directory would leak a private key into git.
    expect(() => defaultKeyDir("")).toThrow(/signingKeyDir|signingKeyPath/)
    expect(() => defaultKeyDir(":memory:")).toThrow(/signingKeyDir|signingKeyPath/)
  })

  test("buildPassportStatement uses repo-relative subjects and includes the commit", () => {
    const project = "D:/work/project"
    const passport = {
      id: "p1", projectRoot: project, sessionId: null, taskId: null, contractId: null,
      intent: "x", status: "sealed", riskScore: 0, riskLevel: "low",
      files: [
        { path: `${project}/src/a.ts`, editType: "update", linesAdded: 1, linesRemoved: 0, hash: "aaaa" },
        { path: `${project}/src/b.ts`, editType: "update", linesAdded: 1, linesRemoved: 0, hash: null },
      ],
      evidenceIds: [], checks: [], findings: [], budgetTokens: null, tokensUsed: 0,
      allowDestructive: false, agent: null, model: null, baseRef: null, rollbackPlan: null,
      reviewMd: null, hash: "h", prevHash: null, attestation: null, keyId: null,
      signature: null, publicKey: null, statementDigest: null, signedAt: null,
      createdAt: 1, updatedAt: 1, sealedAt: 1,
    } as any
    const statement = buildPassportStatement(passport, { commit: "abc123" })
    expect(statement.subject.map((item: any) => item.name)).toEqual([
      "src/a.ts", "git+project",
    ])
    expect(statement.subject[1].digest.gitCommit).toBe("abc123")
    expect(statement.predicate.passportHash).toBe("h")
  })
})
