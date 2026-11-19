/**
 * Submit a decision attestation to the DecisionAttestor contract.
 *
 * THIS MODULE IS NEVER INVOKED BY THE AGENT LOOP IN THIS BUILD. It exists so
 * the deploy step has a reviewed, gated path — and so the gate itself is
 * testable. The function REFUSES to run unless BOTH are explicitly
 * configured:
 *   - attestorAddress: the deployed DecisionAttestor contract address, and
 *   - sendTransaction: a caller-supplied signer/transport (the agent has
 *     no wallet of its own in this build; the deployer key is never read
 *     or used by this code).
 * Without either one, submitAttestation() throws before building or sending
 * anything. There is no default address, no default RPC, no fallback key.
 *
 * Calldata is ABI-encoded here by hand (zero-dependency rule kept) for
 *   recordDecision(bytes32 decisionHash, uint64 snapshotRunId, string uri)
 * An optional Builder Code (ERC-8021) is appended as raw bytes AFTER the
 * ABI-encoded arguments — the contract ignores trailing calldata, and
 * attribution is read offchain from the submitted transaction.
 */

import { functionSelector } from "../../data/src/keccak.ts";

export const RECORD_DECISION_SELECTOR = functionSelector(
  "recordDecision(bytes32,uint64,string)",
);

export interface AttestationInput {
  /** 0x-prefixed 32-byte hash from hashDecisionRecord(). */
  decisionHash: string;
  /** Snapshot run id the decision was computed from (0 if none). */
  snapshotRunId: number;
  /** Where the full decision record can be read. */
  uri: string;
}

export interface AttestationConfig {
  /** Deployed DecisionAttestor address. REQUIRED — no default. */
  attestorAddress?: string;
  /**
   * Signer/transport. Called with the unsigned tx {to, data, value} and
   * must return the submitted transaction hash. REQUIRED — no default.
   * The agent loop does not supply one; only an explicit, user-approved
   * deploy/attest step may.
   */
  sendTransaction?: (tx: { to: string; data: string; value: string }) => Promise<string>;
  /** Optional Builder Code bytes (0x-prefixed hex) appended to calldata (ERC-8021). */
  builderCode?: string;
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isHex(value: string): boolean {
  return /^0x([0-9a-fA-F]{2})*$/.test(value);
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/**
 * ABI-encode recordDecision(decisionHash, snapshotRunId, uri) call data.
 * Throws on malformed inputs. Does not send anything.
 */
export function encodeRecordDecision(input: AttestationInput, builderCode?: string): string {
  if (!isBytes32(input.decisionHash)) {
    throw new Error(`encodeRecordDecision: decisionHash must be 0x + 64 hex chars, got ${input.decisionHash}`);
  }
  if (!Number.isInteger(input.snapshotRunId) || input.snapshotRunId < 0 || input.snapshotRunId > 2 ** 64 - 1) {
    throw new Error(`encodeRecordDecision: snapshotRunId must be a uint64, got ${input.snapshotRunId}`);
  }
  if (typeof input.uri !== "string") {
    throw new Error("encodeRecordDecision: uri must be a string");
  }
  if (builderCode !== undefined && !isHex(builderCode)) {
    throw new Error(`encodeRecordDecision: builderCode must be 0x-prefixed hex, got ${builderCode}`);
  }

  const uriBytes = new TextEncoder().encode(input.uri);
  const paddedLen = Math.ceil(uriBytes.length / 32) * 32;
  const tail = new Uint8Array(paddedLen);
  tail.set(uriBytes);

  // head: selector | bytes32 hash | uint64 run id | offset to string (96)
  // tail: string length | string bytes padded to 32
  let data = RECORD_DECISION_SELECTOR;
  data += input.decisionHash.slice(2);
  data += word(BigInt(input.snapshotRunId));
  data += word(96n);
  data += word(BigInt(uriBytes.length));
  data += Buffer.from(tail).toString("hex");
  if (builderCode !== undefined) data += builderCode.slice(2);
  return data;
}

/** Build the unsigned transaction for an attestation. Does not send anything. */
export function prepareAttestation(
  config: AttestationConfig,
  input: AttestationInput,
): { to: string; data: string; value: string } {
  if (!config.attestorAddress || !isAddress(config.attestorAddress)) {
    throw new Error(
      "attestation not configured: ATTESTOR_ADDRESS is unset or not a valid address — refusing to submit",
    );
  }
  return {
    to: config.attestorAddress,
    data: encodeRecordDecision(input, config.builderCode),
    value: "0x0",
  };
}

/**
 * Submit an attestation. Refuses unless attestorAddress AND a
 * sendTransaction signer are explicitly configured. Returns the tx hash
 * from the supplied transport.
 */
export async function submitAttestation(
  config: AttestationConfig,
  input: AttestationInput,
): Promise<string> {
  const tx = prepareAttestation(config, input);
  if (typeof config.sendTransaction !== "function") {
    throw new Error(
      "attestation not configured: no signer/transport supplied — refusing to submit",
    );
  }
  return config.sendTransaction(tx);
}
