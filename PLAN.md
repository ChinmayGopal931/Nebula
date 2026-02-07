# Privacy Yield Protocol — Architecture Plan

A privacy protocol on Solana that breaks the link between deposits and withdrawals while earning yield on idle funds via Kamino. Uses ZK proofs for privacy and Arcium MPC for metadata protection.

---

## How It Works (30-Second Summary)

User deposits USDC into a shielded pool. The pool puts funds into Kamino to earn yield. User withdraws (fully or partially) to any address later — no one can link the withdrawal to the deposit. The user keeps a secret "receipt" that proves ownership. ZK proofs verify everything on-chain without revealing which deposit is being spent.

---

## Core Architecture

Three layers, each doing what it's best at:

```
ZK LAYER — Privacy (IMPLEMENTED)
  Merkle tree of commitments (USDC-denominated)
  Nullifiers prevent double-spending
  User generates proofs locally (snarkjs, Groth16)
  On-chain Groth16 verification via Solana's alt_bn128 precompile
  Scales to millions of deposits with O(1) on-chain storage

SOLANA PROGRAM — Pool Logic + Yield (IMPLEMENTED)
  Manages the Merkle tree (26 hashes + root + 100-entry history)
  Verifies ZK proofs
  Manages nullifier PDAs
  Holds USDC in pool vault (ATA owned by pool_config PDA)
  Holds cTokens from Kamino (ATA owned by pool_config PDA)
  Executes Kamino deposit/redeem via CPI to klend

ARCIUM MPC — Metadata Privacy (PLANNED)
  Private relayer: users submit encrypted withdrawal requests
  Batch submission: multiple withdrawals submitted together
  No single party sees the full request (IP + withdrawal details)
  Adds timing privacy that ZK alone cannot provide
```

---

## The UTXO Model

Every transaction has exactly 2 inputs and 2 outputs. This is what enables partial withdrawals, merging, and private transfers.

A UTXO (Unspent Transaction Output) represents a deposit or a "change" leftover:

```
UTXO = {
  amount          — how much USDC this UTXO represents (raw token amount)
  pubkey          — Poseidon(privateKey), identifies the owner
  blinding        — random value, makes the commitment unique
  mint            — token identifier (USDC pool ID)
}

commitment = Poseidon(amount, pubkey, blinding, mint)
```

The commitment is a 32-byte hash stored in the Merkle tree. It reveals nothing about the amount, owner, or blinding factor.

> **Current Implementation**: Commitments encode raw USDC amounts. Yield is earned collectively on the pool's funds via Kamino, but is not tracked per-UTXO. The user withdraws the same USDC amount they committed to.
>
> **Future Enhancement — kUSDC Exchange Rate Model**: The commitment could encode kUSDC (Kamino's yield-bearing token) rather than raw USDC. As time passes, the kUSDC exchange rate increases. When the user withdraws, their kUSDC is worth more USDC than when they deposited. This would enable per-user yield tracking without extra accounting. This is not yet implemented.

### Transaction Types

All transactions use the same circuit (2 inputs, 2 outputs). The `publicAmount` field determines the type:

**Deposit (publicAmount > 0):**
```
Inputs:  [empty(0), empty(0)]
Outputs: [UTXO(1000 USDC), empty(0)]
publicAmount: +1000 USDC
User sends USDC to pool vault
```

**Full Withdrawal (publicAmount < 0):**
```
Inputs:  [UTXO(1000 USDC), empty(0)]
Outputs: [empty(0), empty(0)]
publicAmount: -1000 USDC
Pool sends USDC from vault to recipient
```

**Partial Withdrawal (publicAmount < 0, with change):**
```
Inputs:  [UTXO(1000 USDC), empty(0)]
Outputs: [UTXO(500 USDC), empty(0)]    ← change stays in pool
publicAmount: -500 USDC                  ← only withdrawing part
Pool sends 500 USDC from vault to recipient
User saves new receipt for the 500 USDC change UTXO
```

**Merge (publicAmount = 0):**
```
Inputs:  [UTXO(300 USDC), UTXO(200 USDC)]
Outputs: [UTXO(500 USDC), empty(0)]
publicAmount: 0
No USDC moves. Just consolidates two UTXOs into one.
```

**Private Transfer (publicAmount = 0):**
```
Inputs:  [UTXO(500 USDC, my_key), empty(0)]
Outputs: [UTXO(500 USDC, recipient_key), empty(0)]
publicAmount: 0
No USDC moves. Ownership transfers inside the pool.
```

---

## Deposit Flow

1. User's client generates a new random `privateKey` and `blinding`
2. Client computes `commitment = Poseidon(amount, Poseidon(privateKey), blinding, mint)`
3. Client generates ZK proof for the deposit transaction (2 empty inputs, 1 real output)
4. User submits `transact` instruction to Solana program with the USDC transfer + proof
5. Program verifies proof, receives USDC into pool vault, adds commitment to Merkle tree
6. Program emits event: `{ leafIndex, commitment, encryptedOutput }`
7. **User saves their receipt locally**: `{ privateKey, blinding, amount, leafIndex }`

The receipt is the user's only proof of ownership. Lose it = lose funds. The protocol stores nothing per user.

### Kamino Deposit (Implemented)

After a deposit, anyone can call the permissionless `kamino_deposit` instruction to move ALL vault USDC into Kamino (klend) and receive cTokens. This can be bundled in the same versioned transaction as the deposit itself (transact + kaminoDeposit in one tx).

```
kamino_deposit instruction (implemented):
  - Moves ALL pool vault USDC to klend via CPI
  - Receives cTokens (1:1 with mock-klend, exchange-rate-based with real klend)
  - No threshold check — deposits everything
  - Permissionless — any signer can call
  - No-op if vault balance is zero
```

> **Future Enhancement — Sweep Threshold**: A threshold-based sweep could keep some USDC in reserve for near-term withdrawals (e.g., only sweep when vault > 10,000 USDC, keep half as reserve). Currently the implementation moves all funds, requiring a `kamino_redeem` before any withdrawal.

---

## Withdrawal Flow

### Step 1 — User Rebuilds Merkle Tree (client-side)

The client fetches all deposit events from Solana (via RPC or indexer). Each event contains a `leafIndex` and `commitment`. The client rebuilds the full Merkle tree in memory and computes the authentication path (26 sibling hashes) for their leaf.

### Step 2 — User Generates ZK Proof (client-side)

The Circom circuit proves:
- The user knows a commitment in the Merkle tree (inclusion proof)
- The user knows the secret preimage of that commitment (ownership)
- The nullifier is correctly derived (unique, deterministic)
- Balance conservation: sum(input amounts) + publicAmount = sum(output amounts)

Private inputs (never leave user's machine):
- amount, privateKey, blinding (from receipt)
- Merkle path elements (26 sibling hashes)
- Path indices (leaf position encoded as bits)
- Output UTXO details (for change, if partial withdrawal)

Public outputs (go on-chain):
- Merkle root (program verifies it's in root_history)
- Nullifier(s) (program creates PDA to prevent reuse)
- publicAmount (USDC being withdrawn, negative value)
- extDataHash (SHA256 of recipient address + fee + encrypted outputs)
- Output commitments (for change UTXOs, added to tree)

### Step 3 — Submit via Arcium Private Relayer

Instead of submitting directly (which would link the user's IP to the withdrawal address), the user encrypts their proof + transaction data to the Arcium MPC cluster.

The MPC cluster:
- Receives the encrypted request (no single node sees the full request)
- Decrypts internally via MPC (threshold — requires multiple nodes to cooperate)
- Holds the request until a batch window (e.g., every 15 minutes)
- Submits a batch of withdrawals to Solana as a single set of transactions
- Earns relayer fee from each withdrawal

Privacy gained:
- **IP privacy**: No single server sees "IP X requested withdrawal to address Y"
- **Timing privacy**: Individual withdrawal timing is masked by batching. Observer sees 5 withdrawals land simultaneously, can't attribute individual timing.

### Step 4 — On-Chain Verification

The Solana program (`transact` instruction):
1. Verifies the Groth16 proof (alt_bn128 pairing check, ~200K compute units)
2. Checks the Merkle root is in root_history (last 100 roots)
3. Creates nullifier PDA(s) — fails if already exists (double-spend prevention)
4. Adds output commitments to Merkle tree (change UTXOs)
5. Verifies extDataHash matches the provided recipient, fee, etc.
6. Transfers USDC from pool vault to recipient (raw USDC amount, no rate conversion)

> **Current Implementation**: `transact` pays directly from the pool vault in raw USDC. If funds are in Kamino, the caller must first call `kamino_redeem` to move USDC back to the vault. This can be bundled in a single versioned transaction (kaminoRedeem + transact). Fees are set to 0 in Phase 1.
>
> **Future Enhancement — Automatic Redemption**: The `transact` instruction could automatically redeem from Kamino when the vault has insufficient USDC, compute USDC payout using kUSDC exchange rates, and deduct protocol fees. This is not yet implemented.

---

## Partial Withdrawal — Detailed Example

Alice deposited 100 USDC at leaf index 4271. She wants to withdraw 50 USDC and leave the rest.

**Alice's client computes:**
```
my USDC = 100 (from saved receipt)

I want 50 USDC out:
  withdraw = 50 USDC
  change = 100 - 50 = 50 USDC

Generate NEW privateKey and blinding for the change UTXO
change_commitment = Poseidon(50, new_pubkey, new_blinding, mint)
```

**Transaction:**
```
Input 0:  UTXO(100 USDC, old_key)   → nullified
Input 1:  empty(0)                    → padding
Output 0: UTXO(50 USDC, new_key)    → new commitment added to tree
Output 1: empty(0)                    → padding
publicAmount: -50 USDC

Balance: 100 + 0 + (-50) = 50 + 0
```

**On-chain program (current implementation):**
- Caller first calls `kamino_redeem` to move USDC from Kamino back to vault (can be bundled in same tx)
- `transact` nullifies old UTXO (creates nullifier PDA)
- Adds change commitment to Merkle tree at next available leaf
- Transfers 50 USDC from pool vault to Alice's recipient address
- No fee deduction in Phase 1

**Alice saves:**
```
OLD receipt: { key: 0xaaa, blinding: 0xbbb, amount: 100, leaf: 4271 }
  → DELETE (nullified, useless now)

NEW receipt: { key: 0xccc, blinding: 0xddd, amount: 50, leaf: 8530 }
  → SAVE (this is her remaining funds)
```

Later, Alice can withdraw the remaining 50 USDC.

---

## Arcium's Role — Private Batch Relayer (Deposits + Withdrawals)

### The Problem Arcium Solves

ZK proofs hide WHICH deposit is being withdrawn. But they don't hide metadata:

- A centralized relayer sees the user's IP address alongside their request
- Each deposit/withdrawal lands on-chain at a specific time — an observer can correlate off-chain activity with on-chain timing
- If a user submits their own transaction, their wallet address is the `signer` — permanently linking identity to the transaction
- For withdrawals, the recipient wallet needs SOL for gas, creating a funding link

### Private Batch Relayer (Arcium MPC)

The user encrypts their entire transaction (deposit OR withdrawal — proof + signed tx) to the Arcium MPC cluster's public key. No single MPC node can decrypt the request alone — threshold decryption requires cooperation of multiple nodes.

```
DEPOSIT FLOW:
  User → sign deposit tx (durable nonce) → encrypt to MPC → Arcium cluster
                                                              │
  MPC internally:
    - Decrypts the request
    - Validates proof format
    - Holds in encrypted queue
    - When batch window arrives:
        shuffles queue order (ArcisRNG)
        submits all deposit transactions to Solana
    - MPC cluster pays gas (reimbursed from protocol fees)

WITHDRAWAL FLOW:
  User → sign withdrawal tx (durable nonce) → encrypt to MPC → Arcium cluster
                                                                 │
  MPC internally:
    - Decrypts the request
    - Validates proof format
    - Holds in encrypted queue
    - When batch window arrives:
        shuffles queue order (ArcisRNG)
        submits all withdrawal transactions to Solana
    - MPC cluster pays gas (reimbursed from relayer fee)
```

### Batch Submission with Shuffling

Instead of each transaction being a separate on-chain event at a distinct timestamp, the MPC cluster collects requests over a time window (e.g., 15 minutes) and submits them together in a **randomly shuffled order**.

An observer sees: "at 3:15 PM, 7 transactions happened." They cannot determine which request arrived at 3:01 vs 3:14, and the submission order is randomized so it doesn't correlate with arrival order. All users in a batch share the same timestamp, multiplying each other's timing privacy.

With 1000+ active users, batch windows would contain many transactions, making timing analysis impractical.

### Durable Nonces for Sign Batching

Solana transactions normally expire after ~2 minutes (tied to a recent blockhash). To allow Arcium to hold signed transactions for batching, we use **durable nonces**:

1. Each user creates a durable nonce account (one-time setup, reusable)
2. User builds their transaction using the durable nonce instead of a recent blockhash
3. User signs the transaction locally
4. User encrypts the signed transaction and sends it to the Arcium MPC cluster
5. The transaction remains valid indefinitely (durable nonces don't expire)
6. When the batch window arrives, Arcium submits the transaction and advances the nonce

This means the user signs once, and Arcium submits whenever the batch is ready — no escrow, no second address, no intermediate step.

### Why Arcium (Not Just Any Relayer)

A centralized relayer server COULD batch transactions. But:
- The server operator sees all requests in plaintext — IP addresses, amounts, recipient addresses
- A compromised or subpoenaed relayer leaks this metadata
- Users must trust the relayer operator

With Arcium MPC:
- No single node sees the full request
- Threshold decryption means a majority of nodes must collude to extract metadata
- Arcium nodes are independently operated and staked (economic disincentive to collude)
- The trust model matches the privacy guarantees of the rest of the protocol

### Arcium Circuit Design

Three MPC circuits needed:

**Circuit 1 — Queue Request (deposits and withdrawals)**
```
Input: encrypted signed transaction (durable nonce, ZK proof included)
Logic:
  - Decrypt request
  - Basic validation (proof format, fee is acceptable, nonce account valid)
  - Store in encrypted internal queue (separate queues for deposits and withdrawals)
Output: acknowledgment to user (request accepted)
```

**Circuit 2 — Submit Deposit Batch**
```
Triggered: on a timer (every N minutes) or when deposit queue reaches N items
Logic:
  - Read all queued deposit transactions
  - Shuffle order using ArcisRNG
  - Submit all transactions to Solana
  - Advance each user's durable nonce
  - Clear queue
Output: transaction signatures (returned to users or emitted as events)
```

**Circuit 3 — Submit Withdrawal Batch**
```
Triggered: on a timer (every N minutes) or when withdrawal queue reaches N items
Logic:
  - Read all queued withdrawal transactions
  - Shuffle order using ArcisRNG
  - Submit all transactions to Solana (MPC cluster pays gas)
  - Advance each user's durable nonce
  - Clear queue
Output: transaction signatures (returned to users or emitted as events)
```

The queues exist only within MPC computation state — not stored on-chain, not visible to anyone.

---

## On-Chain State

The Solana program's total state:

```
MerkleTreeAccount (~4 KB, zero_copy):
  authority:         Pubkey (program upgrade authority)
  next_index:        u64 (next leaf position)
  subtrees:          [u8; 32] x 26 (one hash per level)
  root:              [u8; 32] (current root)
  root_history:      [u8; 32] x 100 (circular buffer of recent roots)
  root_index:        u64 (position in circular buffer)
  max_deposit_amount: u64 (1M USDC)
  height:            u8 (26)
  root_history_size: u8 (100)
  bump:              u8

PoolConfig Account:
  authority:     Pubkey (pool authority)
  usdc_mint:     Pubkey (USDC token mint)
  bump:          u8

KlendConfig Account (Phase 2):
  authority:                Pubkey
  klend_program:            Pubkey (klend/mock-klend program ID)
  lending_market:           Pubkey
  reserve:                  Pubkey
  lending_market_authority: Pubkey (LMA PDA)
  reserve_liquidity_supply: Pubkey
  reserve_collateral_mint:  Pubkey (cToken mint)
  bump:                     u8

Token Accounts (ATAs owned by pool_config PDA):
  pool_vault:         USDC reserve (receives deposits, pays withdrawals)
  pool_ctoken_account: cTokens from klend (yield-bearing position)

Nullifier Accounts (created per spent UTXO):
  Two PDAs per transaction: nullifier0 and nullifier1, seeded by slot + nullifier value
  Created with Anchor's `init` (fails if exists = double-spend caught)
  Cross-check PDAs verify nullifiers haven't been swapped between slots
```

Total fixed storage: ~4 KB for the Merkle tree + config accounts. Grows only by nullifier PDAs per withdrawal.

For 10,000 completed withdrawals: ~1 MB of nullifier PDAs. Manageable on Solana.

---

## ZK Circuit

The Circom circuit is reused directly from privacy-cash's transaction circuit (same artifacts: `transaction2.wasm`, `transaction2.zkey`, `verifyingkey2.json`). Amounts represent raw USDC token amounts (6 decimals).

**Circuit template: Transaction(levels=26, nIns=2, nOuts=2)**

Public signals (7 values, verified on-chain):
1. `root` — Merkle tree root
2. `publicAmount` — USDC entering or leaving the pool (positive = deposit, negative = withdrawal)
3. `extDataHash` — SHA256 binding recipient, fee, encrypted outputs
4. `inputNullifier[0]` — nullifier for first input UTXO
5. `inputNullifier[1]` — nullifier for second input UTXO
6. `outputCommitment[0]` — commitment for first output UTXO (e.g., change)
7. `outputCommitment[1]` — commitment for second output UTXO

Private signals (known only to prover):
- Per input: amount, privateKey, blinding, pathIndices, pathElements[26]
- Per output: amount, pubkey, blinding

**Constraints enforced by the circuit:**
1. Each input commitment = Poseidon(amount, Poseidon(privateKey), blinding, mint)
2. Each input's Merkle proof reconstructs the public root
3. Each nullifier = Poseidon(commitment, pathIndices, Poseidon(privateKey, commitment, pathIndices))
4. Input nullifiers are unique (no double-input)
5. Each output commitment = Poseidon(amount, pubkey, blinding, mint)
6. Output amounts fit in 248 bits (prevents field overflow)
7. **sum(input amounts) + publicAmount = sum(output amounts)** (conservation)

The extDataHash binds all transaction metadata (recipient, fee, encrypted output data) to the proof. If anyone tampers with any field, the proof becomes invalid.

### Trusted Setup

Groth16 requires a one-time trusted setup ceremony to generate:
- `proving_key.zkey` — used by clients to generate proofs (~50-100 MB)
- `verification_key.json` — embedded in the Solana program (~1 KB)

The ceremony must ensure that the "toxic waste" (random values used during setup) is destroyed. Standard approach: multi-party ceremony where 10-50+ participants each contribute randomness. If ANY ONE participant destroys their contribution, the setup is secure.

For development/testnet: single-party setup is fine.
For mainnet: public ceremony with community participants.

---

## Kamino Integration (Implemented)

### Architecture

The privacy-yield program integrates with Kamino Lending (klend) via three instructions added in Phase 2:

```
configure_klend  — One-time setup: stores klend addresses in KlendConfig PDA, creates pool cToken ATA
kamino_deposit   — Moves ALL pool vault USDC into klend, receives cTokens
kamino_redeem    — Burns ALL pool cTokens, receives USDC back to pool vault
```

The `KlendConfig` PDA stores the klend program ID at runtime, so switching between mock-klend (devnet/localnet) and real klend (mainnet) requires no code changes — just calling `configure_klend` with different addresses.

### CPI Approach

The program uses raw `invoke_signed` CPI (not Anchor CPI) in `klend_cpi.rs`. Discriminators are hardcoded as `sha256("global:<instruction_name>")[0..8]`, matching Anchor's auto-generated discriminators. The pool_config PDA signs as the "owner" for klend operations. Each CPI passes 12 accounts in the exact order klend expects.

### kamino_deposit (USDC -> Kamino)

Permissionless instruction. Anyone can call it.

```
kamino_deposit (implemented):
  - Reads pool_vault.amount
  - If amount == 0: no-op (returns Ok)
  - Otherwise: CPI to klend deposit_reserve_liquidity with ALL vault USDC
  - Receives cTokens into pool_ctoken_account (ATA owned by pool_config PDA)
  - All klend accounts validated against KlendConfig PDA
```

### kamino_redeem (Kamino -> USDC)

Permissionless instruction. Anyone can call it.

```
kamino_redeem (implemented):
  - Reads pool_ctoken_account.amount
  - If collateral_amount == 0: no-op (returns Ok)
  - Otherwise: CPI to klend redeem_reserve_collateral with ALL cTokens
  - Receives USDC back into pool_vault
  - All klend accounts validated against KlendConfig PDA
```

### Bundled Transactions

Deposit and redeem can be bundled with `transact` in a single versioned transaction using an Address Lookup Table:

```
Deposit bundle:  computeBudget + transact(deposit) + kaminoDeposit
  → User deposits USDC, then immediately sweeps to Kamino (1 tx, 1 signature)

Withdrawal bundle:  computeBudget + kaminoRedeem + transact(withdraw)
  → Redeems from Kamino first, then withdraws USDC to recipient (1 tx, 1 signature)
```

This bundling is tested and working on both localnet (10 tests) and devnet (8 tests).

### Mock Klend

For testing, a mock-klend program (`CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk`) provides a 1:1 cToken exchange rate. It uses identical Anchor instruction names as real klend, so discriminators match automatically. Mock-klend has 4 instructions:
- `init_lending_market` — creates lending market + LMA PDA
- `init_reserve` — creates reserve with PDA token accounts (liquidity supply, collateral mint, collateral supply, fee receiver)
- `deposit_reserve_liquidity(amount)` — transfers USDC to reserve, mints 1:1 cTokens
- `redeem_reserve_collateral(amount)` — burns cTokens, transfers 1:1 USDC back

### Future Enhancements (Not Yet Implemented)

**Sweep Threshold**: Instead of moving ALL vault USDC, keep a reserve for near-term withdrawals. Only sweep when vault exceeds a threshold, keeping half as liquid reserve.

**Automatic Redemption During Withdrawal**: Have `transact` automatically redeem from Kamino when the vault has insufficient USDC, eliminating the need for a separate `kamino_redeem` call or bundled transaction.

**kUSDC Exchange Rate Model**: Encode kUSDC amounts in commitments instead of raw USDC. The client would read the kUSDC exchange rate at deposit time, compute `kUSDC_amount = deposit_USDC / current_rate`, and commit to that. At withdrawal, `kUSDC_amount * current_rate` would yield more USDC than deposited. This enables per-user yield tracking without extra accounting. Currently all UTXO amounts are in raw USDC.

**Partial Deposit/Redeem**: Support depositing or redeeming a specific amount rather than all-or-nothing.

---

## Privacy Analysis

### What An Observer Sees

```
DEPOSIT TRANSACTION (public on-chain):
  - Sender address (old wallet)
  - USDC amount transferred to pool
  - Two new commitments added to Merkle tree (32-byte hashes)
  - Timestamp

WITHDRAWAL TRANSACTION (public on-chain):
  - Nullifier(s) consumed (32-byte values, unlinkable to commitments)
  - Two new commitments added to tree (change UTXOs, 32-byte hashes)
  - USDC amount transferred to recipient address
  - Recipient address (new wallet)
  - Relayer fee
  - Timestamp (batched — same as other withdrawals in the window)
```

### What An Observer CANNOT Determine

- Which deposit corresponds to which withdrawal (commitment ↔ nullifier link requires the private key)
- The USDC amount inside any commitment (hidden by Poseidon hash)
- Which output commitment is "real" change vs empty padding
- Whether a user has withdrawn or still has funds in the pool
- The IP address of the withdrawer (Arcium MPC relayer protects this)
- The exact timing of the withdrawal request (batch submission obscures this)

### Privacy Strength Depends On

**Anonymity set**: The number of unspent deposits in the pool. With 1000 active deposits, each withdrawal could plausibly be any of those 1000. More users = stronger privacy.

**Amount patterns**: If a user deposits a unique amount (e.g., 1,337 USDC) and later a withdrawal of ~1,400 USDC appears (matching the yield profile), an observer could guess. This is the user's responsibility — depositing round amounts improves privacy.

**Timing patterns**: Without Arcium batching, withdrawal timing could be correlated with off-chain behavior. With batching, timing analysis becomes much harder since multiple withdrawals share the same timestamp.

---

## Fee Structure

> **Current Implementation (Phase 1)**: No fees. The `fee` field exists in `ExtDataMinified` and is included in the circuit's `extDataHash` computation, but it is always set to 0. No fee transfer CPI is implemented. The `feeRecipient` is set to `signer.key()` as a placeholder.

**Planned fee model (future):**
```
Deposit fee:    0% (free to deposit, encourages pool growth)
Withdrawal fee: 0.5% of the USDC payout (deducted at withdrawal time)
Relayer fee:    Fixed amount per withdrawal (e.g., 0.1 USDC, paid to Arcium MPC cluster)
```

The fee is bound into the extDataHash, so it cannot be tampered with after the proof is generated.

---

## What Was Built

### Phase 1 — ZK Core: COMPLETE

All 17 integration tests passing. See `PROJECT_STATUS.md` for full details.

**ZK Artifacts** (reused from privacy-cash):
- `transaction2.wasm` — Circom WASM circuit (2-in/2-out UTXO, Merkle height 26)
- `transaction2.zkey` — Groth16 proving key (~16.5 MB)
- `verifyingkey2.json` — Verification key (embedded in on-chain verifier)

**Solana program** (`programs/privacy-yield/src/`):
- `lib.rs` — `initialize` + `transact` instructions, account structs, nullifier PDAs
- `merkle_tree.rs` — Append-only Merkle tree (height 26, 100-entry root history)
- `groth16.rs` — On-chain Groth16 verifier using Solana's alt_bn128 precompile
- `utils.rs` — BN254 field math, `check_public_amount`, `extDataHash` computation
- `errors.rs` — Custom error codes

**Client test library** (`tests/lib/`):
- Poseidon keypairs, UTXO creation, client-side Merkle tree, snarkjs proof generation, extDataHash computation

**17 tests**: deposit, full/partial withdraw, merge, consolidation, double-spend rejection, invalid proof, wrong root, event emission, tampered extAmount, cross-check nullifiers, two-output split, re-init prevention, tampered encrypted output, root consistency.

### Phase 2 — Kamino Integration: COMPLETE

All 10 localnet tests + 8 devnet E2E tests passing.

**New instructions** (added to `programs/privacy-yield/src/lib.rs`):
- `configure_klend` — stores klend program ID + addresses in `KlendConfig` PDA, creates pool cToken ATA
- `kamino_deposit` — CPI to klend `deposit_reserve_liquidity`, moves ALL vault USDC, receives cTokens
- `kamino_redeem` — CPI to klend `redeem_reserve_collateral`, burns ALL cTokens, receives USDC

**CPI module** (`programs/privacy-yield/src/klend_cpi.rs`):
- Raw `invoke_signed` with hardcoded discriminators matching klend's Anchor instruction names
- 12 accounts per CPI, matching exact klend account ordering

**Mock klend** (`programs/mock-klend/src/lib.rs`):
- 4 instructions with identical names to real klend (matching discriminators automatically)
- 1:1 cToken exchange rate for testing

**Localnet tests** (`tests/phase2_klend.ts`) — 10 tests:
- configure_klend, deposit/redeem, no-ops, permissionless, bundled deposit, bundled withdrawal, round-trip

**Devnet E2E tests** (`tests/phase2_devnet.ts`) — 8 tests:
- Deployment verification, USDC minting, deposit with ZK proof, kamino deposit/redeem, withdraw with ZK proof, balance verification, bundled deposit+yield

### Phase 2.5 — Devnet Deployment: COMPLETE

Both programs deployed to devnet with mock-klend. All 8 E2E tests passing with real ZK proofs on devnet. Setup script at `scripts/devnet-setup.ts`, all addresses in `devnet_config.json`.

### Phase 3 — Arcium Private Batch Relayer (planned)

**Arcium MPC circuits**
- Queue request circuit: receive encrypted signed transaction (deposit or withdrawal), validate, store in queue
- Deposit batch circuit: shuffle queued deposits (ArcisRNG), submit to Solana, advance durable nonces
- Withdrawal batch circuit: shuffle queued withdrawals (ArcisRNG), submit to Solana, advance durable nonces

**Durable nonce infrastructure**
- Nonce account creation helper (one per user, reusable)
- Transaction building with durable nonce instead of recent blockhash
- Nonce advancement after batch submission

**Arcium MXE setup**
- Deploy MPC circuits to Arcium devnet
- Configure cluster (node selection, threshold)
- Initialize computation definition with LUT
- Fund MPC cluster wallet for gas sponsorship (withdrawals)

**Client SDK additions**
- Create/manage durable nonce account per user
- Build transactions with durable nonce
- Encrypt signed transaction to MPC cluster's public key
- Submit encrypted request to Arcium (for both deposits and withdrawals)
- Listen for batch submission confirmation (via on-chain event or Arcium callback)
- Fallback: direct submission if MPC is unavailable

### Phase 4 — Frontend MVP: COMPLETE

Next.js 14 frontend with client-side ZK proving, wallet adapter, and IndexedDB UTXO persistence. See `PROJECT_STATUS.md` for full details.

- Deposit, withdraw, merge flows with step-by-step proof status modal
- Zustand stores with IndexedDB persistence (per-wallet UTXO + transaction history)
- Merkle tree sync from on-chain events
- Address Lookup Table for versioned transactions (bundled deposit+yield, bundled redeem+withdraw)
- Clean dark theme with Alliance No.2 font

### Production Hardening (planned)

**Event indexer**
- Index all deposit events for fast Merkle tree reconstruction
- Serve tree data via API (or use Helius webhooks)
- Optional: store encrypted receipts for user (with user's encryption key)

**Production deployment**
- Mainnet trusted setup ceremony (multi-party, 10+ participants)
- Solana mainnet deployment
- Arcium mainnet MPC deployment
- Multiple relayer endpoints (redundancy)
- Monitoring and alerting

### Nice-to-Haves

**Receipt export/import (IndexedDB backup)**
- "Export Receipts" button in frontend — downloads encrypted JSON of all UTXO receipts
- "Import Receipts" to restore from backup on a new device/browser
- Encryption key derived from wallet signature (same as UTXO encryption key)
- Prevents fund loss if user clears browser data or switches devices

**Fixed denomination pools**
- Separate merkle trees per denomination (e.g., 100 / 1,000 / 10,000 USDC)
- Program enforces `publicAmount ∈ {denomination}` per tree
- Eliminates amount-based correlation attacks (every deposit/withdrawal in a pool looks identical)
- Depositing 2,500 USDC = 2x1000 + 5x100 (multiple transactions)
- Dramatically increases anonymity set per denomination

**Uniform encrypted output padding**
- Pad all encrypted outputs to a fixed size (e.g., 128 bytes) before emitting in events
- Prevents output size from leaking approximate amounts

**Public tree indexer**
- Serve full tree snapshot via API/CDN (same response for all users, no auth)
- Eliminates RPC-level IP correlation when syncing merkle tree

---

## Trust Model Summary

```
TRUSTLESS (no trust required):
  - ZK proofs: math guarantees correctness
  - Nullifier uniqueness: Solana enforces (PDA init fails if exists)
  - Balance conservation: circuit constraint, cannot be violated
  - Merkle tree integrity: hash chain, tamper-evident
  - ExtDataHash: binds all metadata to proof
  - Kamino position: PDA-owned, no external signer

TRUST ASSUMPTIONS:
  - Trusted setup: at least 1 ceremony participant was honest
  - Arcium MPC: majority of cluster nodes are honest
    (only affects metadata privacy, not funds or ZK privacy)
  - Kamino: protocol risk (smart contract bug, insolvency)
  - Solana: chain liveness and finality

KEY PROPERTY:
  Even if Arcium MPC is fully compromised:
    - Funds are safe (controlled by ZK proofs + Solana program)
    - Deposit-withdrawal unlinkability is preserved (ZK, not MPC)
    - Only metadata privacy (IP, timing) is degraded
  Arcium is additive privacy, not a dependency.
```
