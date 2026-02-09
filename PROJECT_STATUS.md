# Privacy Yield Protocol — Project Status

Last updated: 2026-02-08 (EVM frontend ported to MegaETH — Phase 5 frontend complete)

---

## What This Is

A privacy protocol that breaks the link between deposits and withdrawals while earning yield on idle funds. Uses ZK proofs (Groth16) for privacy and Arcium MPC for metadata protection. Full architecture is in `PLAN.md`.

**Primary target chain: MegaETH** (EVM-based). The Solana implementation serves as the reference/prototype. The EVM port is the production deployment target.

---

## Deployments

### EVM (MegaETH) — Primary

Contracts deployed to MegaETH testnet (chain ID 6343).

| Contract | Address | Description |
|----------|---------|-------------|
| `PrivacyPool.sol` | `0xD1065321bB703203F1EE29Acc073C6d1eA1A28E2` | Core pool: Merkle tree, transact, batch transact, auto-yield |
| `Verifier.sol` | `0x567B24545cF1739A300cCDbA0E72ec07Ad6971F4` | Groth16 proof verifier (snarkjs-generated) |
| `MockUSDC.sol` | `0x7b70eD83f826cE59e65BF1711D60C6F27a0B2eB1` | Test ERC-20 token (permissionless mint) |
| `PoseidonT3` | `0x4668c470b212fB833d80b85176a52F0fe6684e6D` | External library for Merkle tree hashing |

### Solana (Reference Implementation)

| Program | Address |
|---------|---------|
| **privacy-yield** | `5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw` |
| **mock-klend** | `CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk` |

Both deployed to devnet and localnet with matching keypairs at `anchor/target/deploy/`.

---

## Phase 1 — ZK Core (Solana): COMPLETE

All 17 integration tests passing. The USDC privacy pool is fully functional on localnet with deposit, full/partial withdrawal, merge, and consolidation.

### What's Built

**Solana Program** (`anchor/programs/privacy-yield/src/`)
| File | What it does |
|------|-------------|
| `lib.rs` | `initialize` + `transact` instructions, account structs, nullifier PDAs |
| `merkle_tree.rs` | Append-only Merkle tree (height 26, 100-entry root history) |
| `groth16.rs` | On-chain Groth16 verifier using Solana's alt_bn128 precompile |
| `utils.rs` | BN254 field math, `check_public_amount`, `extDataHash` computation |
| `errors.rs` | Custom error codes |

**Client Test Library** (`anchor/tests/lib/`)
| File | What it does |
|------|-------------|
| `constants.ts` | Test config, zero values, field prime |
| `keypair.ts` | Poseidon-based keypair generation |
| `utxo.ts` | UTXO creation, commitment hashing, encrypted output serialization |
| `merkle_tree.ts` | Client-side Merkle tree (mirrors on-chain logic) |
| `prover.ts` | snarkjs Groth16 proof generation |
| `utils.ts` | extDataHash computation, mint field extraction, tx helpers |

**ZK Artifacts** (`artifacts/`)
- `transaction2.wasm` — Circom WASM circuit (2-in/2-out UTXO, height 26)
- `transaction2.zkey` — Groth16 proving key (~16.5 MB)
- `verifyingkey2.json` — Verification key (embedded in on-chain verifier)
- Copied from privacy-cash (same circuit, amounts represent kUSDC conceptually)

**Test Suite** (`anchor/tests/privacy_yield.ts`) — 17 tests:
1. Initialize pool
2. Deposit USDC
3. Full withdrawal
4. Partial withdrawal (with change UTXO)
5. Spend change UTXO
6. Merge two UTXOs
7. Double-spend rejection
8. Invalid proof rejection
9. Wrong Merkle root rejection
10. Consolidation (3 UTXOs into 1 via two merges)
11. Event emission verification
12. Tampered extAmount rejection
13. Cross-check nullifier position-swap rejection
14. Two-output split
15. Re-initialization prevention
16. Tampered encrypted output rejection
17. Root consistency after multiple operations

### Key Design Decisions

- **Single instruction**: `transact` handles deposit/withdraw/merge — the `publicAmount` field determines the type
- **Pool vault**: ATA owned by `pool_config` PDA (seeds: `[b"pool_config"]`)
- **Tree PDA**: seeds `[b"merkle_tree"]`, single tree for USDC
- **No fees in Phase 1**: fee field exists in extDataHash (set to 0) but no fee transfer CPI
- **feeRecipient**: Set to `signer.key()` as placeholder — will need redesign for relayer model
- **Nullifiers**: Two PDAs per transaction (`nullifier0`, `nullifier1`), existence = spent

### Build Notes

- Requires `Cargo.lock` from privacy-cash to avoid `constant_time_eq` edition2024 compile error
- macOS: `COPYFILE_DISABLE=1` needed to prevent `._genesis.bin` tar archive issue during `anchor test`
- EventParser in Anchor 0.31 uses generator pattern (`for...of`), NOT callbacks
- Test command: `cd anchor && yarn test` (runs `anchor test -- --features localnet`)

---

## Known Bugs (from `BUG_REPORT.md`)

### Fixed (7)
| ID | Severity | Issue |
|----|----------|-------|
| BUG-1 | CRITICAL | Blinding only 30 bits — now uses `randomBytes(31)` (248 bits) |
| BUG-2 | HIGH | No mint validation — added `require!` check in function body |
| BUG-4 | MEDIUM | Missing withdrawal balance check — added `require!` before CPI |
| BUG-7 | LOW | NullifierAccount.bump never written — removed bump field entirely |
| BUG-8 | LOW | root_history_size not tied to array — added `ROOT_HISTORY_SIZE` constant |
| BUG-9 | LOW | getMintAddressField SOL path broken — removed SOL special case |
| TEST-1 | TEST | Weak negative test assertions — added specific error checks |

### Open (5 bugs + 2 test gaps)
| ID | Severity | Issue | Notes |
|----|----------|-------|-------|
| BUG-3 | MEDIUM | Signer token account uses manual `require!` not Anchor constraints | WON'T FIX — SBF stack limit |
| BUG-5 | MEDIUM | Two appends per tx waste 50% of root_history | Fix: batch append or increase buffer to 200 |
| BUG-6 | LOW | Pool vault uses `init_if_needed` instead of init at setup | Fix: create vault in `Initialize` |
| BUG-10 | MEDIUM | No authority check on `initialize` — front-runnable | Fix: add compile-time `ADMIN_PUBKEY` |
| BUG-11 | MEDIUM | Fee CPI missing — non-zero fees accepted but never paid out | Fix: add `require!(fee == 0)` or implement fee CPI |
| BUG-12 | LOW | Nullifier PDA rent permanently locked (~0.002 SOL/tx) | Shared limitation of nullifier-PDA pattern |
| TEST-2 | TEST | No private transfer test (ownership change between keypairs) | |
| TEST-3 | TEST | Missing edge cases: tree full, root expiry, max amount, same nullifier both slots | |
| DESIGN-1 | DESIGN | Fee recipient hardcoded to signer — breaks Phase 3 relayer model | Phase 3 concern |

---

## Phase 2 — Kamino Integration (Solana): COMPLETE

All 10 localnet tests passing against mock-klend.

### Architecture

```
Localnet:  privacy-yield ──CPI──> mock-klend (same discriminators, 1:1 cToken rate)
Devnet:    privacy-yield ──CPI──> mock-klend (same programs, deployed to devnet)
```

The privacy-yield `KlendConfig` PDA stores the klend program ID at runtime (set by `configure_klend`), so switching between mock-klend and real klend requires no code changes — just different addresses.

### What's Built

**New Instructions** (added to `programs/privacy-yield/src/lib.rs`):
| Instruction | What it does |
|-------------|-------------|
| `configure_klend` | Stores klend program ID, reserve, lending market, LMA in `KlendConfig` PDA. Creates pool cToken ATA. |
| `kamino_deposit` | CPI to klend `deposit_reserve_liquidity` — moves all pool vault USDC into klend, receives cTokens |
| `kamino_redeem` | CPI to klend `redeem_reserve_collateral` — burns all cTokens, receives USDC back to pool vault |

**CPI Module** (`programs/privacy-yield/src/klend_cpi.rs`):
- Raw `invoke_signed` CPI with hardcoded discriminators matching klend's Anchor instruction names
- 12 accounts each for deposit and redeem, matching exact klend account ordering
- Pool config PDA signs as the "owner" for klend operations

**Mock Klend Program** (`programs/mock-klend/`):
| File | What it does |
|------|-------------|
| `Cargo.toml` | Anchor 0.31.0, anchor-spl 0.31.0, `localnet = []` feature |
| `src/lib.rs` | 4 instructions matching real klend discriminators via identical naming |

Mock instructions:
| Instruction | Discriminator (auto-generated) | What mock does |
|---|---|---|
| `init_lending_market` | `[34,162,116,14,101,137,94,239]` | Creates LMA PDA, stores market state |
| `init_reserve` | `[138,245,71,225,153,4,3,43]` | Creates reserve PDA token accounts (liq supply, coll mint, coll supply, fee receiver) |
| `deposit_reserve_liquidity(amount)` | `[169,201,30,126,6,205,102,68]` | Transfers USDC to reserve, mints 1:1 cTokens |
| `redeem_reserve_collateral(amount)` | `[234,117,181,125,185,142,220,29]` | Burns cTokens, transfers 1:1 USDC back |

**Localnet Test Suite** (`anchor/tests/phase2_klend.ts`) — 10 tests:
1. Configure klend with mock addresses
2. Second configure_klend fails (PDA exists)
3. Deposit vault USDC to klend (1:1 cTokens)
4. Redeem cTokens from klend (exact USDC restoration)
5. No-op deposit when vault empty
6. No-op redeem when cTokens zero
7. Permissionless deposit/redeem (any signer)
8. Bundled deposit (transact + kaminoDeposit in versioned tx)
9. Bundled withdrawal (kaminoRedeem + transact in versioned tx)
10. Full round-trip (deposit bundle then withdrawal bundle)

### Key Design Decisions

- **Discriminator matching**: Anchor auto-generates `sha256("global:<name>")[0..8]` — naming mock-klend instructions identically to real klend produces matching discriminators without hardcoding
- **Raw CPI**: `klend_cpi.rs` uses `invoke_signed` (not Anchor CPI), so it works against any program matching the interface
- **1:1 exchange on localnet**: Mock-klend uses a simple 1:1 rate (deposit X USDC, get X cTokens). Real klend uses exchange rates that accrue yield over time.
- **Permissionless deposit/redeem**: Any signer can trigger `kamino_deposit` / `kamino_redeem` — these are meant to be called permissionlessly (e.g., by a crank)

### Bug Fix in Phase 2

**CPI writable privilege escalation** — `pool_config` and `reserve_liquidity_mint` were not marked `mut` in the `KaminoDeposit` / `KaminoRedeem` Anchor structs, but `klend_cpi.rs` sends them as writable via `AccountMeta::new`. Solana runtime prevents CPI from escalating read-only to writable. Fixed by adding `mut` to both fields in both structs.

---

## Phase 2.5 — Devnet Deployment (Solana): COMPLETE

Both programs deployed to devnet with mock-klend. All 8 E2E tests passing with real ZK proofs on devnet.

### Devnet Addresses

All addresses are saved in `anchor/devnet_config.json`.

| Account | Address |
|---------|---------|
| **privacy-yield** (program) | `5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw` |
| **mock-klend** (program) | `CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk` |
| **Test USDC mint** | `fAdUukCWZcNkuxs1ZgJ44tCBdHFFdsy8q31jsKvzLFx` |
| **Lending market** | `H2YdcUtXJk4aqd4NGkLQiTGbdBEmU1fR5TAbCvmsLc3t` |
| **Reserve** | `AUWXJLxT54PycdYXtvKSpREGy1NRzshrWqKhtfYQp8bz` |
| **Lending market authority** (PDA) | `J2sxBRiVPGc2AbEYXyiqqKStUWHHFaG41uzg9ytjZBbR` |
| **Reserve liquidity supply** (PDA) | `CbZwfur2u54Zozs4PWoxtJRja552BBhmTciUuVdnSCc9` |
| **Reserve collateral mint** (PDA) | `8VMn3ACdnrdxnBmVoRTJMzs9s4gsFLWQsb9DeuN7Jygo` |
| **Tree account** (PDA) | `3rUxvp1QDCWhxCEf2j1KenusPKdSEbuTMjqpfDKUR7YN` |
| **Pool config** (PDA) | `DWq7V5PDuoow7frxVDt8mFYu5uTLGvy1uguXrMxTNAt4` |
| **Klend config** (PDA) | `ENto1q6tDXDuuCMkpb4stANASXHtRHTiRKYBGVnFb7C1` |
| **Pool vault** (ATA) | `6PZW2bE4oWqR5Cr54rZmJPBEkf5ApUftNshsf9j1hAoH` |
| **Pool cToken account** (ATA) | `GeBVUQoajGmnvzVZpggV8JydbXveEpyVPBPuGwWm9WpX` |

### What's Built

**Devnet Setup Script** (`anchor/scripts/devnet-setup.ts`):
- Idempotent — safe to re-run, skips accounts that already exist
- Creates test USDC mint, mock-klend lending market + reserve, privacy-yield pool + klend config
- Saves all addresses + keypairs to `devnet_config.json`
- Run: `cd anchor && yarn devnet:setup`

**Devnet E2E Test Suite** (`anchor/tests/phase2_devnet.ts`) — 8 tests:
1. Verify deployment — both programs exist and PDAs initialized
2. Mint test USDC to user wallet
3. Deposit USDC to pool — `transact` with real Groth16 ZK proof
4. Kamino deposit — sweep vault USDC into mock-klend, receive cTokens
5. Kamino redeem — redeem cTokens back to USDC in vault
6. Withdraw USDC from pool — `transact` with ZK proof, USDC to recipient
7. Verify final balances — vault=0, cTokens=0, recipient received USDC
8. Bundled deposit+yield — `transact` + `kaminoDeposit` in single versioned tx with ALT

### Key Differences from Localnet Tests

- Loads all addresses from `devnet_config.json` (no account creation in `before` block)
- Programs loaded from IDL files (no `anchor.workspace` on devnet)
- Syncs local Merkle tree with on-chain `next_index` for re-run compatibility
- Creates a fresh Address Lookup Table per test run (devnet slots change)
- Longer ALT activation timeouts (2s vs 1s for devnet confirmation)

### Build & Test Commands

```bash
# Phase 1 tests (17 tests, localnet)
cd anchor && yarn test

# Phase 2 localnet tests (10 tests, builds + starts validator)
cd anchor && yarn test:phase2

# Deploy to devnet (manual)
anchor build
solana program deploy target/deploy/privacy_yield.so --url devnet --program-id target/deploy/privacy_yield-keypair.json
solana program deploy target/deploy/mock_klend.so --url devnet --program-id target/deploy/mock_klend-keypair.json

# Devnet setup (creates accounts, saves config)
cd anchor && yarn devnet:setup

# Devnet E2E tests (8 tests, real ZK proofs on devnet)
cd anchor && yarn test:devnet
```

---

## Klend (Kamino Lending) Devnet Deployment (legacy — replaced by mock-klend)

A real klend instance was previously deployed at `Bq2BdZMBvMuaYQb3oPWJAN9mQTR3833Z5YQwzR3mu55d` using a patched mainnet binary. This has been superseded by mock-klend for devnet testing, which is simpler to manage and functionally identical for our CPI (same discriminators, same account layout). The real klend deployment notes are preserved in `klend/` for future reference if needed for mainnet.

---

## Phase 3 — EVM Port (MegaETH): COMPLETE

All 35 tests passing. The full protocol has been ported to EVM (Solidity) with batch transact and auto-yield. MegaETH is the primary deployment target.

### What's Built

**Smart Contracts** (`evm/contracts/`):
| Contract | What it does |
|----------|-------------|
| `PrivacyPool.sol` | Core pool: MerkleTree base, `transact()` with auto-yield, `batchTransact()` (max 50), `_transactCore()` internal, yield vault helpers |
| `Verifier.sol` | Groth16 verifier (snarkjs export, BN254 pairing) |
| `MockUSDC.sol` | Standard ERC-20 for testing |
| `MockYieldVault.sol` | 1:1 yToken exchange vault implementing `IYieldVault` interface |

**Key Architecture (EVM vs Solana)**:
| Aspect | EVM (MegaETH) | Solana |
|--------|--------------|--------|
| extDataHash | `keccak256(abi.encodePacked(...)) % FIELD_SIZE` | `Borsh + SHA256` |
| Nullifiers | `mapping(bytes32 => bool)` | PDA init (fails if exists) |
| Token transfers | ERC-20 `transferFrom`/`transfer` | SPL CPI with PDA signer |
| Yield | `IYieldVault.deposit()/redeem()` interface | Kamino klend CPI |
| Account model | Contract storage (no ALT needed) | PDA accounts + Address Lookup Tables |
| Initialization | Constructor (one-time) | `initialize` instruction |

**Auto-Yield** (new in Phase 3):
- `transact()` automatically redeems from vault before withdrawals and sweeps to vault after deposits
- No manual yield calls needed — the relayer/user just calls `transact()`
- Merge transactions (extAmount=0) skip yield operations

**Batch Transact** (new in Phase 3):
- `batchTransact(TransactParams[] calldata paramsList)` — up to 50 transactions in one call
- Single vault redeem at start, single vault sweep at end (2 vault interactions vs 2N)
- Sequential execution — later proofs can reference roots created by earlier insertions
- Entire batch reverts on any failure (atomic)

**Internal Refactor**:
- `TransactParams` struct encapsulates all proof + extData for a single transaction
- `_transactCore()` extracted from `transact()` — pure verification + transfer + tree insert
- `_redeemAllFromVault()` / `_sweepToVault()` — no-op if zero balance/shares
- `configureYield()`, `yieldDeposit()`, `yieldRedeem()` kept as manual fallbacks (permissionless)

**Test Suite** (`evm/test/`) — 35 tests:

*Phase 1 — Privacy Pool* (`privacy-pool.test.ts`) — 17 tests:
1-17. Same coverage as Solana: init, deposit, withdraw, partial, merge, double-spend, invalid proof, wrong root, consolidation, events, tampered extAmount, position-swap, split, re-init, tampered output, root consistency

*Phase 2 — Yield Vault* (`yield-vault.test.ts`) — 10 tests:
1. configureYield stores vault + approves
2. configureYield non-owner reverts
3. yieldDeposit manual sweep
4. yieldRedeem manual withdrawal
5. yieldDeposit no-op (zero balance)
6. yieldRedeem no-op (zero shares)
7. Permissionless (any account)
8. Auto-yield deposit — `transact()` auto-sweeps to vault
9. Auto-yield withdrawal — `transact()` auto-redeems then sweeps remainder
10. Round-trip — deposit + withdraw with auto-yield consistency

*Phase 3 — Batch Transact* (`batch-transact.test.ts`) — 8 tests:
1. Single-item batch (equivalent to `transact()`)
2. Multi-deposit batch (two deposits, tree updates)
3. Mixed batch (deposit then withdrawal with root dependency)
4. Batch with auto-yield (USDC ends up in vault)
5. Invalid proof reverts entire batch
6. Empty batch reverts
7. Oversized batch (>50) reverts
8. Sequential root dependency (second proof uses root from first)

### Build & Test Commands

```bash
# Install dependencies
cd evm && npm install

# Run all 35 tests
npx hardhat test

# Run specific test file
npx hardhat test test/privacy-pool.test.ts
npx hardhat test test/yield-vault.test.ts
npx hardhat test test/batch-transact.test.ts
```

### Key Implementation Notes

- **Library linking**: PoseidonT3 from `poseidon-solidity` is an external library — must deploy + link before PrivacyPool deployment
- **Proof format**: snarkjs B-point coordinates are REVERSED for Solidity verifier (`pi_b[i][1], pi_b[i][0]`)
- **Mint field**: EVM address (20 bytes/160 bits) fits BN254 directly — no 31-byte truncation needed (unlike Solana's 32-byte pubkeys)
- **No position-swap attack**: EVM uses `mapping(bytes32 => bool)` — nullifier position in the pair doesn't matter (unlike Solana PDAs with "nullifier0"/"nullifier1" seeds)
- **Circuit files**: Shared `artifacts/transaction2.wasm/.zkey` — unchanged from Solana version

---

## Phase 4 — Frontend MVP (Solana): COMPLETE (legacy)

> Original Solana frontend — superseded by Phase 5 EVM frontend. Code still exists for reference but is no longer the active frontend.

Next.js 14 frontend with Phantom wallet adapter, Anchor program interaction, ALTs, and SPL token CPI. Connected to Solana devnet programs.

---

## Phase 5 — EVM Frontend (MegaETH): COMPLETE

Next.js 14 frontend ported from Solana to MegaETH. Uses wagmi + viem + RainbowKit for EVM wallet interaction. Same ZK proving (snarkjs Groth16 in browser), same UTXO model, same IndexedDB persistence.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router) |
| Styling | Tailwind CSS (custom dark theme, JetBrains Mono font) |
| Wallet | wagmi v2 + RainbowKit v2 (MetaMask, WalletConnect, etc.) |
| Chain | viem (MegaETH testnet, chain ID 6343) |
| ZK Proving | snarkjs WASM (Groth16, browser-side, ~5-15s per proof) |
| Hashing | `@lightprotocol/hasher.rs` (Poseidon via WASM) |
| State | Zustand (UTXO store + tree store) |
| Persistence | IndexedDB via `idb` (per-wallet UTXO + transaction history) |

### What Changed from Solana Frontend

| Aspect | Solana (Phase 4) | EVM (Phase 5) |
|--------|------------------|---------------|
| Wallet | `@solana/wallet-adapter-react` (Phantom) | wagmi + RainbowKit (MetaMask, WalletConnect) |
| Chain interaction | `@coral-xyz/anchor` + versioned tx + ALTs | viem `writeContract` / `readContract` |
| extDataHash | Borsh + SHA256 | `keccak256(abi.encodePacked(...)) % FIELD_SIZE` |
| Nullifiers | PDA derivation (`findNullifierPDAs`) | `bytes32` padding (`padHex/numberToHex`) |
| Token | SPL CPI | ERC-20 approve + transferFrom |
| Tree sync | Parse Solana tx logs for Anchor events | `publicClient.getLogs()` for `NewCommitment` events |
| Mint field | 31-byte truncation of Solana PublicKey | Direct hex address (20 bytes fits BN254) |
| Proof format | Byte array for Solana program | BigInt with B-point reversal for Solidity |
| Withdrawal | Relayer polling | Direct (user pays gas) |

### What's Built

**Core Library** (`fe/src/lib/`):
| File | What it does |
|------|-------------|
| `constants.ts` | Zero values (string format), field prime, tree height |
| `config.ts` | MegaETH chain definition, contract addresses, Pool ABI, ERC20 ABI, wagmi config |
| `keypair.ts` | Poseidon keypair (string-typed privkey/pubkey, matches EVM test lib) |
| `utxo.ts` | UTXO with `tokenAddress` (hex), commitment hashing |
| `merkle-tree.ts` | Client-side Merkle tree (height 26) — unchanged |
| `prover.ts` | snarkjs Groth16 browser proving + `parseProofForSolidity()` (BigInt, B-point reversal) |
| `utils.ts` | `getExtDataHash()` (keccak256), `getMintAddressField()` (no truncation), formatting |
| `transaction.ts` | `buildProofInput()`, `formatCalldata()`, `ensureAllowance()`, `callTransact()` via viem |

**Zustand Stores** (`fe/src/stores/`):
| File | What it does |
|------|-------------|
| `utxo-store.ts` | IndexedDB `privacy-yield-evm` DB, per-wallet UTXO + tx history, `tokenAddress` field |
| `tree-store.ts` | Syncs from `NewCommitment` EVM events via `publicClient.getLogs()` |

**React Hooks** (`fe/src/hooks/`):
| File | What it does |
|------|-------------|
| `useWasm.ts` | React context for LightWasm singleton (Poseidon hasher) |
| `usePoolBalance.ts` | ERC-20 `balanceOf` for wallet + pool vault via `readContract` |
| `useMerkleTree.ts` | Wrapper around tree store with viem `usePublicClient()` |
| `useDeposit.ts` | ERC-20 approve → build proof → `callTransact()` → store UTXO |
| `useWithdraw.ts` | Direct withdrawal (user pays gas, no relayer) |
| `useMerge.ts` | Merge two UTXOs (extAmount=0, no allowance needed) |

**UI Components** (`fe/src/components/`):
| File | What it does |
|------|-------------|
| `Providers.tsx` | WagmiProvider + QueryClientProvider + RainbowKitProvider + WasmProvider |
| `WalletButton.tsx` | wagmi `useAccount()` + `useDisconnect()` + RainbowKit `useConnectModal()` |
| `PoolDashboard.tsx` | Dashboard with `[OK] megaeth-testnet` status, balance cards, action tabs |
| `Select.tsx` | Custom terminal-styled dropdown (replaces native `<select>`) |
| `DepositForm.tsx` | Amount input + submit |
| `WithdrawForm.tsx` | Custom note selector + amount + optional EVM recipient |
| `MergeForm.tsx` | Two custom note selectors + merged amount preview |
| `UTXOList.tsx` | Unspent notes list |
| `TransactionHistory.tsx` | Past transactions with MegaETH explorer links |
| `ProofStatus.tsx` | Step-by-step proof progress modal |

**Pages** (`fe/src/app/`):
| File | What it does |
|------|-------------|
| `layout.tsx` | Root layout with Providers, JetBrains Mono font |
| `page.tsx` | Cypherpunk terminal landing — ASCII NEBULA logo, boot sequence animation, decipher text ("encrypt your money"), press [ENTER] / tap to enter |
| `pool/page.tsx` | Pool dashboard (no wallet gate — WalletButton in nav) |

**Landing Page UX**:
- Terminal window with macOS chrome (`nebula@megaeth-testnet ~ /vault`)
- Sequential boot lines with [OK] indicators (poseidon, groth16, merkle tree)
- Decipher text animation: `"> encrypt your money."`
- Desktop: `press [ENTER]` → plays exit sequence → navigates to `/pool`
- Mobile: auto-detected via `matchMedia("(pointer: coarse)")` → shows `tap to enter`
- Exit sequence: `loading vault interface...`, `[OK] pool contract linked`, `[OK] merkle state synced`, `ready.`

**Design**: Dark terminal aesthetic — `#0a0a0a` background, `#d65d0e` amber accent, `#71717a` muted text, sharp edges (no border-radius), JetBrains Mono font. Custom styled dropdowns matching terminal theme.

### Build Notes

- **Webpack**: `IgnorePlugin` suppresses `pino-pretty` and `@react-native-async-storage` warnings from WalletConnect/MetaMask SDK. Node polyfill fallbacks (fs, path, crypto, stream all `false`). `asyncWebAssembly` + `layers` experiments.
- **tsconfig**: `target: "ES2020"` required for BigInt literal support (`0n`).
- **Bundle size**: Landing page ~91 kB (no wallet code), pool page ~1.51 MB (wagmi + snarkjs).
- **Remaining `web-worker` warning**: Cosmetic, from ffjavascript's dynamic require for Node.js workers. Harmless in browser.

### Commands

```bash
cd fe && yarn install
yarn dev          # Development server (localhost:3000)
yarn build        # Production build
```

---

## Remaining Phases

### Phase 6 — Arcium Private Relayer (next)
- Two MPC circuits: queue withdrawal request + batch submit
- Users encrypt withdrawal requests to MPC cluster (IP privacy)
- Batch submission masks individual withdrawal timing (leverages `batchTransact()` on EVM)
- Relayer fee model (fee recipient becomes MPC cluster, not signer)

### Production Hardening
- Event indexer for fast Merkle tree reconstruction
- Mainnet trusted setup ceremony (multi-party, 10+ participants)
- Production deployment (MegaETH mainnet + Arcium mainnet)

---

## File Map

```
privacy-yield-protocol/
  PLAN.md                              — Full architecture document
  BUG_REPORT.md                        — Code audit (12 bugs, 3 test issues)
  PROJECT_STATUS.md                    — This file
  artifacts/
    transaction2.wasm                  — Circom WASM circuit (shared by Solana + EVM)
    transaction2.zkey                  — Groth16 proving key
    verifyingkey2.json                 — Groth16 verification key

  evm/                                     — EVM Contracts (MegaETH) — PRIMARY TARGET
    hardhat.config.ts                      — Hardhat config (MegaETH testnet network)
    .env                                   — Deployer key + RPC URL
    package.json                           — Dependencies (hardhat, ethers, snarkjs, poseidon-solidity)
    deployments/megaeth-testnet.json       — Deployed contract addresses
    contracts/
      PrivacyPool.sol                      — Core pool (MerkleTree + transact + batch + yield)
      Verifier.sol                         — Groth16 verifier (snarkjs-generated)
      mocks/MockUSDC.sol                   — Test ERC-20 (permissionless mint)
      mocks/MockYieldVault.sol             — Test yield vault (1:1 rate)
    scripts/
      deploy-megaeth.ts                    — Deploy all contracts to MegaETH testnet
      stress-test.ts                       — 200 sequential deposits for gas profiling
    test/
      privacy-pool.test.ts                 — 17 Phase 1 tests (ZK core)
      yield-vault.test.ts                  — 10 Phase 2 tests (yield integration)
      batch-transact.test.ts               — 8 Phase 3 tests (batch + auto-yield)
      lib/                                 — Test library (constants, keypair, utxo, merkle_tree, prover, utils)

  fe/                                        — Frontend (Next.js 14, MegaETH)
    package.json                             — wagmi, viem, RainbowKit, snarkjs, zustand
    next.config.mjs                          — Webpack IgnorePlugin + fallbacks + WASM
    tailwind.config.ts                       — Custom dark terminal theme
    tsconfig.json                            — ES2020 target for BigInt
    src/
      app/
        layout.tsx                           — Root layout (JetBrains Mono, Providers)
        page.tsx                             — Cypherpunk terminal landing page
        pool/page.tsx                        — Pool dashboard (WalletButton in nav)
        globals.css                          — Theme variables, RainbowKit overrides
      lib/
        config.ts                            — MegaETH chain, contract addresses, ABIs, wagmi config
        constants.ts                         — Zero values (string format), field prime
        keypair.ts                           — Poseidon keypair (string-typed)
        utxo.ts                              — UTXO with tokenAddress (hex)
        merkle-tree.ts                       — Client Merkle tree (height 26)
        prover.ts                            — snarkjs browser proving + Solidity proof format
        utils.ts                             — extDataHash (keccak256), formatting
        transaction.ts                       — buildProofInput, formatCalldata, ensureAllowance, callTransact
      stores/
        utxo-store.ts                        — IndexedDB UTXO persistence (EVM)
        tree-store.ts                        — NewCommitment event log sync
      hooks/
        useWasm.ts                           — LightWasm context provider
        usePoolBalance.ts                    — ERC-20 balanceOf reads
        useMerkleTree.ts                     — Tree sync with viem PublicClient
        useDeposit.ts                        — Approve + prove + transact
        useWithdraw.ts                       — Direct withdrawal (no relayer)
        useMerge.ts                          — Merge two UTXOs
      components/
        Providers.tsx                        — Wagmi + RainbowKit + Query + WASM
        WalletButton.tsx                     — Connect/disconnect (RainbowKit modal)
        PoolDashboard.tsx                    — Dashboard UI
        Select.tsx                           — Custom terminal-styled dropdown
        DepositForm.tsx                      — Deposit form
        WithdrawForm.tsx                     — Withdraw with custom note selector
        MergeForm.tsx                        — Merge with custom note selectors
        UTXOList.tsx                         — Unspent notes
        TransactionHistory.tsx               — Tx history with MegaETH explorer
        ProofStatus.tsx                      — Proof progress modal
    public/
      artifacts/
        transaction2.wasm                    — Symlink → ../../../artifacts/
        transaction2.zkey                    — Symlink → ../../../artifacts/

  anchor/                                    — Solana (reference implementation)
    programs/privacy-yield/src/              — Main program (initialize + transact + klend CPI)
    programs/mock-klend/src/                 — Mock klend (1:1 cToken exchange)
    tests/                                   — 17 Phase 1 + 10 Phase 2 + 8 devnet E2E tests
    scripts/                                 — devnet-setup.ts, test-phase2.sh
    devnet_config.json                       — All devnet addresses

  klend/                                     — Kamino Lending (legacy real klend devnet deployment)
```
