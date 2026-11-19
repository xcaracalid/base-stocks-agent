// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DecisionAttestor — minimal onchain log of Stock Agent on Base decisions
/// @author Stock Agent on Base (Base Stocks Maxxing, Agentic Stock Finance track)
/// @notice The agent records keccak256(canonicalJson(decisionRecord)) for every
/// decision cycle (rebalance or hold) together with the snapshot run id that
/// produced it and a metadata URI pointing at the full published record.
/// Anyone can read the log; verification is done offchain by recomputing the
/// hash from the published record and comparing it with the stored hash.
/// @dev No access control by design: this is a public append-only log, not a
/// permissioned registry. Attestations are attributable via the `attester`
/// field (event + record) and via the Builder Code (ERC-8021) the agent
/// appends to the call data when it submits. Duplicate hashes are allowed:
/// a re-attestation is a distinct log entry with its own index.
/// @dev Deployed first to Base Sepolia; mainnet only after the user approves.
contract DecisionAttestor {
    struct Attestation {
        bytes32 decisionHash;
        uint64 snapshotRunId;
        string uri;
        address attester;
        uint64 attestedAt;
    }

    Attestation[] private _attestations;

    /// @notice Emitted for every recorded decision. `index` is the log position.
    event Attested(
        uint256 indexed index,
        address indexed attester,
        bytes32 decisionHash,
        uint64 snapshotRunId,
        string uri
    );

    /// @notice Append one decision attestation to the log.
    /// @param decisionHash keccak256 of the canonical JSON of the decision record.
    /// @param snapshotRunId The snapshot-run id the decision was computed from (0 if none).
    /// @param uri Where the full decision record can be read (e.g. dashboard URL or IPFS CID).
    /// @return index Position of the new attestation in the log.
    function recordDecision(bytes32 decisionHash, uint64 snapshotRunId, string calldata uri)
        external
        returns (uint256 index)
    {
        index = _attestations.length;
        _attestations.push(
            Attestation({
                decisionHash: decisionHash,
                snapshotRunId: snapshotRunId,
                uri: uri,
                attester: msg.sender,
                // casting to 'uint64' is safe because block.timestamp fits in uint64 for ~584 billion years
                // forge-lint: disable-next-line(unsafe-typecast)
                attestedAt: uint64(block.timestamp)
            })
        );
        emit Attested(index, msg.sender, decisionHash, snapshotRunId, uri);
    }

    /// @notice Total number of attestations recorded so far.
    function attestationCount() external view returns (uint256) {
        return _attestations.length;
    }

    /// @notice Read one attestation by its log index.
    function getAttestation(uint256 index) external view returns (Attestation memory) {
        require(index < _attestations.length, "DecisionAttestor: index out of bounds");
        return _attestations[index];
    }
}
