# Privacy Yield Protocol — Bug Report (Phase 1)

Thorough code audit of the on-chain program, client-side test library, and integration tests.

---

## ~~BUG-1: Weak blinding randomness — only ~30 bits of entropy [CRITICAL]~~ FIXED

**File:** `anchor/tests/lib/utxo.ts:19`

~~The blinding factor was sampled from `[0, 999_999_999]` — roughly 30 bits of entropy.~~

**Fixed:** Now uses `randomBytes(31)` from Node's `crypto` module (248 bits of cryptographic randomness).

---

## ~~BUG-2: Missing mint validation — pool accepts any SPL token [HIGH]~~ FIXED

**File:** `anchor/programs/privacy-yield/src/lib.rs`

~~The `mint` account in `Transact` had no constraint verifying it equals `pool_config.usdc_mint`.~~

**Fixed:** Added `require!(mint.key() == pool_config.usdc_mint, ...)` check in the `transact` function body. Used function-body check instead of Anchor constraint because adding constraints to the `Transact` struct pushes the `try_accounts` function over the SBF 4096-byte stack limit.

---

## BUG-3: Signer token account lacks Anchor constraints [MEDIUM] — WON'T FIX (stack limit)

**File:** `anchor/programs/privacy-yield/src/lib.rs`

The signer's token account is validated with manual `require!` checks instead of Anchor constraints. The `Transact` struct has so many accounts that moving validations into Anchor constraints pushes `try_accounts` over the SBF 4096-byte stack frame limit, causing runtime crashes.

**Status:** Cannot fix without restructuring the account layout (e.g., splitting into multiple instructions or reducing account count). Manual `require!` checks in the function body achieve the same validation — just less idiomatic.

---

## ~~BUG-4: `InsufficientFundsForWithdrawal` error defined but never used [MEDIUM]~~ FIXED

**File:** `anchor/programs/privacy-yield/src/lib.rs`

~~The error code `InsufficientFundsForWithdrawal` was declared but never checked.~~

**Fixed:** Added explicit `require!(pool_vault.amount >= ext_amount_abs, InsufficientFundsForWithdrawal)` before the withdrawal transfer CPI.

---

## BUG-5: Two appends per transaction waste half of root_history [MEDIUM]

**File:** `anchor/programs/privacy-yield/src/lib.rs:156-157`

```rust
MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account)?;
MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account)?;
```

Each `append` call advances `root_index` and stores a new root in `root_history`. Since each transaction appends 2 commitments, `root_index` advances by 2 per transaction. The 100-entry root_history circular buffer only covers the last **50 transactions**, not 100.

Additionally, the intermediate root (after the first append but before the second) is stored in root_history but is useless — no valid proof should ever target it. This wastes 50% of the root_history capacity.

**Fix:** Either:
- Append both commitments in a single operation and store only the final root, OR
- Increase `root_history` size to 200 to compensate

---

## BUG-6: Pool vault created lazily via `init_if_needed` instead of at initialization [LOW]

**File:** `anchor/programs/privacy-yield/src/lib.rs:316-321`

```rust
#[account(
    init_if_needed,
    payer = signer,
    associated_token::mint = mint,
    associated_token::authority = pool_config
)]
pub pool_vault: Account<'info, TokenAccount>,
```

The pool vault ATA is not created during `initialize`. Instead, it's created on the first `transact` call via `init_if_needed`. This means:
- The first user to transact pays for the ATA creation rent (~0.002 SOL)
- The vault address is not stored in `pool_config`, requiring every client to derive it

`init_if_needed` also has well-documented reentrancy risks in Anchor. While this specific case is likely safe (the ATA is PDA-owned), it's better practice to create the vault during initialization.

**Fix:** Create the pool vault ATA in the `Initialize` instruction and remove `init_if_needed` from `Transact`.

---

## ~~BUG-7: NullifierAccount bump field is never written [LOW]~~ FIXED

**File:** `anchor/programs/privacy-yield/src/lib.rs`

~~The `bump` field was never written, wasting space.~~

**Fixed:** Removed the `bump` field — `NullifierAccount` is now a zero-data struct. Account existence alone is the double-spend check.

---

## ~~BUG-8: `root_history_size` has no bounds check against hardcoded array [LOW]~~ FIXED

**File:** `anchor/programs/privacy-yield/src/lib.rs`, `merkle_tree.rs`

~~The array was hardcoded to 100 while `root_history_size` was set at runtime.~~

**Fixed:** Added `const ROOT_HISTORY_SIZE: usize = 100;` used for both the array type and `merkle_tree.rs` logic. The `root_history_size` runtime field is still kept in the struct (to preserve zero_copy layout) but initialized from the constant. `merkle_tree.rs` now uses the constant directly instead of reading the runtime field.

---

## ~~BUG-9: `getMintAddressField` SOL special case is broken [LOW]~~ FIXED

**File:** `anchor/tests/lib/utils.ts`

~~For SOL, the function returned a base58 string as a decimal, producing wrong commitment hashes.~~

**Fixed:** Removed the SOL special case. All mints now use the byte-based conversion (first 31 bytes, big-endian to decimal).

---

## ~~TEST-1: Negative test assertions are too weak [TEST QUALITY]~~ FIXED

**File:** `anchor/tests/privacy_yield.ts`

~~Tests 7-9 only verified that _some_ error occurred.~~

**Fixed:** Added positive error assertions:
- Test 7 (double-spend): checks for "already in use" or "custom program error"
- Test 8 (invalid proof): checks for "InvalidProof" or error code 0x1775
- Test 9 (wrong root): checks for "UnknownRoot" or error code 0x1772

---

## TEST-2: Missing test for private transfer [TEST COVERAGE]

The PLAN.md describes a "private transfer" operation (publicAmount = 0, ownership changes between keypairs). This is a core use case but has no test coverage. A merge test exists (test 6) but uses the same keypair for input and output.

---

## TEST-3: Missing edge case tests [TEST COVERAGE]

Several important scenarios are untested:
- **Tree capacity:** What happens when `next_index` reaches `2^26` (tree full)?
- **Root history expiry:** Submit a proof against a root that has been pushed out of the 100-entry history
- **Max deposit amount:** Deposit exactly at the limit (1M USDC) and above it
- **Zero-amount withdrawal:** `ext_amount = 0` with non-zero fee (not applicable in Phase 1, but the check exists)
- **Same nullifier in both input slots:** Circuit prevents this, but worth testing the on-chain cross-check

---

## DESIGN-1: Fee recipient hardcoded to signer breaks relayer model [DESIGN]

**File:** `anchor/programs/privacy-yield/src/lib.rs:72`

```rust
fee_recipient: ctx.accounts.signer.key(), // No fee recipient — use signer as placeholder
```

The `fee_recipient` is part of the `extDataHash` and is hardcoded to the transaction signer. In Phase 3 (Arcium relayer), the signer would be the MPC cluster, not the user. The user generates the proof with their own key as `feeRecipient`, but the on-chain code uses the relayer's key. This would cause an `ExtDataHashMismatch` error.

**Impact:** None in Phase 1. Will require redesign for Phase 3.

---

## BUG-10: No authority restriction on `initialize` — anyone can front-run deployment [MEDIUM]

**File:** `anchor/programs/privacy-yield/src/lib.rs:26-45`

```rust
pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let tree_account = &mut ctx.accounts.tree_account.load_init()?;
    tree_account.authority = ctx.accounts.authority.key();
    // ...
}
```

The `initialize` instruction accepts any signer as `authority` with no check. The first caller permanently becomes the protocol authority. Since `tree_account` and `pool_config` are PDAs with `init`, re-initialization fails — so whoever calls `initialize` first wins.

**Comparison:** privacy-cash has a compile-time `ADMIN_PUBKEY` constant that gates initialization:

```rust
// privacy-cash/anchor/programs/zkcash/src/lib.rs:26-32
pub const ADMIN_PUBKEY: Option<Pubkey> = Some(pubkey!("97rSMQU..."));
// ...
if let Some(admin_key) = ADMIN_PUBKEY {
    require!(ctx.accounts.authority.key() == admin_key, ErrorCode::Unauthorized);
}
```

**Risk:** On devnet this is fine. On mainnet, a bot could monitor the deploy transaction and front-run the `initialize` call, setting itself as authority. While the authority field isn't currently used for gating (no update instructions exist), it would block any future admin functionality from being added without redeployment.

**Fix:** Add a compile-time `ADMIN_PUBKEY` constant and `require!` check in `initialize`, matching the privacy-cash pattern.

---

## BUG-11: Fee transfer CPI missing — fees accepted by ZK math but never paid out [MEDIUM]

**File:** `anchor/programs/privacy-yield/src/lib.rs:116-163`, `utils.rs:78-110`

The `check_public_amount` function correctly validates non-zero fees in its BN254 field arithmetic:

```rust
// utils.rs:97-109
if ext_amount > 0 && ext_amount_fr <= fee_fr {
    return false;  // fee guard
}
let result_public_amount = if ext_amount >= 0 {
    ext_amount_fr - fee_fr       // deposit: publicAmount = ext_amount - fee
} else {
    -(ext_amount_fr + fee_fr)    // withdrawal: publicAmount = -(ext_amount + fee)
};
```

And `ExtDataMinified` includes a `fee` field that's passed through to `extDataHash`. But the `transact` function only has two transfer paths:

1. **Deposit** (ext_amount > 0): transfers `ext_amount` from signer → pool_vault
2. **Withdrawal** (ext_amount < 0): transfers `ext_amount_abs` from pool_vault → recipient

There is **no fee transfer CPI anywhere**. If fee > 0 on a withdrawal, `ext_amount_abs` tokens go to the recipient but the `fee` tokens stay locked in the pool — unowned by any UTXO.

**Comparison:** privacy-cash has an explicit fee payment block:

```rust
// privacy-cash/anchor/programs/zkcash/src/lib.rs:314-337
if fee > 0 {
    let fee_recipient_account_info = ctx.accounts.fee_recipient_account.to_account_info();
    // ... transfer fee from pool to fee_recipient
    **tree_token_account_info.try_borrow_mut_lamports()? = new_tree_token_balance;
    **fee_recipient_account_info.try_borrow_mut_lamports()? = new_fee_recipient_balance;
}
```

And for SPL tokens (line 475-490), a separate `token::transfer` CPI sends the fee to `fee_recipient_ata`.

**Impact:** In Phase 1 (fee=0) this is harmless. But the code **accepts** non-zero fees — there's no `require!(fee == 0)` guard. A user (or future SDK) could generate a valid proof with fee > 0 and lose money:
- On deposit: user sends `ext_amount` tokens, gets UTXOs worth `ext_amount - fee`. The `fee` tokens are trapped.
- On withdrawal: `ext_amount_abs` goes to recipient, but ZK proof consumed `ext_amount_abs + fee` of UTXO value. The `fee` worth of tokens stays in the pool forever.

**Fix:** Either:
- Add `require!(ext_data.fee == 0, ErrorCode::FeesNotSupported)` to enforce Phase 1 behavior, OR
- Implement the fee transfer CPI (matching privacy-cash) for forward-compatibility

---

## BUG-12: Nullifier PDA rent permanently locked — no close instruction [LOW]

**File:** `anchor/programs/privacy-yield/src/lib.rs:267-284`

```rust
#[account(
    init,
    payer = signer,
    space = 8 + std::mem::size_of::<NullifierAccount>(),
    seeds = [b"nullifier0", proof.input_nullifiers[0].as_ref()],
    bump
)]
pub nullifier0: Account<'info, NullifierAccount>,
```

Each `transact` call creates **2 nullifier PDAs** (nullifier0 and nullifier1). `NullifierAccount` is a zero-data struct, so each PDA is 8 bytes (discriminator only) with minimum rent-exemption of ~890,880 lamports (~0.00089 SOL). Two per transaction = ~0.00178 SOL permanently locked per transaction.

There is no `close_nullifier` instruction or `close = signer` constraint. The rent is unrecoverable.

Over 10,000 transactions: ~17.8 SOL locked. Over 1M transactions: ~1,780 SOL locked.

**Comparison:** privacy-cash also lacks a close mechanism — this is a shared limitation of the nullifier-PDA pattern on Solana. However, production systems should plan for rent recovery.

**Fix:** Add a time-delayed close instruction (e.g., after root_history can no longer reference the relevant roots) or use a bitmap/bloom filter approach for spent nullifiers.

---

## Summary

| ID | Severity | Category | One-liner | Status |
|----|----------|----------|-----------|--------|
| BUG-1 | CRITICAL | Privacy | Blinding only 30 bits — commitments are brute-forceable | **FIXED** |
| BUG-2 | HIGH | Validation | No mint check — pool accepts any SPL token | **FIXED** |
| BUG-3 | MEDIUM | Validation | Signer token account uses manual checks, not constraints | WON'T FIX (SBF stack limit) |
| BUG-4 | MEDIUM | UX | Withdrawal balance check missing, unhelpful error | **FIXED** |
| BUG-5 | MEDIUM | Capacity | Root history wastes 50% capacity on intermediate roots | OPEN |
| BUG-6 | LOW | Design | Pool vault not created at init, uses init_if_needed | OPEN |
| BUG-7 | LOW | Waste | NullifierAccount.bump never written | **FIXED** |
| BUG-8 | LOW | Safety | root_history_size not tied to array length | **FIXED** |
| BUG-9 | LOW | Correctness | getMintAddressField SOL path returns wrong value | **FIXED** |
| BUG-10 | MEDIUM | Security | No authority check — anyone can front-run initialize | OPEN |
| BUG-11 | MEDIUM | Correctness | Fee CPI missing — non-zero fees accepted but never paid | OPEN |
| BUG-12 | LOW | Rent | Nullifier PDAs permanently lock rent, no close instruction | OPEN |
| TEST-1 | TEST | Quality | Negative tests don't check error types | **FIXED** |
| TEST-2 | TEST | Coverage | No private transfer test | OPEN |
| TEST-3 | TEST | Coverage | Missing edge case tests | OPEN |
| DESIGN-1 | DESIGN | Phase 3 | Fee recipient hardcoded to signer | OPEN (Phase 3) |
