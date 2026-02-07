# Frontend Plan: Privacy Yield Protocol

## Goal

A web app where users can deposit USDC privately into a yield-earning pool using ZK proofs. All proof generation happens client-side in the browser. The user's wallet signs Solana transactions, but the amounts, UTXOs, and linkage between deposits/withdrawals remain private.

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14 (App Router) | SSR for landing, client-side for app |
| Wallet | `@solana/wallet-adapter-react` | Standard Solana wallet connection (Phantom, Backpack, etc.) |
| Solana | `@solana/web3.js` + `@coral-xyz/anchor` | Transaction building, program interaction |
| ZK Proving | `snarkjs` (browser WASM) | Groth16 proof generation client-side |
| Poseidon Hash | `@lightprotocol/hasher.rs` | WASM-based Poseidon (same as test lib) |
| Field Math | `bn.js` + `ffjavascript` | BN254 field arithmetic, proof serialization |
| Styling | Tailwind CSS | Fast iteration |
| State | Zustand | Lightweight, good for UTXO state management |

## Architecture

```
Browser
  ├── Wallet Adapter (signs txs)
  ├── ZK Module (snarkjs WASM proving)
  │   ├── transaction2.wasm  (fetched on first use, cached)
  │   └── transaction2.zkey  (fetched on first use, cached)
  ├── UTXO Store (IndexedDB, encrypted with wallet pubkey)
  │   ├── unspent UTXOs (amount, blinding, keypair, index, commitment)
  │   └── spent nullifiers (for local tracking)
  ├── Merkle Tree (rebuilt from on-chain events on load)
  └── Transaction Builder (Anchor + ALT + compute budget)

Solana Devnet
  ├── privacy-yield program (5S7PQ...)
  ├── mock-klend program (CcubA...)
  └── On-chain state (merkle tree, nullifiers, pool config)
```

## Project Structure

```
fe/
├── public/
│   └── artifacts/
│       ├── transaction2.wasm     (~2MB, served statically)
│       └── transaction2.zkey     (~10MB, served statically)
├── src/
│   ├── app/
│   │   ├── layout.tsx            # Wallet provider, global layout
│   │   ├── page.tsx              # Landing / connect wallet
│   │   └── pool/
│   │       └── page.tsx          # Main pool dashboard
│   ├── components/
│   │   ├── WalletButton.tsx      # Connect/disconnect
│   │   ├── PoolDashboard.tsx     # Balance, yield info, actions
│   │   ├── DepositForm.tsx       # Amount input -> deposit flow
│   │   ├── WithdrawForm.tsx      # Amount + recipient -> withdraw flow
│   │   ├── UTXOList.tsx          # Show unspent notes (debug/advanced)
│   │   ├── TransactionHistory.tsx # Past deposits/withdrawals
│   │   └── ProofStatus.tsx       # "Generating proof..." spinner
│   ├── lib/
│   │   ├── config.ts             # Program IDs, devnet addresses (from devnet_config.json)
│   │   ├── keypair.ts            # ZK keypair (Poseidon-based) — browser-adapted
│   │   ├── utxo.ts               # UTXO class — browser-adapted
│   │   ├── merkle_tree.ts        # Merkle tree — browser-adapted (same logic)
│   │   ├── prover.ts             # snarkjs prove + byte serialization — browser-adapted
│   │   ├── utils.ts              # extDataHash, nullifier PDAs, mint field — browser-adapted
│   │   ├── constants.ts          # ZERO_BYTES, FIELD_SIZE, tree height
│   │   ├── transaction.ts        # Build & send transact/kaminoDeposit/kaminoRedeem txs
│   │   └── alt.ts                # Address Lookup Table creation/caching
│   ├── stores/
│   │   ├── utxo-store.ts         # Zustand store: UTXO management + IndexedDB persistence
│   │   └── tree-store.ts         # Zustand store: Merkle tree state
│   └── hooks/
│       ├── useDeposit.ts         # Full deposit flow hook
│       ├── useWithdraw.ts        # Full withdraw flow hook
│       ├── usePoolBalance.ts     # Compute shielded balance from UTXOs
│       └── useMerkleTree.ts      # Tree sync from on-chain
├── next.config.js                # WASM support, webpack config
├── package.json
└── tsconfig.json
```

## Browser Adaptations from Test Lib

The existing `tests/lib/` modules work in Node.js. Several changes needed for browser:

| Module | Node.js API | Browser Replacement |
|---|---|---|
| `utxo.ts` | `crypto.randomBytes(31)` | `crypto.getRandomValues(new Uint8Array(31))` |
| `prover.ts` | File paths (`${keyBasePath}.wasm`) | Fetch URLs (`/artifacts/transaction2.wasm`) |
| `utils.ts` | `Buffer.from(...)` | Keep `Buffer` via polyfill, or use `Uint8Array` |
| `keypair.ts` | `ethers.Wallet.createRandom()` | Same — ethers works in browser |
| All | `@lightprotocol/hasher.rs` | Same — WASM loads in browser |
| All | `bn.js`, `ffjavascript`, `borsh` | Same — all browser-compatible |
| All | `snarkjs` | Same — has browser WASM support built-in |

### snarkjs in Browser

snarkjs natively supports browser proving. Instead of file paths:

```typescript
// Node (test lib)
const { proof, publicSignals } = await groth16.fullProve(input, "path.wasm", "path.zkey");

// Browser
const wasmBuf = await fetch("/artifacts/transaction2.wasm").then(r => r.arrayBuffer());
const zkeyBuf = await fetch("/artifacts/transaction2.zkey").then(r => r.arrayBuffer());
const { proof, publicSignals } = await groth16.fullProve(input, wasmBuf, zkeyBuf);
```

Cache the buffers after first fetch (store in memory or use Service Worker cache).

### Poseidon WASM

`@lightprotocol/hasher.rs` uses WASM — initialize once:

```typescript
const lightWasm = await WasmFactory.getInstance();
// Reuse across the entire app session
```

## Core User Flows

### 1. Deposit

User enters USDC amount. Frontend:

1. Generate ZK keypair (or reuse existing one from store)
2. Create 2 input UTXOs (zero-amount, empty — no prior notes needed for deposit)
3. Create output UTXO with deposit amount + user's ZK keypair
4. Build circuit input (merkle root, nullifiers, commitments, extDataHash)
5. Generate Groth16 proof client-side (snarkjs WASM, ~5-15 seconds)
6. Serialize proof + public signals to byte arrays
7. Build `transact` instruction with proof, extData, encrypted outputs
8. Wrap in versioned transaction with ALT + compute budget (1M CU)
9. Wallet signs + sends
10. On confirmation: store output UTXO in IndexedDB, update local merkle tree

### 2. Full Withdraw

User selects a UTXO (or "withdraw all from note"). Frontend:

1. Load unspent UTXO from store
2. Create inputs: [the UTXO, zero UTXO]
3. Create outputs: [zero UTXO, zero UTXO] (spending entire note)
4. Set `extAmount = -withdrawAmount` (negative = withdrawal)
5. Set `recipient` = user's wallet ATA (or custom recipient)
6. Generate proof, build tx, send (same as deposit steps 4-9)
7. On confirmation: mark UTXO as spent, add zero outputs to tree

### 3. Partial Withdraw

User enters amount less than a UTXO's full value. Frontend:

1. Load unspent UTXO with sufficient balance
2. Create inputs: [the UTXO, zero UTXO]
3. Create outputs: [change UTXO (original - withdraw), zero UTXO]
4. Set `extAmount = -withdrawAmount`
5. Generate proof, build tx, send
6. On confirmation: mark original UTXO spent, store change UTXO as new unspent note

### 4. Merge

User has multiple small UTXOs, wants to consolidate. Frontend:

1. Pick 2 unspent UTXOs
2. Create inputs: [UTXO_A, UTXO_B]
3. Create outputs: [merged UTXO (amount_A + amount_B), zero UTXO]
4. Set `extAmount = 0` (no external transfer)
5. Set `recipient` = signer (placeholder, included in extDataHash)
6. Generate proof, build tx, send
7. On confirmation: mark both inputs spent, store merged output

### 5. Consolidation (many UTXOs)

Chain multiple merges: merge first 2, then merge result with 3rd, etc. Show progress bar.

## UTXO Storage (IndexedDB)

```typescript
interface StoredUTXO {
  id: string;                    // commitment hash
  amount: string;                // BN serialized
  blinding: string;              // BN serialized
  keypairPrivkey: string;        // hex string (ZK privkey, NOT wallet key)
  index: number;                 // merkle tree leaf index
  mintAddress: string;           // USDC mint base58
  spent: boolean;                // true after nullifier submitted
  createdAt: number;             // timestamp
  txSignature: string;           // solana tx sig that created it
}
```

- Encrypted at rest using a key derived from the user's wallet signature (sign a deterministic message like "privacy-yield-utxo-key-v1")
- Keyed by wallet pubkey so multiple wallets can use same browser
- Export/import for backup (encrypted JSON file download)

## Merkle Tree Sync

On page load, reconstruct the merkle tree to generate valid proofs:

**Option A — Event-based (preferred):**
1. Fetch all `TransactEvent` logs from the program using `connection.getSignaturesForAddress(treeAccountPDA)` + `connection.getParsedTransaction()`
2. Parse each event's `outputCommitment0` and `outputCommitment1`
3. Insert commitments into local tree in order
4. Cache the last processed signature so subsequent loads only fetch new events

**Option B — On-chain read (fallback):**
1. Read `MerkleTreeAccount` data: `next_index` at byte offset 40 (8 disc + 32 authority)
2. Read `subtrees` array to reconstruct the tree's frontier
3. For proof generation, only need the path from leaf to root — can derive from subtrees + zero hashes

**Hybrid approach:** Use Option B for `next_index` count, and Option A to fill in the actual commitment values for leaves that belong to the user's UTXOs. For leaves that don't belong to the user, insert "0" placeholder (circuit only checks the path for the user's inputs).

## Transaction Building

Every `transact` call needs:
- Compute budget: `1,000,000` CU
- Address Lookup Table (ALT) for account compression
- Versioned transaction (V0)

```typescript
// Reuse a single ALT per session
const altAddress = await getOrCreateALT(connection, wallet, [
  PROGRAM_ID, treeAccountPDA, poolConfigPDA, poolVault,
  usdcMint, SystemProgram.programId, TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID, ComputeBudgetProgram.programId,
  // klend accounts for bundled txs:
  klendConfigPDA, poolCtokenAccount, MOCK_KLEND_PROGRAM_ID,
  reserve, lendingMarket, lendingMarketAuthority,
  reserveLiquiditySupply, reserveCollateralMint, SYSVAR_INSTRUCTIONS_PUBKEY,
]);
```

## UI Pages

### Landing (`/`)
- Hero: "Private Yield on Solana"
- Connect wallet button
- How it works (3-step: deposit privately, earn yield, withdraw anywhere)

### Pool Dashboard (`/pool`)
- **Shielded Balance**: Sum of unspent UTXOs (computed locally, never sent to server)
- **Pool TVL**: Read `poolVault` + `poolCtokenAccount` balances (public on-chain data)
- **Actions**:
  - Deposit: amount input, "Deposit" button
  - Withdraw: amount input, recipient address (default: own wallet), "Withdraw" button
  - Merge: shown if user has 2+ UTXOs, "Consolidate Notes" button
- **Notes** (expandable): List of unspent UTXOs with amounts (advanced view)
- **History**: Past transactions with tx signatures (links to Solscan)

### Proof Generation UX
- Show a modal/overlay: "Generating ZK proof..." with progress
- snarkjs takes ~5-15s in browser — use Web Worker to avoid blocking UI
- After proof: "Waiting for wallet signature..."
- After send: "Confirming on Solana..." with tx link

## Implementation Order

### Phase 1: Core (MVP)
1. **Project setup**: Next.js + Tailwind + wallet adapter + WASM config
2. **Port lib/**: Adapt all 6 test lib files for browser (main change: `randomBytes`, artifact loading)
3. **Config**: Hardcode devnet addresses from `devnet_config.json`
4. **Deposit flow**: Form -> proof -> tx -> UTXO stored in IndexedDB
5. **Withdraw flow**: Select UTXO -> proof -> tx -> mark spent
6. **Merkle tree sync**: Read on-chain state + events on page load
7. **Basic UI**: Dashboard with balance, deposit/withdraw forms, proof spinner

### Phase 2: Polish
8. **Partial withdraw**: Change UTXO creation
9. **Merge**: 2-input consolidation
10. **ALT caching**: Persist ALT address in localStorage, reuse across sessions
11. **UTXO encryption**: Derive encryption key from wallet signature
12. **Export/import**: Backup notes as encrypted file
13. **Error handling**: Insufficient balance, proof failure, tx failure, retry logic

### Phase 3: Production Readiness
14. **Web Worker**: Move snarkjs proving to worker thread
15. **Service Worker**: Cache .wasm + .zkey artifacts (these files don't change)
16. **Artifact preload**: Start downloading .wasm/.zkey on wallet connect (before user clicks deposit)
17. **Mobile**: Responsive layout, test with mobile wallets
18. **Analytics**: Pool stats page (TVL over time, total deposits, etc. — all from public on-chain data)

## Webpack / Next.js Config

snarkjs + ffjavascript + WASM need some webpack tweaks:

```javascript
// next.config.js
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,  // we use Web Crypto API directly
      };
    }
    // Allow WASM
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};
```

## Key Devnet Addresses (from devnet_config.json)

```
privacy-yield program:  5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw
mock-klend program:     CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk
USDC mint:              fAdUukCWZcNkuxs1ZgJ44tCBdHFFdsy8q31jsKvzLFx
Pool config PDA:        DWq7V5PDuoow7frxVDt8mFYu5uTLGvy1uguXrMxTNAt4
Merkle tree PDA:        3rUxvp1QDCWhxCEf2j1KenusPKdSEbuTMjqpfDKUR7YN
Pool vault:             6PZW2bE4oWqR5Cr54rZmJPBEkf5ApUftNshsf9j1hAoH
Klend config PDA:       ENto1q6tDXDuuCMkpb4stANASXHtRHTiRKYBGVnFb7C1
Pool cToken account:    GeBVUQoajGmnvzVZpggV8JydbXveEpyVPBPuGwWm9WpX
```

## What We DON'T Build Yet

- **Relayer**: For now, user pays gas directly (not private at the network level). Arcium relayer is Phase 3.
- **Real Kamino**: Using mock-klend. Swap to real klend when moving to mainnet.
- **Multi-token**: USDC only. Pool-per-token architecture is already in the program but frontend only shows USDC.
- **Fee mechanism**: Fees are 0 in Phase 1. No fee UI needed.
