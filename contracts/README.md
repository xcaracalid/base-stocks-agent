# Contracts (placeholder)

Planned for **Nov 23** (Base Sepolia) and **Nov 29** (Base mainnet):

## Decision attestation contract

A minimal contract that logs the agent's decision hashes on Base:

- `attest(bytes32 decisionHash, string metadataUri)` — records the hash of a
  decision record (inputs, scores, action, rationale) plus a URI pointing at
  the full record.
- Every agent decision (paper trade, rebalance, no-action review) gets one
  attestation, so the agent's activity is publicly verifiable onchain.
- Attestation calls carry the project's **Builder Code** appended to the
  calldata (Base's ERC-8021 attribution standard), so agent activity is
  attributable — the quest scores traction on real onchain usage.
- The attesting wallet is a fresh, low-value agent wallet (created at deploy
  time, never a user wallet). Paper mode needs no funds beyond attestation
  gas; on Sepolia that is faucet-funded.

No execution/swap contracts are planned for the core entry: the Tokenized
Stocks API has no trading endpoints, and the optional user-gated execution
module (Aerodrome router, policy limits, kill switch) is Sepolia-first and
OFF by default.
