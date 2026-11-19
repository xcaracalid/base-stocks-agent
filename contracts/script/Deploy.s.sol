// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/DecisionAttestor.sol";

/// @notice Deploy DecisionAttestor to Base Sepolia (or any EVM chain).
/// @dev Reads the deployer key ONLY from the DEPLOYER_PRIVATE_KEY env var.
/// The script REFUSES to run when it is unset (vm.envUint reverts) — there
/// is no fallback, no key file is ever read, and nothing is deployed without
/// an explicit broadcast. DO NOT RUN until the user approves the deploy.
///
/// Usage (after approval):
///   export DEPLOYER_PRIVATE_KEY=0x...   # from the user's secure store
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url https://sepolia.base.org --broadcast --verify
contract Deploy is Script {
    function run() external returns (DecisionAttestor attestor) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        require(deployerKey != 0, "Deploy: DEPLOYER_PRIVATE_KEY is unset or zero");

        vm.startBroadcast(deployerKey);
        attestor = new DecisionAttestor();
        vm.stopBroadcast();

        console.log("DecisionAttestor deployed at:", address(attestor));
        console.log("Deployer:", vm.addr(deployerKey));
    }
}
