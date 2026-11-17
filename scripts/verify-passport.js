#!/usr/bin/env node
// =============================================================================
// Standalone Code Shadow passport verifier
// =============================================================================
// Verifies a DSSE envelope produced by `code_shadow_passport action="export"`.
// No plugin, no database, no network, no dependencies: only node:crypto.
//
//   node scripts/verify-passport.js <file.att.json|file.intoto.jsonl> [--json]
//
// Exit codes: 0 = signature valid, 1 = invalid, 2 = usage/parse error.
// =============================================================================

"use strict"

import { createHash, createPublicKey, verify } from "node:crypto"
import { readFileSync } from "node:fs"

const PAYLOAD_TYPE = "application/vnd.in-toto+json"

function pae(payloadType, payload) {
  const type = Buffer.from(payloadType, "utf8")
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"),
    type,
    Buffer.from(` ${payload.length} `, "utf8"),
    payload,
  ])
}

function keyIdFor(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" })
  return createHash("sha256").update(der).digest("hex").slice(0, 32)
}

function readEnvelope(file) {
  const raw = readFileSync(file, "utf8").trim()
  if (!raw) throw new Error("file is empty")
  if (raw.startsWith("{")) {
    const firstLine = raw.split(/\r?\n/)[0]
    return JSON.parse(firstLine)
  }
  throw new Error("expected a JSON DSSE envelope or an in-toto JSONL bundle")
}

function verifyEnvelope(envelope) {
  const result = {
    valid: false,
    keyId: null,
    signedAt: null,
    statement: null,
    error: null,
  }
  if (!envelope || typeof envelope !== "object") {
    result.error = "envelope is not an object"
    return result
  }
  if (envelope.payloadType !== PAYLOAD_TYPE) {
    result.error = `unexpected payloadType: ${String(envelope.payloadType)}`
    return result
  }
  const signature = Array.isArray(envelope.signatures) ? envelope.signatures[0] : null
  if (!signature || typeof signature.sig !== "string") {
    result.error = "missing signature"
    return result
  }
  const publicPem = signature.publicKey || envelope["x-code-shadow-public-key"]
  if (!publicPem) {
    result.error = "missing public key (neither signature.publicKey nor envelope key)"
    return result
  }

  let payload
  try {
    payload = Buffer.from(String(envelope.payload || ""), "base64")
    result.statement = JSON.parse(payload.toString("utf8"))
  } catch (error) {
    result.error = `payload is not valid JSON: ${error.message}`
    return result
  }

  const publicKey = createPublicKey(publicPem)
  result.keyId = keyIdFor(publicKey)
  result.signedAt = envelope["x-code-shadow-signed-at"] || null

  if (signature.keyid && signature.keyid !== result.keyId) {
    result.error = `keyid mismatch: envelope=${signature.keyid} key=${result.keyId}`
    return result
  }

  result.valid = verify(
    null,
    pae(envelope.payloadType, payload),
    publicKey,
    Buffer.from(signature.sig, "base64"),
  )
  if (!result.valid) result.error = "signature does not match payload"
  return result
}

function summarize(verified) {
  const predicate = verified.statement && verified.statement.predicate
  return {
    valid: verified.valid,
    key_id: verified.keyId,
    signed_at: verified.signedAt ? new Date(verified.signedAt).toISOString() : null,
    statement_type: verified.statement && verified.statement._type,
    predicate_type: verified.statement && verified.statement.predicateType,
    passport_id: predicate && predicate.passportId,
    status: predicate && predicate.status,
    risk: predicate && `${predicate.riskScore}/100 (${predicate.riskLevel})`,
    intent: predicate && predicate.intent,
    subjects: verified.statement && verified.statement.subject,
    error: verified.error,
  }
}

function main(argv) {
  const args = argv.slice(2)
  const asJson = args.includes("--json")
  const file = args.find((arg) => !arg.startsWith("--"))
  if (!file) {
    process.stderr.write("usage: node scripts/verify-passport.js <file.att.json|file.intoto.jsonl> [--json]\n")
    return 2
  }

  let verified
  try {
    verified = verifyEnvelope(readEnvelope(file))
  } catch (error) {
    process.stderr.write(`cannot read envelope: ${error.message}\n`)
    return 2
  }

  const summary = summarize(verified)
  if (asJson) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else if (summary.valid) {
    process.stdout.write("VALID\n")
    process.stdout.write(`  key:       ${summary.key_id}\n`)
    process.stdout.write(`  signed:    ${summary.signed_at}\n`)
    process.stdout.write(`  predicate: ${summary.predicate_type}\n`)
    process.stdout.write(`  passport:  ${summary.passport_id} (${summary.status}, risk ${summary.risk})\n`)
    process.stdout.write(`  subjects:  ${summary.subjects.length}\n`)
    for (const subject of summary.subjects) {
      const digest = Object.entries(subject.digest)
        .map(([algorithm, value]) => `${algorithm}:${String(value).slice(0, 12)}`)
        .join(" ")
      process.stdout.write(`    - ${subject.name} (${digest})\n`)
    }
  } else {
    process.stdout.write("INVALID\n")
    process.stdout.write(`  reason: ${summary.error}\n`)
  }
  return summary.valid ? 0 : 1
}

process.exitCode = main(process.argv)
