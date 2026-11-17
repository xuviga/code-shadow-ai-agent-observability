// =============================================================================
// Code Shadow — Passport Attestation (DSSE + in-toto + Ed25519)
// =============================================================================
// Turns a sealed change passport into a portable, cryptographically signed
// attestation:
//
//   in-toto Statement  ->  DSSE envelope  ->  Ed25519 signature
//
// The signing key is Ed25519, generated locally on first use and stored next
// to the shadow database. Verification needs only the envelope itself: the
// public key travels with the signature. No network, no certificate authority,
// no Sigstore dependency required (a cosign-compatible path is documented).
// =============================================================================

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ChangePassport } from "./types"
import { stableStringify } from "./passport"

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json"
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
export const PASSPORT_PREDICATE_TYPE =
  "https://code-shadow.dev/attestation/change-passport/v1"

const PRIVATE_KEY_FILE = "passport-signing-key.pem"
const PUBLIC_KEY_FILE = "passport-signing-key.pub.pem"
const KEY_SOURCE_ENV = "CODE_SHADOW_SIGNING_KEY"

export interface SigningKey {
  privateKey: KeyObject
  publicKey: KeyObject
  keyId: string
  publicPem: string
  source: string
}

export interface StatementSubject {
  name: string
  digest: Record<string, string>
}

export interface InTotoStatement {
  _type: string
  subject: StatementSubject[]
  predicateType: string
  predicate: Record<string, unknown>
}

export interface DsseSignature {
  keyid: string
  sig: string
  publicKey?: string
}

export interface DsseEnvelope {
  payloadType: string
  payload: string
  signatures: DsseSignature[]
  "x-code-shadow-public-key"?: string
  "x-code-shadow-signed-at"?: number
}

export interface VerifiedEnvelope {
  valid: boolean
  keyId: string | null
  signedAt: number | null
  statement: InTotoStatement | null
  error: string | null
}

/** SHA-256 over the SPKI DER encoding, truncated to 32 hex chars. */
export function keyIdFor(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer
  return createHash("sha256").update(der).digest("hex").slice(0, 32)
}

/**
 * DSSE Pre-Authentication Encoding:
 *   "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
 * Lengths are ASCII byte counts of the UTF-8 payloads.
 */
export function dssePae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8")
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"),
    type,
    Buffer.from(` ${payload.length} `, "utf8"),
    payload,
  ])
}

function writeSecret(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 })
  try {
    // Windows ignores most POSIX bits; this still tightens POSIX hosts.
    chmodSync(path, 0o600)
  } catch {
    // Best effort: a read-only or exotic filesystem must not break sealing.
  }
}

export interface LoadKeyOptions {
  /** Directory for the generated keypair. Defaults to `<db dir>/keys`. */
  keyDir?: string
  /** Explicit private key PEM path. Wins over keyDir. */
  keyPath?: string
  /** Environment override, mainly for CI and tests. */
  env?: NodeJS.ProcessEnv
}

/**
 * Loads the local signing key, generating an Ed25519 keypair on first use.
 * Throws only when the key cannot be read or created; callers decide the policy.
 */
export function loadOrCreateSigningKey(options: LoadKeyOptions = {}): SigningKey {
  const env = options.env ?? process.env
  const explicit = options.keyPath || env[KEY_SOURCE_ENV]
  if (explicit) {
    const pem = readFileSync(explicit, "utf8")
    const privateKey = createPrivateKey(pem)
    const publicKey = createPublicKey(privateKey)
    return {
      privateKey,
      publicKey,
      keyId: keyIdFor(publicKey),
      publicPem: publicKey.export({ type: "spki", format: "pem" }) as string,
      source: explicit,
    }
  }

  const keyDir = options.keyDir
  if (!keyDir) throw new Error("signing key directory is not configured")
  const privatePath = join(keyDir, PRIVATE_KEY_FILE)
  const publicPath = join(keyDir, PUBLIC_KEY_FILE)

  if (!existsSync(privatePath)) {
    mkdirSync(keyDir, { recursive: true })
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    writeSecret(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }) as string)
    writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }) as string, "utf8")
  }

  const privateKey = createPrivateKey(readFileSync(privatePath, "utf8"))
  const publicKey = createPublicKey(privateKey)
  return {
    privateKey,
    publicKey,
    keyId: keyIdFor(publicKey),
    publicPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    source: privatePath,
  }
}

export function defaultKeyDir(dbPath: string): string {
  // An empty dbPath would resolve to <cwd>/keys and silently drop a private key
  // into the repository. Refuse instead: a misconfigured caller must fail loudly.
  if (!dbPath || !dbPath.trim() || dbPath === ":memory:") {
    throw new Error(
      "signing key directory is not configured: dbPath is empty; set signingKeyDir or signingKeyPath",
    )
  }
  return join(dirname(dbPath), "keys")
}

/** Signs an in-toto statement and returns a self-contained DSSE envelope. */
export function signStatement(
  statement: InTotoStatement,
  key: SigningKey,
  signedAt = Date.now(),
): DsseEnvelope {
  const payload = Buffer.from(stableStringify(statement), "utf8")
  const signature = sign(null, dssePae(DSSE_PAYLOAD_TYPE, payload), key.privateKey)
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [
      {
        keyid: key.keyId,
        sig: signature.toString("base64"),
        publicKey: key.publicPem,
      },
    ],
    "x-code-shadow-public-key": key.publicPem,
    "x-code-shadow-signed-at": signedAt,
  }
}

/** Verifies a DSSE envelope without any external state. */
export function verifyEnvelope(envelope: unknown): VerifiedEnvelope {
  const empty: VerifiedEnvelope = {
    valid: false,
    keyId: null,
    signedAt: null,
    statement: null,
    error: null,
  }
  if (!envelope || typeof envelope !== "object") {
    return { ...empty, error: "envelope is not an object" }
  }
  const value = envelope as Partial<DsseEnvelope>
  if (value.payloadType !== DSSE_PAYLOAD_TYPE) {
    return { ...empty, error: `unexpected payloadType: ${String(value.payloadType)}` }
  }
  const signature = value.signatures?.[0]
  if (!signature || typeof signature.sig !== "string") {
    return { ...empty, error: "missing signature" }
  }
  const publicPem = signature.publicKey ?? value["x-code-shadow-public-key"]
  if (!publicPem) return { ...empty, error: "missing public key" }

  let payload: Buffer
  let statement: InTotoStatement
  try {
    payload = Buffer.from(String(value.payload ?? ""), "base64")
    statement = JSON.parse(payload.toString("utf8")) as InTotoStatement
  } catch (error) {
    return { ...empty, error: `payload is not valid JSON: ${String(error)}` }
  }

  try {
    const publicKey = createPublicKey(publicPem)
    const keyId = keyIdFor(publicKey)
    if (signature.keyid && signature.keyid !== keyId) {
      return {
        ...empty,
        keyId,
        error: `keyid mismatch: envelope=${signature.keyid} key=${keyId}`,
      }
    }
    const valid = verify(
      null,
      dssePae(value.payloadType, payload),
      publicKey,
      Buffer.from(signature.sig, "base64"),
    )
    return {
      valid,
      keyId,
      signedAt: value["x-code-shadow-signed-at"] ?? null,
      statement,
      error: valid ? null : "signature does not match payload",
    }
  } catch (error) {
    return { ...empty, error: `verification failed: ${String(error)}` }
  }
}

export function statementDigest(statement: InTotoStatement): string {
  return createHash("sha256").update(stableStringify(statement), "utf8").digest("hex")
}

export function envelopeDigest(envelope: DsseEnvelope): string {
  return createHash("sha256")
    .update(Buffer.from(String(envelope.payload ?? ""), "base64"))
    .digest("hex")
}

function relativeToRoot(projectRoot: string, filePath: string): string {
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  const normalized = filePath.replace(/\\/g, "/")
  if (normalized.toLowerCase().startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1)
  }
  return normalized
}

/**
 * Builds the in-toto Statement for a sealed passport. Subjects are the exact
 * file contents at seal time; the predicate carries the passport verdict.
 */
export function buildPassportStatement(
  passport: ChangePassport,
  options: { generator?: string; commit?: string | null } = {},
): InTotoStatement {
  const subjects: StatementSubject[] = []
  for (const file of passport.files) {
    if (!file.hash) continue
    subjects.push({
      name: relativeToRoot(passport.projectRoot, file.path),
      digest: { sha256: file.hash },
    })
  }
  if (options.commit) {
    const repoName =
      passport.projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "repo"
    subjects.push({
      name: `git+${repoName}`,
      digest: { gitCommit: options.commit },
    })
  }

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: subjects,
    predicateType: PASSPORT_PREDICATE_TYPE,
    predicate: {
      passportId: passport.id,
      intent: passport.intent,
      status: passport.status,
      riskScore: passport.riskScore,
      riskLevel: passport.riskLevel,
      projectRoot: passport.projectRoot,
      sessionId: passport.sessionId,
      taskId: passport.taskId,
      contractId: passport.contractId,
      agent: passport.agent,
      model: passport.model,
      baseRef: passport.baseRef,
      budgetTokens: passport.budgetTokens,
      tokensUsed: passport.tokensUsed,
      allowDestructive: passport.allowDestructive,
      evidenceIds: passport.evidenceIds,
      checks: passport.checks,
      findings: passport.findings,
      rollbackPlan: passport.rollbackPlan,
      passportHash: passport.hash,
      prevHash: passport.prevHash,
      createdAt: passport.createdAt,
      sealedAt: passport.sealedAt,
      generator: options.generator ?? "code-shadow",
      generatorVersion: 1,
    },
  }
}
