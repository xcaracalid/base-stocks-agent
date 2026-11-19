/**
 * Canonical hashing of a stored decision record.
 *
 * The decision hash that goes onchain is keccak256 of the CANONICAL JSON of
 * the decision record — the exact record JSON the store holds, re-serialized
 * under fixed rules so the hash is reproducible by anyone, from any copy of
 * the record, regardless of key order or whitespace in the stored text.
 *
 * Canonical encoding rules (v1 — do not change without bumping the version
 * and re-hashing every record, because the onchain hash would stop matching):
 *   1. Parse the record JSON (records already stored as strings are parsed
 *      first; the stored text itself is never hashed raw).
 *   2. Recursively sort object keys lexicographically (UTF-16 code units,
 *      i.e. JS default string sort). Arrays keep their order.
 *   3. Numbers serialize with JSON.stringify (shortest round-trip form;
 *      -0 becomes 0). Strings/booleans/null serialize with JSON.stringify.
 *   4. No whitespace anywhere; UTF-8 bytes are hashed.
 *   5. Hash = keccak256(canonical bytes), returned as a 0x-prefixed hex
 *      string (the bytes32 that recordDecision() takes).
 *
 * Verification (offchain, by anyone): fetch the record (dashboard /
 * metadata URI), canonicalize it with these rules, hash it, and compare
 * with the decisionHash stored in the Attested event / getAttestation().
 */

import { keccak256 } from "../../data/src/keccak.ts";

export const CANONICAL_ENCODING_VERSION = 1;

/** Canonical JSON string for any JSON value (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    if (out === undefined) throw new Error("canonicalJson: value is not JSON-serializable");
    return out;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/**
 * Hash a decision record. Accepts either the parsed record object or the
 * record JSON string as stored in the `decision_records` table.
 */
export function hashDecisionRecord(record: unknown): string {
  const parsed = typeof record === "string" ? JSON.parse(record) : record;
  return "0x" + keccak256(canonicalJson(parsed));
}

/**
 * Hash a decision record already in the store's shape (id/runId/at/kind +
 * record_json). Only record_json is hashed — the store row metadata is
 * bookkeeping, not part of the decision.
 */
export function hashStoredDecision(recordJson: string): string {
  return hashDecisionRecord(recordJson);
}
