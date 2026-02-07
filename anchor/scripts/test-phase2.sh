#!/bin/bash
set -e

cd "$(dirname "$0")/.."

PRIVACY_YIELD_PROGRAM_ID="5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw"
MOCK_KLEND_PROGRAM_ID="CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk"

echo "=== Phase 2: Klend Integration Tests (localnet with mock-klend) ==="

# Build both programs
echo "Building privacy-yield + mock-klend..."
anchor build -- --features localnet

# Start validator with both programs
echo "Starting local validator..."
solana-test-validator \
  --bpf-program "$PRIVACY_YIELD_PROGRAM_ID" target/deploy/privacy_yield.so \
  --bpf-program "$MOCK_KLEND_PROGRAM_ID" target/deploy/mock_klend.so \
  --reset --quiet &
VALIDATOR_PID=$!

# Wait for validator
echo "Waiting for validator to start..."
for i in $(seq 1 30); do
  if solana cluster-version --url http://localhost:8899 >/dev/null 2>&1; then
    echo "Validator ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Validator failed to start"
    kill $VALIDATOR_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Airdrop SOL
solana airdrop 100 --url http://localhost:8899 >/dev/null 2>&1

# Run Phase 2 tests
echo "Running Phase 2 tests..."
ANCHOR_PROVIDER_URL=http://localhost:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
  yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/phase2_klend.ts
TEST_EXIT=$?

# Cleanup
echo "Stopping validator..."
kill $VALIDATOR_PID 2>/dev/null || true

exit $TEST_EXIT
