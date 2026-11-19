# Contracts

## DecisionAttestor — built, tested, NOT deployed

`src/DecisionAttestor.sol` (Solidity 0.8.24, no dependencies) is the minimal
onchain log of the agent's decisions:

- `recordDecision(bytes32 decisionHash, uint64 snapshotRunId, string uri)`
  appends one attestation and emits `Attested(index, attester, decisionHash,
  snapshotRunId, uri)`.
- Read API: `attestationCount()` + `getAttestation(uint256 index)` (returns
  hash, run id, uri, attester, attestedAt).
- No access control by design: a public append-only log. Attribution comes
  from the `attester` field and from the Builder Code (ERC-8021) the agent
  appends to the calldata when it submits.

### Agent side (`packages/attestation/`)

- `src/canonical.ts` — canonical JSON rules (sorted keys, no whitespace) +
  `hashDecisionRecord()` = keccak256 of the canonical record. The onchain
  hash is reproducible by anyone from the published record.
- `src/submit.ts` — hand-rolled ABI encoding of `recordDecision` +
  `submitAttestation()`, which REFUSES to run unless a deployed attestor
  address AND a signer/transport are explicitly configured. It is never
  invoked by the agent loop in this build.

### Tests

- `forge test` — 7 tests, all passing (`npm run test:contracts`).
- `npm test` — 23 tests total (12 portfolio rules + 11 attestation),
  all passing. The TS selector (`0xb157b643`) and sample calldata were
  cross-checked with `cast sig` / `cast calldata-decode`.

### Deploy — WAITING FOR USER APPROVAL

- Script: `script/Deploy.s.sol` — reads the deployer key ONLY from the
  `DEPLOYER_PRIVATE_KEY` env var and reverts when unset (verified: it
  refuses with `vm.envUint: environment variable "DEPLOYER_PRIVATE_KEY"
  not found`). It never reads a key file. **Do not run it until the user
  approves the deploy.**
- Target: Base Sepolia (chain 84532). Deployer EOA
  `0x483C4569a73a886048cc03Ec09Fd30C8d91358Ec` is already funded:
  **0.04999999987532768 ETH** (verified read-only 2026-11-20).
- After approval:
  ```
  export DEPLOYER_PRIVATE_KEY=0x...   # from the user's secure store
  forge script script/Deploy.s.sol:Deploy \
    --rpc-url https://sepolia.base.org --broadcast --verify
  ```
  Then record the deployed address in `ATTESTOR_ADDRESS` for the agent,
  and verify attribution on Sepolia before any mainnet step (Nov 29).

No execution/swap contracts are planned for the core entry: the Tokenized
Stocks API has no trading endpoints, and the optional user-gated execution
module (Aerodrome router, policy limits, kill switch) is Sepolia-first and
OFF by default.
