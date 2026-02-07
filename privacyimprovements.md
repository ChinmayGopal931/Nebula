Privacy Improvements for Privacy-Yield-Protocol

The Core Problem

Privacy-cash's ZK proofs only hide which UTXO is being spent. Everything else leaks: amounts, recipients, IPs, timing, scan patterns. Your protocol already plans Arcium for  
 IP/timing privacy (Phase 3), but there are much deeper improvements possible.

---

1. Fixed Denomination Pools (Highest Impact, No Arcium Needed)

The leak: Privacy-cash allows arbitrary amounts. Deposit 1,337.42 USDC, withdraw 1,337.42 USDC — trivially linkable.

The fix: Multiple pools with fixed denominations: 100, 1000, 10000 USDC.

User wants to deposit 2,500 USDC:
→ 2x into the 1,000 pool
→ 5x into the 100 pool

User wants to withdraw 1,500 USDC:
→ 1x from the 1,000 pool
→ 5x from the 100 pool

Every deposit and withdrawal in a given pool looks identical on-chain. The anonymity set becomes the entire pool membership, not "users who deposited this exact amount."

Trade-off: More transactions, higher gas. But this is the single biggest privacy improvement possible — it's what made Tornado Cash actually work.

Implementation: Separate MerkleTreeAccount per denomination. The existing circuit already works — just enforce publicAmount matches the fixed denomination in the on-chain
program.

---

2. Arcium Private UTXO Scanner (Novel, High Impact)

The leak: Privacy-cash's relayer learns everything from UTXO scan patterns. When you query /utxos/range?start=X&end=Y, the relayer knows your approximate tree position,
number of UTXOs, and activity timeline. Your current frontend fetches directly from RPC (better than a relayer), but the RPC still sees which wallet is calling
getSignaturesForAddress on the tree account.

The idea: Use an Arcium MPC circuit to scan UTXOs privately.

Arcium Circuit: "private_utxo_scan"

Input (encrypted to MPC cluster): - User's decryption key (derived from wallet signature) - Range of tree indices to scan

MPC internally: - Fetches ALL encrypted outputs from the tree (or a cached copy) - Tries decrypting each with the user's key - Returns ONLY the successfully decrypted UTXOs

Output (encrypted back to user): - List of {amount, blinding, index} for user's UTXOs

No single MPC node sees the decryption key or which UTXOs belong to the user. The RPC sees the MPC cluster querying the tree — not the user. The user's IP never touches the
RPC.

Why this matters: Even without a centralized relayer, your current frontend leaks scan patterns to the RPC provider. This eliminates that entirely.

---

3. Arcium Batch Submission with Shuffling (Extends Phase 3 Plan)

The leak your plan already addresses: Timing correlation between withdrawal request and on-chain appearance.

Going deeper — add transaction shuffling:

Current plan:
User A submits at 3:01, User B at 3:05, User C at 3:12
Batch at 3:15: [A, B, C] submitted in order
→ Observer sees ordering matches arrival time

Improved:
Arcium circuit randomly shuffles the batch before submission
Batch at 3:15: [C, A, B] submitted in random order
→ Even if observer infers batch timing, ordering leaks nothing

The MPC circuit generates randomness internally (Arcium supports ArcisRNG) and shuffles the queue before constructing transactions.

Also: randomized batch timing. Don't submit exactly every 15 minutes. Add MPC-generated random jitter (12-18 minutes). Prevents observers from predicting batch boundaries.

---

4. Deposit Shielding via MPC (Novel)

The leak: Deposits are currently submitted directly by the user's wallet. The depositor's address is the signer in the transaction — permanently linking their identity to a
deposit timestamp and amount.

The idea: Route deposits through Arcium too.

User: 1. Signs the deposit transaction (USDC transfer + ZK proof) 2. Encrypts the signed transaction to Arcium MPC cluster 3. Sends encrypted blob to Arcium

Arcium MPC: 1. Collects deposit requests into a batch 2. Submits all deposits in a single batch 3. The MPC cluster's wallet is the gas payer (reimbursed from deposit fees)

On-chain observer sees: - The MPC cluster address as signer (not the user) - 5 deposits at the same time - Can't tell which user initiated which deposit

Challenge: The USDC transfer still needs to come from the user's wallet. Solution: Two-step — user first transfers USDC to a temporary escrow PDA, then the MPC submits the
actual transact instruction. Or use a pre-signed token approval + delegate transfer.

Alternative (simpler): User deposits USDC into a "staging vault" with no privacy (normal SPL transfer). The MPC circuit then batch-processes all staging vault deposits into
the shielded pool at random intervals. The user's USDC enters the staging vault, but the actual tree insertion happens via MPC batch — breaking the timing link.

---

5. Decoy Transactions (Medium Impact)

The leak: Change outputs create deterministic chains. Withdraw 95 from 100 → 5 change. Later spend that 5. The chain is traceable.

The idea: The MPC batch circuit inserts decoy transactions alongside real ones.

Real batch: [withdraw_A, withdraw_B, withdraw_C]
Submitted batch: [withdraw_A, decoy_merge, withdraw_B, decoy_deposit, withdraw_C, decoy_merge]

Decoys are valid transactions (merge 0+0→0, or self-transfers)
that create noise commitments in the tree.

Decoys are funded by protocol fees or a small "privacy tax" on each transaction. They increase the number of commitments in the tree without corresponding real activity,
making graph analysis harder.

Simpler version: Just have the program always emit 2 output commitments (already does), and make the "empty" output indistinguishable from real ones. Currently empty outputs
use amount=0, which might be distinguishable by encrypted output size. Pad all encrypted outputs to identical length.

---

6. Ephemeral Keypairs Per Transaction (Medium Impact, Client-Side)

The leak: Privacy-cash derives the same Poseidon keypair from the wallet signature for ALL UTXOs. The pubkey component in every commitment is identical — linking all
commitments from the same wallet.

The fix: Generate a fresh random keypair per UTXO.

Current (privacy-cash):
keypair = Poseidon(Keccak256(walletSignature)) // SAME for all UTXOs
commitment = Poseidon(amount, keypair.pubkey, blinding, mint)

Improved:
keypair_1 = random() // unique per UTXO
commitment_1 = Poseidon(amount, keypair_1.pubkey, blinding_1, mint)

    keypair_2 = random()  // different!
    commitment_2 = Poseidon(amount, keypair_2.pubkey, blinding_2, mint)

Your frontend already does this! Your utxo-store.ts stores keypairPrivkey per UTXO in IndexedDB. This is a huge improvement over privacy-cash's shared-keypair model. Just
make sure the keypair is truly random (not derived from the wallet).

Trade-off: User must store each keypair. Lose your IndexedDB = lose funds. Consider encrypted cloud backup via Arcium (see idea #9).

---

7. Private Tree Sync via On-Chain Encrypted Index (Medium Impact)

The leak: Your frontend calls getSignaturesForAddress(TREE_PDA) to rebuild the merkle tree. The RPC provider learns which wallet is interested in the privacy pool. Even worse
— the request pattern reveals when the user last synced.

Options:

A. Shared public indexer (minimal trust): Run a public indexer that maintains the full tree state. Every user fetches the same complete tree snapshot — no user-specific
queries. The indexer can't distinguish who's a pool participant vs. a curious observer.

GET /tree/snapshot → returns all commitments (same data for everyone)
No query params, no wallet addresses, no pagination that reveals position

B. Arcium-hosted tree (maximum privacy): The MPC cluster maintains an encrypted copy of the tree. Users query the MPC for their specific leaf data (encrypted request), and
the MPC returns only what they need (encrypted response). The RPC never sees user-specific queries.

C. Client-side full sync (your current approach, acceptable): Fetch ALL signatures for the tree account. This is the same data regardless of which user you are. The RPC sees
you're interested in the privacy pool, but not which UTXOs are yours. This is actually decent — just make sure you're not using a wallet-authenticated RPC that links your
wallet to the tree queries.

---

8. Recipient Stealth Addresses (High Impact, Needs New Circuit)

The leak: The recipient address is visible in every withdrawal transaction. If Alice withdraws to alice_new_wallet.sol, an observer sees that address receiving funds.

The idea: Use stealth addresses. The recipient generates a one-time address that only they can derive the private key for.

Alice publishes: stealth_meta_address (public, on her profile/ENS)
Bob (or Alice herself) generates: one-time stealth_address from stealth_meta_address + random nonce
Withdrawal goes to: stealth_address (no public link to Alice)
Alice derives: private key for stealth_address (only she can, using her meta key + the nonce)

Solana challenge: Stealth addresses are harder on Solana than Ethereum because accounts need SOL for rent. The MPC relayer could fund the stealth address's rent as part of
the withdrawal (from the relayer fee).

Simpler alternative for now: Just emphasize in the UI that users should withdraw to a fresh wallet with no prior history. The protocol can't enforce this, but the UI can
generate a fresh keypair and display it as the default recipient.

---

9. Arcium-Encrypted Receipt Backup (Quality of Life + Privacy)

The leak risk: Users store UTXO receipts in IndexedDB. If they clear browser data, they lose funds. Privacy-cash caches signatures in localStorage — both are vulnerable to
XSS, extensions, and data loss.

The idea: Encrypt receipts to the Arcium MPC cluster for backup.

Arcium Circuit: "backup_receipt"

Input (encrypted to MPC): - User's wallet signature (for auth) - Encrypted receipt blob (encrypted with user's own key)

MPC: - Stores the encrypted blob (can't decrypt it — user's key) - On restore request: verifies wallet signature, returns blob

The MPC stores encrypted data it can't read. The user can recover from any device by signing the same message. No single MPC node has the data or the key.

---

10. Uniform Encrypted Output Sizes (Easy Win)

The leak: Encrypted outputs in events have variable sizes. An output encrypting 1000000|12345|42|USDC_MINT is shorter than 999999999|987654321|12345|USDC_MINT. Size
differences leak approximate amounts.

The fix: Pad all encrypted outputs to a fixed size (e.g., 128 bytes) before emitting in events. Your on-chain program already takes encrypted_output: Vec<u8> — just pad
client-side.

---

11. Gas Sponsorship via MPC (Prevents Funding Link)

The leak: To withdraw, the recipient wallet needs SOL for gas. If Alice funds new_wallet with SOL from a known address, that's a funding link.

Already partially solved by MPC relayer: If the Arcium cluster submits the withdrawal transaction, the cluster pays gas. The recipient doesn't need any SOL upfront.

Enhancement: The relayer fee (deducted from the withdrawal amount) covers gas + MPC costs. The recipient receives USDC minus fee, needs zero SOL, has zero prior history.

---

Priority Ranking
┌─────┬────────────────────────────────┬───────────┬────────────┬──────────────────────────┐
│ # │ Idea │ Impact │ Complexity │ Needs New Circuit? │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 1 │ Fixed denomination pools │ Critical │ Medium │ No (program change only) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 3 │ Batch submission + shuffling │ High │ Low │ Yes (extends Phase 3) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 6 │ Ephemeral keypairs per UTXO │ High │ Low │ No (already done in FE) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 10 │ Uniform encrypted output sizes │ High │ Trivial │ No (client padding) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 11 │ Gas sponsorship via MPC │ High │ Low │ Yes (Phase 3 inherent) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 4 │ Deposit shielding via MPC │ High │ Medium │ Yes (new circuit) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 2 │ Private UTXO scanner via MPC │ High │ High │ Yes (new circuit) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 5 │ Decoy transactions │ Medium │ Medium │ Yes (protocol change) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 7 │ Private tree sync │ Medium │ Medium │ Depends on approach │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 8 │ Stealth addresses │ Medium │ High │ Yes (new circuit) │
├─────┼────────────────────────────────┼───────────┼────────────┼──────────────────────────┤
│ 9 │ Encrypted receipt backup │ Low (QoL) │ Medium │ Yes (new circuit) │
└─────┴────────────────────────────────┴───────────┴────────────┴──────────────────────────┘
Recommended Phase 3 scope: Ideas 1, 3, 6, 10, 11 — these give you the biggest privacy gains with manageable complexity. Ideas 2 and 4 (MPC-routed deposits + private scanning)
are the novel differentiators that would set this apart from every other privacy protocol on Solana.
