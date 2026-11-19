// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/DecisionAttestor.sol";

contract DecisionAttestorTest is Test {
    DecisionAttestor attestor;

    bytes32 constant HASH_A = keccak256("decision-a");
    bytes32 constant HASH_B = keccak256("decision-b");
    string constant URI_A = "https://example.invalid/decisions/1.json";
    string constant URI_B = "ipfs://bafyexample";

    function setUp() public {
        attestor = new DecisionAttestor();
    }

    function test_initialCountIsZero() public view {
        assertEq(attestor.attestationCount(), 0);
    }

    function test_recordDecision_storesAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit DecisionAttestor.Attested(0, address(this), HASH_A, 7, URI_A);

        uint256 index = attestor.recordDecision(HASH_A, 7, URI_A);
        assertEq(index, 0);
        assertEq(attestor.attestationCount(), 1);

        DecisionAttestor.Attestation memory a = attestor.getAttestation(0);
        assertEq(a.decisionHash, HASH_A);
        assertEq(a.snapshotRunId, 7);
        assertEq(a.uri, URI_A);
        assertEq(a.attester, address(this));
        assertEq(a.attestedAt, uint64(block.timestamp));
    }

    function test_secondAttestationGetsNextIndex() public {
        attestor.recordDecision(HASH_A, 7, URI_A);
        uint256 index = attestor.recordDecision(HASH_B, 8, URI_B);
        assertEq(index, 1);
        assertEq(attestor.attestationCount(), 2);

        DecisionAttestor.Attestation memory b = attestor.getAttestation(1);
        assertEq(b.decisionHash, HASH_B);
        assertEq(b.snapshotRunId, 8);
        assertEq(b.uri, URI_B);
    }

    function test_attesterIsCaller() public {
        address agent = address(0xA11CE);
        vm.prank(agent);
        attestor.recordDecision(HASH_A, 1, URI_A);
        assertEq(attestor.getAttestation(0).attester, agent);
    }

    function test_duplicateHashAllowedAsSeparateEntry() public {
        attestor.recordDecision(HASH_A, 7, URI_A);
        attestor.recordDecision(HASH_A, 7, URI_A);
        assertEq(attestor.attestationCount(), 2);
        assertEq(attestor.getAttestation(1).decisionHash, HASH_A);
    }

    function test_emptyUriAllowed() public {
        attestor.recordDecision(HASH_A, 0, "");
        assertEq(attestor.getAttestation(0).uri, "");
        assertEq(attestor.getAttestation(0).snapshotRunId, 0);
    }

    function test_getAttestation_revertsOutOfBounds() public {
        vm.expectRevert("DecisionAttestor: index out of bounds");
        attestor.getAttestation(0);

        attestor.recordDecision(HASH_A, 1, URI_A);
        vm.expectRevert("DecisionAttestor: index out of bounds");
        attestor.getAttestation(1);
    }
}
