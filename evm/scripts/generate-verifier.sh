#!/bin/bash
# Generate Groth16 Solidity verifier from circuit zkey
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVM_DIR="$(dirname "$SCRIPT_DIR")"
ARTIFACTS_DIR="$EVM_DIR/../artifacts"

echo "Generating Verifier.sol from transaction2.zkey..."
npx snarkjs zkey export solidityverifier \
  "$ARTIFACTS_DIR/transaction2.zkey" \
  "$EVM_DIR/contracts/Verifier.sol"

echo "Done. Run 'npx hardhat compile' to compile."
