# Kamino (klend) Integration — Devnet Guide

How to deposit/withdraw USDC into Kamino Lending from the privacy-yield protocol on Solana devnet.

---

## TL;DR

- **Program ID**: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` (same on mainnet + devnet)
- **No existing devnet markets** — we must create our own market + USDC reserve
- We only need **two instructions**: `deposit_reserve_liquidity` (USDC → cTokens) and `redeem_reserve_collateral` (cTokens → USDC)
- No obligations or borrowing — just simple deposit/redeem for yield
- **SDK**: `@kamino-finance/klend-sdk` at `klend-sdk/` — has helpers for market creation and actions
- **Oracle required**: Each reserve needs a price feed (Scope, Pyth, or Switchboard)

---

## What We Need vs What Exists

| Component | Status |
|-----------|--------|
| klend program on devnet | Deployed (same ID as mainnet) |
| Lending market for our pool | Must create |
| USDC reserve in that market | Must create |
| Oracle for USDC price | Must set up (Pyth devnet or Scope) |
| cToken mint (created by klend) | Auto-created when reserve is initialized |
| Our pool's cToken account | Create ATA for pool_config PDA |

---

## Account Architecture

When our privacy-yield program interacts with klend, here's the full picture:

```
OUR PROGRAM (privacy-yield)                    KLEND PROGRAM
─────────────────────────                      ────────────────
pool_config PDA                                LendingMarket
  └── pool_usdc ATA (USDC reserve)             Reserve (USDC)
  └── pool_ctoken ATA (cTokens) ← NEW           ├── reserve_liquidity_supply (vault holding USDC)
                                                 ├── reserve_collateral_mint (cToken mint, PDA)
                                                 ├── reserve_collateral_supply (cToken vault)
                                                 └── fee_receiver (protocol fees)
                                               LendingMarketAuthority (PDA)
```

### Key PDAs (derived by klend)

| PDA | Seeds | Purpose |
|-----|-------|---------|
| Lending Market Authority | `["lma", lending_market]` | Signs token transfers on behalf of klend |
| Reserve Liquidity Supply | `["reserve_liq_supply", reserve]` | Vault holding deposited USDC |
| Reserve Collateral Mint | `["reserve_coll_mint", reserve]` | cToken mint (like kUSDC) |
| Reserve Collateral Supply | `["reserve_coll_supply", reserve]` | Vault holding cTokens for obligations |
| Fee Receiver | `["fee_receiver", reserve]` | Holds protocol fees |

---

## Step 1: One-Time Setup (Create Market + Reserve)

This is done ONCE before the protocol can earn yield. Can use the klend-sdk CLI or programmatic API.

### Option A: Using klend-sdk CLI

```bash
cd /Users/chinmaygopal/dev/arcium-explore/klend-sdk

# Create a new lending market
yarn kamino-manager create-market \
  --rpc https://devnet.helius-rpc.com/?api-key=a9002ef8-4f2b-45ea-b7b0-40af9f1bd54f \
  --mode execute

# Add USDC reserve to the market
yarn kamino-manager add-asset-to-market \
  --market <MARKET_ADDRESS_FROM_ABOVE> \
  --mint <USDC_DEVNET_MINT> \
  --mint-program-id TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
  --reserve-config-path ./configs/reserve_config_usdc.json \
  --rpc https://devnet.helius-rpc.com/?api-key=a9002ef8-4f2b-45ea-b7b0-40af9f1bd54f \
  --mode execute
```

### Option B: Programmatic (TypeScript)

```typescript
import { KaminoManager } from '@kamino-finance/klend-sdk';
import { address } from '@solana/kit';

const KLEND_PROGRAM_ID = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

const manager = new KaminoManager(rpc, 400, KLEND_PROGRAM_ID);

// 1. Create market
const { ixs, market } = await manager.createMarketIxs({
  owner: adminKeypair,
  quoteCurrency: 'USD',
});
// Sign and send ixs...

// 2. Add USDC reserve
const reserveIxs = await manager.addAssetToMarketIxs({
  market: market.address,
  mint: USDC_MINT,
  reserveConfig: usdcReserveConfig, // see reserve config below
  owner: adminKeypair,
});
// Sign and send reserveIxs (may be multiple tx batches)...
```

### Reserve Config for USDC

We need a minimal config since we're only depositing (no borrowing against it):

```json
{
  "status": 0,
  "loanToValuePct": 0,
  "liquidationThresholdPct": 0,
  "minLiquidationBonusBps": 0,
  "protocolLiquidationFeePct": 0,
  "depositLimit": "1000000000000",
  "borrowLimit": "0",
  "tokenInfo": {
    "name": "USDC",
    "maxAgePriceSeconds": "300",
    "maxAgeTwapSeconds": "600",
    "scopeConfiguration": {
      "priceFeed": "11111111111111111111111111111111",
      "priceChain": [65535, 65535, 65535, 65535],
      "twapChain": [65535, 65535, 65535, 65535]
    },
    "switchboardConfiguration": {
      "priceAggregator": "11111111111111111111111111111111",
      "twapAggregator": "11111111111111111111111111111111"
    },
    "pythConfiguration": {
      "price": "<PYTH_USDC_DEVNET_FEED>"
    }
  },
  "borrowRateCurve": {
    "points": [
      { "utilizationRateBps": 0, "borrowRateBps": 0 },
      { "utilizationRateBps": 10000, "borrowRateBps": 0 }
    ]
  }
}
```

Note: At least one oracle must be configured. Pyth has devnet feeds for USDC.

---

## Step 2: Deposit (USDC → cTokens)

### Instruction: `deposit_reserve_liquidity`

This is the simple deposit — send USDC, receive cTokens. No obligation needed.

**Accounts (12 total):**

| # | Account | Type | Description |
|---|---------|------|-------------|
| 1 | `owner` | Signer, Mut | Who's depositing (our pool_config PDA via CPI, or user) |
| 2 | `reserve` | Mut | The USDC reserve account |
| 3 | `lending_market` | Read | The lending market |
| 4 | `lending_market_authority` | PDA | `["lma", lending_market]` — signs transfers |
| 5 | `reserve_liquidity_mint` | Read | USDC mint |
| 6 | `reserve_liquidity_supply` | Mut | klend's USDC vault (receives our USDC) |
| 7 | `reserve_collateral_mint` | Mut | cToken mint (klend mints cTokens to us) |
| 8 | `user_source_liquidity` | Mut | Our pool's USDC token account (source) |
| 9 | `user_destination_collateral` | Mut | Our pool's cToken account (destination) |
| 10 | `collateral_token_program` | Program | Token program for cTokens |
| 11 | `liquidity_token_program` | Program | Token program for USDC |
| 12 | `instruction_sysvar_account` | Sysvar | `SysvarInstructions111111111111111111111111` |

**Args:** `{ liquidity_amount: u64 }` — amount of USDC to deposit

**What happens:**
1. USDC transfers from `user_source_liquidity` → `reserve_liquidity_supply`
2. klend computes cToken amount via exchange rate: `cTokens = usdc_amount / exchange_rate`
3. cTokens minted from `reserve_collateral_mint` → `user_destination_collateral`

**Exchange rate** increases over time as interest accrues. This IS the yield.

### Client-side (using SDK for testing)

```typescript
import { KaminoAction, KaminoMarket, VanillaObligation } from '@kamino-finance/klend-sdk';

const market = await KaminoMarket.load(rpc, MARKET_ADDRESS, 400, KLEND_PROGRAM_ID);

const depositAction = await KaminoAction.buildDepositReserveLiquidityTxns(
  market,
  new BN(1_000_000), // 1 USDC (6 decimals)
  usdcReserve.getLiquidityMint(),
  wallet,
  new VanillaObligation(KLEND_PROGRAM_ID),
  undefined,  // scopeRefreshConfig
  300_000,    // compute budget
  true        // create ATAs if needed
);

// Transaction = computeBudget + setup + lending + cleanup
const ixs = [
  ...depositAction.computeBudgetIxs,
  ...depositAction.setupIxs,
  ...depositAction.lendingIxs,
  ...depositAction.cleanupIxs,
];
```

---

## Step 3: Redeem (cTokens → USDC)

### Instruction: `redeem_reserve_collateral`

Send cTokens back, receive USDC. The USDC amount will be MORE than originally deposited (yield).

**Accounts (12 total):**

| # | Account | Type | Description |
|---|---------|------|-------------|
| 1 | `owner` | Signer | Who's redeeming |
| 2 | `lending_market` | Read | The lending market |
| 3 | `reserve` | Mut | The USDC reserve |
| 4 | `lending_market_authority` | PDA | `["lma", lending_market]` |
| 5 | `reserve_liquidity_mint` | Read | USDC mint |
| 6 | `reserve_collateral_mint` | Mut | cToken mint (klend burns our cTokens) |
| 7 | `reserve_liquidity_supply` | Mut | klend's USDC vault (sends USDC to us) |
| 8 | `user_source_collateral` | Mut | Our pool's cToken account (source) |
| 9 | `user_destination_liquidity` | Mut | Our pool's USDC account (destination) |
| 10 | `collateral_token_program` | Program | Token program for cTokens |
| 11 | `liquidity_token_program` | Program | Token program for USDC |
| 12 | `instruction_sysvar_account` | Sysvar | `SysvarInstructions111111111111111111111111` |

**Args:** `{ collateral_amount: u64 }` — amount of cTokens to burn

**What happens:**
1. cTokens transfer from `user_source_collateral` → burned by klend
2. klend computes USDC amount: `usdc = cTokens * exchange_rate`
3. USDC transfers from `reserve_liquidity_supply` → `user_destination_liquidity`

### Client-side (using SDK)

```typescript
const redeemAction = await KaminoAction.buildRedeemReserveCollateralTxns(
  market,
  new BN(cTokenBalance), // amount of cTokens to redeem
  usdcReserve.getLiquidityMint(),
  wallet,
  new VanillaObligation(KLEND_PROGRAM_ID),
  undefined,
  300_000,
  true
);
```

---

## Step 4: CPI from Privacy-Yield Program (Phase 2)

When our Anchor program calls klend via CPI, it needs to:

1. **Sign as the pool_config PDA** (since it owns the token accounts)
2. **Pass all 12 accounts** for deposit or redeem
3. **Derive the lending_market_authority PDA** for klend's internal checks

### Rust CPI Pattern (conceptual)

```rust
// In privacy-yield program

// New accounts needed in the Transact/Sweep context:
pub klend_program: Program<'info, KlendProgram>,
pub lending_market: AccountInfo<'info>,
pub lending_market_authority: AccountInfo<'info>,  // PDA: ["lma", lending_market]
pub reserve: AccountInfo<'info>,
pub reserve_liquidity_supply: AccountInfo<'info>,  // PDA: ["reserve_liq_supply", reserve]
pub reserve_collateral_mint: AccountInfo<'info>,   // PDA: ["reserve_coll_mint", reserve]
pub pool_ctoken_account: AccountInfo<'info>,       // ATA(pool_config, ctoken_mint)
pub instruction_sysvar: AccountInfo<'info>,

// Deposit CPI
let cpi_accounts = DepositReserveLiquidity {
    owner: pool_config.to_account_info(),         // PDA signer
    reserve: reserve.to_account_info(),
    lending_market: lending_market.to_account_info(),
    lending_market_authority: lending_market_authority.to_account_info(),
    reserve_liquidity_mint: usdc_mint.to_account_info(),
    reserve_liquidity_supply: reserve_liquidity_supply.to_account_info(),
    reserve_collateral_mint: reserve_collateral_mint.to_account_info(),
    user_source_liquidity: pool_usdc_account.to_account_info(),    // our USDC vault
    user_destination_collateral: pool_ctoken_account.to_account_info(), // our cToken account
    collateral_token_program: token_program.to_account_info(),
    liquidity_token_program: token_program.to_account_info(),
    instruction_sysvar_account: instruction_sysvar.to_account_info(),
};

let seeds = &[b"pool_config", &[pool_config_bump]];
let signer_seeds = &[&seeds[..]];

let cpi_ctx = CpiContext::new_with_signer(
    klend_program.to_account_info(),
    cpi_accounts,
    signer_seeds,
);

klend::cpi::deposit_reserve_liquidity(cpi_ctx, amount)?;
```

### New Instructions for Phase 2

| Instruction | Who calls | What it does |
|-------------|-----------|-------------|
| `sweep` | Anyone (permissionless) | Deposits excess USDC from pool → klend reserve |
| `redeem_for_withdrawal` | Called within `transact` | Redeems cTokens when USDC reserve is low |

### New Accounts in pool_config

```rust
pub struct PoolConfig {
    // ... existing fields ...
    pub lending_market: Pubkey,     // klend market address
    pub reserve: Pubkey,            // klend USDC reserve address
    pub ctoken_mint: Pubkey,        // cToken mint (from reserve)
    pub sweep_threshold: u64,       // USDC threshold to trigger sweep
}
```

### New Token Account

```
pool_ctoken ATA:
  mint: reserve_collateral_mint (cToken)
  authority: pool_config PDA
  Created during initialize (Phase 2)
```

---

## Exchange Rate — How Yield Works

The cToken exchange rate is stored in the Reserve account and increases over time:

```
exchange_rate = total_liquidity / total_ctoken_supply

Day 0:   rate = 1.000000  →  1000 USDC = 1000 cTokens
Day 90:  rate = 1.020000  →  1000 cTokens = 1020 USDC
Day 365: rate = 1.080000  →  1000 cTokens = 1080 USDC (~8% APY)
```

For our protocol:
- **Deposit**: client reads `rate`, computes `ctoken_amount = usdc / rate`, stores in UTXO commitment
- **Withdraw**: program reads `rate`, computes `usdc_payout = ctoken_amount * rate`
- **Yield** = the difference, with no extra accounting

### Reading the Rate

```typescript
const market = await KaminoMarket.load(rpc, MARKET_ADDRESS, 400, KLEND_PROGRAM_ID);
const reserve = market.getReserveByMint(USDC_MINT);

// Exchange rate
const rate = reserve.getExchangeRate(); // Decimal

// Convert
const ctokensForDeposit = usdcAmount / rate;
const usdcFromRedeem = ctokenAmount * rate;
```

On-chain, the rate is derived from `reserve.liquidity.available_amount`, `reserve.liquidity.borrowed_amount_sf`, and `reserve.collateral.mint_total_supply`.

---

## Addresses We Need (To Be Filled After Setup)

```
KLEND_PROGRAM_ID    = KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
LENDING_MARKET      = <created in step 1>
USDC_RESERVE        = <created in step 1>
USDC_MINT           = <devnet USDC mint>
CTOKEN_MINT         = <auto-derived: ["reserve_coll_mint", reserve]>
MARKET_AUTHORITY    = <auto-derived: ["lma", lending_market]>
RESERVE_LIQ_SUPPLY  = <auto-derived: ["reserve_liq_supply", reserve]>
RESERVE_COLL_SUPPLY = <auto-derived: ["reserve_coll_supply", reserve]>
FEE_RECEIVER        = <auto-derived: ["fee_receiver", reserve]>
POOL_CTOKEN_ATA     = <ATA(pool_config_pda, ctoken_mint)>
```

---

## Setup Checklist

1. [ ] Get/create a devnet USDC mint (or use an existing devnet faucet)
2. [ ] Set up a Pyth devnet oracle for USDC price
3. [ ] Create a lending market using klend-sdk
4. [ ] Add USDC reserve to the market with oracle config
5. [ ] Seed the reserve with initial liquidity (required by `initReserve`)
6. [ ] Record all addresses above
7. [ ] Update `pool_config` struct to store klend addresses
8. [ ] Add `pool_ctoken` ATA creation to `initialize`
9. [ ] Implement `sweep` instruction (deposit excess USDC → klend)
10. [ ] Update `transact` withdrawal path to redeem from klend when reserve is low
11. [ ] Add cToken balance tracking for exchange rate calculations
12. [ ] Test deposit → sweep → withdraw → redeem cycle
