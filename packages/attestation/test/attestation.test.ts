/**
 * Tests for the attestation layer (canonical hash + gated submit).
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalJson,
  hashDecisionRecord,
  hashStoredDecision,
} from "../src/canonical.ts";
import {
  RECORD_DECISION_SELECTOR,
  encodeRecordDecision,
  prepareAttestation,
  submitAttestation,
} from "../src/submit.ts";

const SAMPLE_RECORD = {
  version: 1,
  at: "2026-11-19T13:57:56.000Z",
  runId: 7,
  kind: "hold",
  equityUsdc: 100000,
  cashAfterUsdc: 0,
  universe: [{ symbol: "AAPLc", compositeScore: 0.03, navPrice: 354.7244 }],
  rationale: "Hold.",
};

// Golden values computed from the rules in canonical.ts / submit.ts and
// independently cross-checked: selector via `cast sig`, calldata via
// `cast calldata-decode` (see BUILD-LOG session 6).
const GOLDEN_HASH = "0x2c06099001cccad12de37d4fcc01965d715233505a0273a888be3e0f775d251c";
const GOLDEN_CALLDATA =
  "0xb157b643" +
  "2c06099001cccad12de37d4fcc01965d715233505a0273a888be3e0f775d251c" +
  "0000000000000000000000000000000000000000000000000000000000000007" +
  "0000000000000000000000000000000000000000000000000000000000000060" +
  "0000000000000000000000000000000000000000000000000000000000000028" +
  "68747470733a2f2f6578616d706c652e696e76616c69642f6465636973696f6e732f312e6a736f6e" +
  "000000000000000000000000000000000000000000000000";

test("selector matches the compiled contract (cast-verified 0xb157b643)", () => {
  assert.equal(RECORD_DECISION_SELECTOR, "0xb157b643");
});

test("canonicalJson sorts keys recursively, arrays keep order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
  assert.equal(canonicalJson({ z: [3, 2, 1] }), '{"z":[3,2,1]}');
  assert.equal(canonicalJson({ a: null, b: true, c: "x" }), '{"a":null,"b":true,"c":"x"}');
});

test("hash is independent of key order and stored whitespace", () => {
  const reordered = {
    rationale: "Hold.",
    universe: [{ navPrice: 354.7244, symbol: "AAPLc", compositeScore: 0.03 }],
    cashAfterUsdc: 0,
    equityUsdc: 100000,
    kind: "hold",
    runId: 7,
    at: "2026-11-19T13:57:56.000Z",
    version: 1,
  };
  assert.equal(hashDecisionRecord(reordered), GOLDEN_HASH);
  assert.equal(hashDecisionRecord(SAMPLE_RECORD), GOLDEN_HASH);
  // Same record as a pretty-printed JSON string (as the store holds it).
  assert.equal(hashStoredDecision(JSON.stringify(SAMPLE_RECORD, null, 2)), GOLDEN_HASH);
});

test("hash changes when any field changes", () => {
  assert.notEqual(hashDecisionRecord({ ...SAMPLE_RECORD, kind: "rebalance" }), GOLDEN_HASH);
  assert.notEqual(
    hashDecisionRecord({
      ...SAMPLE_RECORD,
      universe: [{ symbol: "AAPLc", compositeScore: 0.04, navPrice: 354.7244 }],
    }),
    GOLDEN_HASH,
  );
});

test("encodeRecordDecision produces cast-decodable calldata", () => {
  const data = encodeRecordDecision({
    decisionHash: GOLDEN_HASH,
    snapshotRunId: 7,
    uri: "https://example.invalid/decisions/1.json",
  });
  assert.equal(data, GOLDEN_CALLDATA);
});

test("builder code is appended after the encoded args", () => {
  const data = encodeRecordDecision(
    { decisionHash: GOLDEN_HASH, snapshotRunId: 7, uri: "" },
    "0xdeadbeef",
  );
  assert.ok(data.endsWith("deadbeef"));
  assert.ok(data.startsWith(RECORD_DECISION_SELECTOR));
});

test("encode rejects malformed inputs", () => {
  assert.throws(() => encodeRecordDecision({ decisionHash: "0x1234", snapshotRunId: 1, uri: "" }), /decisionHash/);
  assert.throws(() => encodeRecordDecision({ decisionHash: GOLDEN_HASH, snapshotRunId: -1, uri: "" }), /snapshotRunId/);
  assert.throws(() => encodeRecordDecision({ decisionHash: GOLDEN_HASH, snapshotRunId: 1, uri: "" }, "deadbeef"), /builderCode/);
});

test("submit refuses without an attestor address", async () => {
  await assert.rejects(
    () =>
      submitAttestation(
        { sendTransaction: async () => "0x0" },
        { decisionHash: GOLDEN_HASH, snapshotRunId: 7, uri: "" },
      ),
    /ATTESTOR_ADDRESS/,
  );
  await assert.rejects(
    () =>
      submitAttestation(
        { attestorAddress: "not-an-address", sendTransaction: async () => "0x0" },
        { decisionHash: GOLDEN_HASH, snapshotRunId: 7, uri: "" },
      ),
    /ATTESTOR_ADDRESS/,
  );
});

test("submit refuses without a signer/transport", async () => {
  await assert.rejects(
    () =>
      submitAttestation(
        { attestorAddress: "0x0000000000000000000000000000000000000001" },
        { decisionHash: GOLDEN_HASH, snapshotRunId: 7, uri: "" },
      ),
    /no signer\/transport/,
  );
});

test("submit with a stub transport sends the prepared tx and nothing else", async () => {
  const seen: Array<{ to: string; data: string; value: string }> = [];
  const hash = await submitAttestation(
    {
      attestorAddress: "0x0000000000000000000000000000000000000001",
      sendTransaction: async (tx) => {
        seen.push(tx);
        return "0xabc123";
      },
    },
    { decisionHash: GOLDEN_HASH, snapshotRunId: 7, uri: "https://example.invalid/decisions/1.json" },
  );
  assert.equal(hash, "0xabc123");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].to, "0x0000000000000000000000000000000000000001");
  assert.equal(seen[0].data, GOLDEN_CALLDATA);
  assert.equal(seen[0].value, "0x0");
});

test("prepareAttestation alone never sends", () => {
  const tx = prepareAttestation(
    { attestorAddress: "0x0000000000000000000000000000000000000001" },
    { decisionHash: GOLDEN_HASH, snapshotRunId: 7, uri: "" },
  );
  assert.equal(tx.to, "0x0000000000000000000000000000000000000001");
  assert.ok(tx.data.startsWith(RECORD_DECISION_SELECTOR));
});
