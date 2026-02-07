# Privacy Yield Protocol — Project Status

Last updated: 2026-02-07 (Phase 4 frontend MVP complete)

---

## What This Is

A privacy protocol on Solana that breaks the link between deposits and withdrawals while earning yield on idle funds via Kamino. Uses ZK proofs (Groth16) for privacy and Arcium MPC for metadata protection. Full architecture is in `PLAN.md`.

---

## Program IDs

| Program | Address |
|---------|---------|
| **privacy-yield** | `5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw` |
| **mock-klend** | `CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk` |

Both deployed to devnet and localnet with matching keypairs at `anchor/target/deploy/`.

---

## Phase 1 — ZK Core: COMPLETE

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

## Phase 2 — Kamino Integration: COMPLETE

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

## Phase 2.5 — Devnet Deployment: COMPLETE

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

## Phase 4 — Frontend MVP: COMPLETE

Next.js 14 frontend with client-side ZK proving, wallet adapter, and IndexedDB UTXO persistence. Connects to devnet programs.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router) |
| Styling | Tailwind CSS (custom dark theme, Alliance No.2 font) |
| Wallet | `@solana/wallet-adapter-react` (Phantom) |
| ZK Proving | snarkjs WASM (Groth16, browser-side, ~5-15s per proof) |
| Hashing | `@lightprotocol/hasher.rs` (Poseidon via WASM) |
| State | Zustand (UTXO store + tree store) |
| Persistence | IndexedDB via `idb` (per-wallet UTXO + transaction history) |
| Program | `@coral-xyz/anchor` 0.31 (IDL-based program interaction) |

### What's Built

**Core Library** (`fe/src/lib/`) — Browser-adapted ports of the test library:
| File | What it does | Adaptation from test lib |
|------|-------------|------------------------|
| `constants.ts` | Zero values, field prime, tree height | Direct port |
| `config.ts` | All devnet addresses as `PublicKey` constants | New — reads from hardcoded devnet addresses |
| `keypair.ts` | Poseidon-based ZK keypair | `crypto.getRandomValues` replaces `ethers.Wallet.createRandom()` |
| `utxo.ts` | UTXO creation, commitment hashing | `crypto.getRandomValues(Uint8Array(31))` replaces `crypto.randomBytes(31)` |
| `merkle-tree.ts` | Client-side Merkle tree (height 26) | Direct port with added `nextIndex` getter |
| `prover.ts` | snarkjs Groth16 proof generation | `fetch('/artifacts/...')` replaces file paths, ArrayBuffer caching, `preloadArtifacts()` |
| `utils.ts` | extDataHash, nullifier PDAs, formatting | `TextEncoder` replaces `Buffer.from`, added `formatUSDC`/`parseUSDC`/`shortenAddress` |
| `transaction.ts` | Full transaction builder | New — ALT creation, versioned tx, Anchor program interaction, compute budget (1M CU) |

**Zustand Stores** (`fe/src/stores/`):
| File | What it does |
|------|-------------|
| `utxo-store.ts` | IndexedDB-backed UTXO + transaction storage, per-wallet isolation, `getUnspent`/`getBalance`/`markSpent` |
| `tree-store.ts` | Merkle tree sync from on-chain events, reads `next_index` from MerkleTreeAccount at offset 40 |

**React Hooks** (`fe/src/hooks/`):
| File | What it does |
|------|-------------|
| `useWasm.ts` | React context for LightWasm singleton (Poseidon hasher) |
| `usePoolBalance.ts` | Fetches wallet USDC, pool vault, cToken balances + shielded balance from UTXO store |
| `useMerkleTree.ts` | Wrapper around tree store, auto-syncs on mount |
| `useDeposit.ts` | Full deposit flow: create UTXOs → prove → sign → confirm → store |
| `useWithdraw.ts` | Full/partial withdraw: reconstruct input → prove → sign → confirm → mark spent |
| `useMerge.ts` | Merge two UTXOs: reconstruct inputs → prove → sign → confirm → update store |

**UI Components** (`fe/src/components/`):
| File | What it does |
|------|-------------|
| `Providers.tsx` | ConnectionProvider (devnet RPC), WalletProvider, WasmProvider |
| `WalletButton.tsx` | Connect/disconnect with shortened address display |
| `PoolDashboard.tsx` | Main dashboard: status bar, 4 balance cards, action tabs, notes/history |
| `DepositForm.tsx` | Amount input, submit, proof status modal |
| `WithdrawForm.tsx` | Note selector, amount input with max, optional custom recipient |
| `MergeForm.tsx` | Two note selectors, merged amount preview |
| `UTXOList.tsx` | List unspent notes with amount, index, commitment hash |
| `TransactionHistory.tsx` | Past transactions with type labels, amounts, Explorer links |
| `ProofStatus.tsx` | Modal overlay showing step-by-step proof progress (preparing → proving → signing → confirming) |

**Pages** (`fe/src/app/`):
| File | What it does |
|------|-------------|
| `layout.tsx` | Root layout with Providers wrapper |
| `page.tsx` | Landing page with hero, 3-step explainer, auto-redirect on wallet connect |
| `pool/page.tsx` | Pool dashboard, redirects to landing if wallet disconnected |

**Design**: Clean minimal dark theme — `#0a0a0a` background, `#71717a` muted text, `#10b981` emerald accent, sharp edges (no border-radius), no gradients. Alliance No.2 font with system-ui fallback.

### Build Notes

- **WASM fix**: `@lightprotocol/hasher.rs` JS entry at `dist/browser-fat/es/` references WASM files relative to itself, but they live at `dist/`. Fixed with `postinstall` script that copies WASM files to the expected location.
- **Artifact symlinks**: `public/artifacts/transaction2.{wasm,zkey}` are symlinked to `../../../artifacts/` (3 levels up from `public/artifacts/` to `privacy-yield-protocol/`). Run `yarn setup:artifacts` to copy instead if symlinks cause issues.
- **Webpack config**: Node polyfill fallbacks (fs, path, crypto, stream, etc. all `false`), `asyncWebAssembly` + `layers` experiments enabled.
- **Bundle size**: Landing page ~230 kB, pool page ~1.45 MB first load (snarkjs + wallet adapter + Anchor).
- **ZK artifacts**: ~3 MB WASM + ~16.5 MB zkey served from `/public/artifacts/`, preloaded on dashboard mount.

### Commands

```bash
# Install dependencies
cd fe && yarn install

# Copy ZK artifacts (if symlinks don't work)
yarn setup:artifacts

# Development server
yarn dev

# Production build
yarn build && yarn start
```

---

## Remaining Phases

### Phase 3 — Arcium Private Relayer (next)
- Two MPC circuits: queue withdrawal request + batch submit
- Users encrypt withdrawal requests to MPC cluster (IP privacy)
- Batch submission masks individual withdrawal timing
- Relayer fee model (fee recipient becomes MPC cluster, not signer)

### Production Hardening
- Event indexer for fast Merkle tree reconstruction
- Mainnet trusted setup ceremony (multi-party, 10+ participants)
- Production deployment (Solana mainnet + Arcium mainnet)

---

## File Map

```
privacy-yield-protocol/
  PLAN.md                              — Full architecture document
  BUG_REPORT.md                        — Code audit (12 bugs, 3 test issues)
  PROJECT_STATUS.md                    — This file
  fe_plan.md                           — Frontend implementation plan
  artifacts/
    transaction2.wasm                  — Circom WASM circuit
    transaction2.zkey                  — Groth16 proving key
    verifyingkey2.json                 — Groth16 verification key
  anchor/
    Anchor.toml                        — Workspace: privacy-yield + mock-klend
    Cargo.toml / Cargo.lock
    package.json                       — test, test:phase2, devnet:setup, test:devnet scripts
    devnet_config.json                 — All devnet addresses + keypairs (generated by devnet:setup)
    programs/privacy-yield/src/
      lib.rs                           — Main program (initialize + transact + klend CPI)
      klend_cpi.rs                     — Raw CPI to klend (deposit + redeem)
      merkle_tree.rs                   — On-chain Merkle tree
      groth16.rs                       — On-chain Groth16 verifier
      utils.rs                         — Field math, extDataHash, checks
      errors.rs                        — Error codes
    programs/mock-klend/src/
      lib.rs                           — Mock klend (1:1 cToken exchange, 4 instructions)
    scripts/
      devnet-setup.ts                  — Idempotent devnet account setup
      test-phase2.sh                   — Builds + starts validator + runs phase2 tests
    tests/
      privacy_yield.ts                 — 17 Phase 1 integration tests
      phase2_klend.ts                  — 10 Phase 2 localnet tests (mock-klend)
      phase2_devnet.ts                 — 8 Phase 2.5 devnet E2E tests (ZK proofs + mock-klend)
      lib/
        constants.ts                   — Config and zero values
        keypair.ts                     — Poseidon keypairs
        utxo.ts                        — UTXO creation and encryption
        merkle_tree.ts                 — Client Merkle tree
        prover.ts                      — snarkjs proof generation
        utils.ts                       — extDataHash, mint fields, tx helpers

fe/                                        — Frontend (Next.js 14)
    package.json                           — Dependencies + postinstall WASM fix
    next.config.mjs                        — Webpack Node polyfill fallbacks, WASM experiments
    tailwind.config.ts                     — Custom dark theme (surfaces, accent, muted)
    src/
      app/
        layout.tsx                         — Root layout with Providers
        page.tsx                           — Landing page (hero + explainer)
        pool/page.tsx                      — Pool dashboard (wallet-gated)
        globals.css                        — Font-face, wallet adapter overrides
      lib/
        constants.ts                       — Zero values, field prime
        config.ts                          — All devnet addresses
        keypair.ts                         — Browser Poseidon keypairs
        utxo.ts                            — UTXO creation
        merkle-tree.ts                     — Client Merkle tree
        prover.ts                          — snarkjs browser proving
        utils.ts                           — extDataHash, formatting
        transaction.ts                     — ALT, versioned tx, Anchor program
        idl/privacy_yield.json             — Program IDL
      stores/
        utxo-store.ts                      — IndexedDB UTXO persistence
        tree-store.ts                      — Merkle tree sync from chain
      hooks/
        useWasm.ts                         — LightWasm context provider
        usePoolBalance.ts                  — Wallet + pool + cToken balances
        useMerkleTree.ts                   — Tree sync hook
        useDeposit.ts                      — Deposit flow (prove → sign → confirm)
        useWithdraw.ts                     — Withdraw flow
        useMerge.ts                        — Merge flow
      components/
        Providers.tsx                      — Connection + wallet + WASM providers
        PoolDashboard.tsx                  — Main dashboard UI
        DepositForm.tsx                    — Deposit amount input + submit
        WithdrawForm.tsx                   — Note selector + amount + recipient
        MergeForm.tsx                      — Two-note merge
        UTXOList.tsx                       — Unspent notes list
        TransactionHistory.tsx             — Past transactions with Explorer links
        ProofStatus.tsx                    — Step-by-step proof progress modal
        WalletButton.tsx                   — Connect/disconnect button
    public/
      fonts/AllianceNo2-Regular.otf        — Custom font
      artifacts/
        transaction2.wasm                  — Symlink → ../../../artifacts/
        transaction2.zkey                  — Symlink → ../../../artifacts/

klend/                                   — Kamino Lending (legacy real klend devnet deployment)
  devnet_config.json                     — Addresses for real klend at Bq2BdZ...
  target/
    idl/klend.json                       — IDL (fetched from mainnet v1.13.0)
    deploy/klend-keypair.json            — Program keypair
  tests/devnet_setup.ts                  — Setup script for real klend
```
