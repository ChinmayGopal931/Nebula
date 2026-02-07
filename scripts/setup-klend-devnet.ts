/**
 * Setup klend on Devnet
 *
 * Creates a test USDC mint, creates a lending market + USDC reserve,
 * updates reserve config, then tests deposit and redeem.
 *
 * IMPORTANT: This targets the DEPLOYED devnet version of klend which is
 * an older version than the source in klend/. The IDL was fetched via:
 *   anchor idl fetch KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD --provider.cluster devnet
 *
 * Usage: cd privacy-yield-protocol/anchor && npx ts-node --transpile-only --skip-project \
 *   --compiler-options '{"module":"commonjs","target":"es2020","esModuleInterop":true}' \
 *   ../scripts/setup-klend-devnet.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

// Account sizes — the deployed binary uses NEWER struct layouts despite
// the old IDL. The program panics if accounts are too small.
// "range end index 4664 out of range for slice of length 664"
const LENDING_MARKET_SIZE = 4656 + 8; // 4664 bytes
const RESERVE_SIZE = 8616 + 8; // 8624 bytes

// PDA seeds (same across versions)
const SEED_LENDING_MARKET_AUTH = "lma";
const SEED_RESERVE_LIQ_SUPPLY = "reserve_liq_supply";
const SEED_FEE_RECEIVER = "fee_receiver";
const SEED_RESERVE_COLL_MINT = "reserve_coll_mint";
const SEED_RESERVE_COLL_SUPPLY = "reserve_coll_supply";

// Instruction discriminators — SHA256("global:<fn_name>")[0..8]
// These are stable because function names haven't changed.
const DISC_INIT_LENDING_MARKET = Buffer.from([
  34, 162, 116, 14, 101, 137, 94, 239,
]);
const DISC_INIT_RESERVE = Buffer.from([138, 245, 71, 225, 153, 4, 3, 43]);
const DISC_REFRESH_RESERVE = Buffer.from([
  2, 218, 138, 235, 79, 201, 25, 102,
]);
const DISC_DEPOSIT_RESERVE_LIQUIDITY = Buffer.from([
  169, 201, 30, 126, 6, 205, 102, 68,
]);
const DISC_REDEEM_RESERVE_COLLATERAL = Buffer.from([
  234, 117, 181, 125, 185, 142, 220, 29,
]);
const DISC_UPDATE_RESERVE_CONFIG = Buffer.from([
  61, 148, 100, 70, 143, 107, 17, 13,
]);

// UpdateConfigMode enum values (u64) — from devnet IDL
// The mode arg is a raw u64 in the devnet version.
const UPDATE_CONFIG_MODE = {
  UpdateDepositLimit: 12,
  UpdatePythPrice: 24,
  UpdateEntireReserveConfig: 27,
};

// RPC endpoint
const RPC_URL =
  "https://devnet.helius-rpc.com/?api-key=a9002ef8-4f2b-45ea-b7b0-40af9f1bd54f";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadWallet(): Keypair {
  const keypairPath = path.join(
    process.env.HOME!,
    ".config",
    "solana",
    "id.json"
  );
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function sendTx(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  signers: Keypair[] = [],
  label?: string
): Promise<string> {
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToLegacyMessage();

  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...signers]);

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(
    { signature: sig, ...blockhash },
    "confirmed"
  );

  if (label) console.log(`  ✓ ${label}: ${sig}`);
  return sig;
}

function encodeLittleEndianU64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

// ─── PDA Derivation ──────────────────────────────────────────────────────────

function deriveLendingMarketAuthority(
  lendingMarket: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LENDING_MARKET_AUTH), lendingMarket.toBuffer()],
    KLEND_PROGRAM_ID
  );
}

// Devnet version uses seeds: [seed_name, lending_market, liquidity_mint]
// NOT [seed_name, reserve] as in the newer source code.
function deriveReserveLiqSupply(
  lendingMarket: PublicKey,
  liquidityMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED_RESERVE_LIQ_SUPPLY),
      lendingMarket.toBuffer(),
      liquidityMint.toBuffer(),
    ],
    KLEND_PROGRAM_ID
  );
}

function deriveFeeReceiver(
  lendingMarket: PublicKey,
  liquidityMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED_FEE_RECEIVER),
      lendingMarket.toBuffer(),
      liquidityMint.toBuffer(),
    ],
    KLEND_PROGRAM_ID
  );
}

function deriveReserveCollMint(
  lendingMarket: PublicKey,
  liquidityMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED_RESERVE_COLL_MINT),
      lendingMarket.toBuffer(),
      liquidityMint.toBuffer(),
    ],
    KLEND_PROGRAM_ID
  );
}

function deriveReserveCollSupply(
  lendingMarket: PublicKey,
  liquidityMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED_RESERVE_COLL_SUPPLY),
      lendingMarket.toBuffer(),
      liquidityMint.toBuffer(),
    ],
    KLEND_PROGRAM_ID
  );
}

// ─── Instruction Builders (devnet version) ───────────────────────────────────
// These match the deployed devnet program IDL, NOT the local klend/ source.

/**
 * initLendingMarket — 6 accounts (devnet version includes tokenProgramId)
 * Args: quoteCurrency: [u8; 32]
 */
function buildInitLendingMarket(
  owner: PublicKey,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  quoteCurrency: Buffer
): TransactionInstruction {
  const data = Buffer.concat([DISC_INIT_LENDING_MARKET, quoteCurrency]);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isMut: true, isSigner: true },
      { pubkey: lendingMarket, isMut: true, isSigner: false },
      { pubkey: lendingMarketAuthority, isMut: false, isSigner: false },
      { pubkey: SystemProgram.programId, isMut: false, isSigner: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isMut: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isMut: false, isSigner: false }, // tokenProgramId (last)
    ],
    data,
  });
}

/**
 * initReserve — 12 accounts (devnet version)
 * Signer is lendingMarketOwner. lendingMarketAuthority is mutable.
 * No initialLiquiditySource — old version doesn't require initial deposit.
 * Args: none
 */
function buildInitReserve(
  lendingMarketOwner: PublicKey,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  reserve: PublicKey,
  reserveLiquidityMint: PublicKey,
  reserveLiquiditySupply: PublicKey,
  feeReceiver: PublicKey,
  reserveCollateralMint: PublicKey,
  reserveCollateralSupply: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: lendingMarketOwner, isMut: true, isSigner: true },
      { pubkey: lendingMarket, isMut: false, isSigner: false },
      { pubkey: lendingMarketAuthority, isMut: true, isSigner: false }, // mutable in devnet version
      { pubkey: reserve, isMut: true, isSigner: false },
      { pubkey: reserveLiquidityMint, isMut: false, isSigner: false },
      { pubkey: reserveLiquiditySupply, isMut: true, isSigner: false },
      { pubkey: feeReceiver, isMut: true, isSigner: false },
      { pubkey: reserveCollateralMint, isMut: true, isSigner: false },
      { pubkey: reserveCollateralSupply, isMut: true, isSigner: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isMut: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isMut: false, isSigner: false },
      { pubkey: SystemProgram.programId, isMut: false, isSigner: false },
    ],
    data: DISC_INIT_RESERVE,
  });
}

/**
 * refreshReserve — 5 accounts (devnet version, no lendingMarket)
 * Args: none
 */
function buildRefreshReserve(
  reserve: PublicKey,
  pythOracle: PublicKey | null,
  switchboardPriceOracle: PublicKey | null,
  switchboardTwapOracle: PublicKey | null,
  scopePrices: PublicKey | null
): TransactionInstruction {
  const optionalKey = (key: PublicKey | null) => key || KLEND_PROGRAM_ID;

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: reserve, isMut: true, isSigner: false },
      { pubkey: optionalKey(pythOracle), isMut: false, isSigner: false },
      {
        pubkey: optionalKey(switchboardPriceOracle),
        isMut: false,
        isSigner: false,
      },
      {
        pubkey: optionalKey(switchboardTwapOracle),
        isMut: false,
        isSigner: false,
      },
      { pubkey: optionalKey(scopePrices), isMut: false, isSigner: false },
    ],
    data: DISC_REFRESH_RESERVE,
  });
}

/**
 * depositReserveLiquidity — 9 accounts (devnet version)
 * No reserveLiquidityMint, no instructionSysvar.
 * Args: liquidityAmount: u64
 */
function buildDepositReserveLiquidity(
  owner: PublicKey,
  reserve: PublicKey,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  reserveLiquiditySupply: PublicKey,
  reserveCollateralMint: PublicKey,
  userSourceLiquidity: PublicKey,
  userDestinationCollateral: PublicKey,
  liquidityAmount: bigint
): TransactionInstruction {
  const data = Buffer.concat([
    DISC_DEPOSIT_RESERVE_LIQUIDITY,
    encodeLittleEndianU64(liquidityAmount),
  ]);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isMut: false, isSigner: true },
      { pubkey: reserve, isMut: true, isSigner: false },
      { pubkey: lendingMarket, isMut: false, isSigner: false },
      { pubkey: lendingMarketAuthority, isMut: false, isSigner: false },
      { pubkey: reserveLiquiditySupply, isMut: true, isSigner: false },
      { pubkey: reserveCollateralMint, isMut: true, isSigner: false },
      { pubkey: userSourceLiquidity, isMut: true, isSigner: false },
      { pubkey: userDestinationCollateral, isMut: true, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isMut: false, isSigner: false },
    ],
    data,
  });
}

/**
 * redeemReserveCollateral — 9 accounts (devnet version)
 * Args: collateralAmount: u64
 */
function buildRedeemReserveCollateral(
  owner: PublicKey,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  reserve: PublicKey,
  reserveCollateralMint: PublicKey,
  reserveLiquiditySupply: PublicKey,
  userSourceCollateral: PublicKey,
  userDestinationLiquidity: PublicKey,
  collateralAmount: bigint
): TransactionInstruction {
  const data = Buffer.concat([
    DISC_REDEEM_RESERVE_COLLATERAL,
    encodeLittleEndianU64(collateralAmount),
  ]);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isMut: false, isSigner: true },
      { pubkey: lendingMarket, isMut: false, isSigner: false },
      { pubkey: lendingMarketAuthority, isMut: false, isSigner: false },
      { pubkey: reserve, isMut: true, isSigner: false },
      { pubkey: reserveCollateralMint, isMut: true, isSigner: false },
      { pubkey: reserveLiquiditySupply, isMut: true, isSigner: false },
      { pubkey: userSourceCollateral, isMut: true, isSigner: false },
      { pubkey: userDestinationLiquidity, isMut: true, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isMut: false, isSigner: false },
    ],
    data,
  });
}

/**
 * updateReserveConfig — 3 accounts (devnet version, no globalConfig)
 * Args: mode: u64, value: [u8; 952]
 */
function buildUpdateReserveConfig(
  lendingMarketOwner: PublicKey,
  lendingMarket: PublicKey,
  reserve: PublicKey,
  mode: number,
  value: Buffer // will be zero-padded to 952 bytes
): TransactionInstruction {
  // mode: u64
  const modeBuf = encodeLittleEndianU64(mode);
  // value: [u8; 952] — fixed size array, pad with zeros
  const valuePadded = Buffer.alloc(952);
  value.copy(valuePadded);

  const data = Buffer.concat([DISC_UPDATE_RESERVE_CONFIG, modeBuf, valuePadded]);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: lendingMarketOwner, isMut: false, isSigner: true },
      { pubkey: lendingMarket, isMut: false, isSigner: false },
      { pubkey: reserve, isMut: true, isSigner: false },
    ],
    data,
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  klend Devnet Setup — Privacy Yield Protocol Phase 2");
  console.log("  (targeting deployed devnet version of klend)");
  console.log("═══════════════════════════════════════════════════════════\n");

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = loadWallet();
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  // ─── Step 1: Create test USDC mint ───────────────────────────────────

  console.log("── Step 1: Create test USDC mint ──────────────────────────");

  const usdcMint = await createMint(
    connection,
    wallet,
    wallet.publicKey, // mint authority
    null, // freeze authority
    6 // decimals
  );
  console.log(`  ✓ USDC Mint: ${usdcMint.toBase58()}`);

  // Create ATA and mint 1000 USDC
  const userUsdcAta = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    usdcMint,
    wallet.publicKey
  );
  await mintTo(
    connection,
    wallet,
    usdcMint,
    userUsdcAta.address,
    wallet,
    1_000_000_000 // 1000 USDC
  );
  console.log(`  ✓ Minted 1000 USDC to ${userUsdcAta.address.toBase58()}`);

  // ─── Step 2: Create lending market ─────────────────────────────────

  console.log("\n── Step 2: Create lending market ──────────────────────────");

  const lendingMarketKp = Keypair.generate();
  console.log(
    `  Lending market keypair: ${lendingMarketKp.publicKey.toBase58()}`
  );

  // Pre-create the account (#[account(zero)] requires pre-allocation)
  const marketRent =
    await connection.getMinimumBalanceForRentExemption(LENDING_MARKET_SIZE);
  const createMarketAccountIx = SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: lendingMarketKp.publicKey,
    lamports: marketRent,
    space: LENDING_MARKET_SIZE,
    programId: KLEND_PROGRAM_ID,
  });

  const [marketAuthority] = deriveLendingMarketAuthority(
    lendingMarketKp.publicKey
  );

  // quote_currency: "USD\0..." padded to 32 bytes
  const quoteCurrency = Buffer.alloc(32);
  quoteCurrency.write("USD");

  const initMarketIx = buildInitLendingMarket(
    wallet.publicKey,
    lendingMarketKp.publicKey,
    marketAuthority,
    quoteCurrency
  );

  await sendTx(
    connection,
    wallet,
    [createMarketAccountIx, initMarketIx],
    [lendingMarketKp],
    "initLendingMarket"
  );
  console.log(`  ✓ Market Authority: ${marketAuthority.toBase58()}`);

  // ─── Step 3: Create USDC reserve ───────────────────────────────────

  console.log("\n── Step 3: Create USDC reserve ────────────────────────────");

  const reserveKp = Keypair.generate();
  console.log(`  Reserve keypair: ${reserveKp.publicKey.toBase58()}`);

  // Pre-create the reserve account
  const reserveRent =
    await connection.getMinimumBalanceForRentExemption(RESERVE_SIZE);
  const createReserveAccountIx = SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: reserveKp.publicKey,
    lamports: reserveRent,
    space: RESERVE_SIZE,
    programId: KLEND_PROGRAM_ID,
  });

  // Derive reserve PDAs (devnet: seeds use market + mint, NOT reserve key)
  const [reserveLiqSupply] = deriveReserveLiqSupply(
    lendingMarketKp.publicKey,
    usdcMint
  );
  const [feeReceiver] = deriveFeeReceiver(lendingMarketKp.publicKey, usdcMint);
  const [reserveCollMint] = deriveReserveCollMint(
    lendingMarketKp.publicKey,
    usdcMint
  );
  const [reserveCollSupply] = deriveReserveCollSupply(
    lendingMarketKp.publicKey,
    usdcMint
  );

  console.log(`  Reserve Liq Supply: ${reserveLiqSupply.toBase58()}`);
  console.log(`  Fee Receiver: ${feeReceiver.toBase58()}`);
  console.log(`  Collateral Mint (cToken): ${reserveCollMint.toBase58()}`);
  console.log(`  Collateral Supply: ${reserveCollSupply.toBase58()}`);

  const initReserveIx = buildInitReserve(
    wallet.publicKey,
    lendingMarketKp.publicKey,
    marketAuthority,
    reserveKp.publicKey,
    usdcMint,
    reserveLiqSupply,
    feeReceiver,
    reserveCollMint,
    reserveCollSupply
  );

  await sendTx(
    connection,
    wallet,
    [createReserveAccountIx, initReserveIx],
    [reserveKp],
    "initReserve"
  );

  // ─── Step 4: Update reserve config ─────────────────────────────────

  console.log("\n── Step 4: Update reserve config ──────────────────────────");

  // Set deposit limit to 1M USDC
  try {
    const depositLimitValue = encodeLittleEndianU64(1_000_000_000_000n);
    const updateDepositLimitIx = buildUpdateReserveConfig(
      wallet.publicKey,
      lendingMarketKp.publicKey,
      reserveKp.publicKey,
      UPDATE_CONFIG_MODE.UpdateDepositLimit,
      depositLimitValue
    );
    await sendTx(
      connection,
      wallet,
      [updateDepositLimitIx],
      [],
      "updateDepositLimit"
    );
  } catch (e: any) {
    console.log(
      `  ⚠ updateDepositLimit failed: ${e.message?.slice(0, 120)}`
    );
    if (e.logs) {
      for (const log of e.logs.slice(-5)) console.log(`    ${log}`);
    }
  }

  // ─── Step 5: Test deposit ──────────────────────────────────────────

  console.log("\n── Step 5: Test deposit (10 USDC) ─────────────────────────");

  // Create user cToken ATA
  const userCtokenAta = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    reserveCollMint,
    wallet.publicKey
  );
  console.log(`  User cToken ATA: ${userCtokenAta.address.toBase58()}`);

  // Refresh reserve (no oracle — uses saved/default price)
  const refreshIx = buildRefreshReserve(
    reserveKp.publicKey,
    null, // no pyth
    null, // no switchboard price
    null, // no switchboard twap
    null // no scope
  );

  const depositAmount = 10_000_000n; // 10 USDC
  const depositIx = buildDepositReserveLiquidity(
    wallet.publicKey,
    reserveKp.publicKey,
    lendingMarketKp.publicKey,
    marketAuthority,
    reserveLiqSupply,
    reserveCollMint,
    userUsdcAta.address,
    userCtokenAta.address,
    depositAmount
  );

  try {
    await sendTx(
      connection,
      wallet,
      [refreshIx, depositIx],
      [],
      "deposit 10 USDC"
    );

    const ctokenAccount = await getAccount(connection, userCtokenAta.address);
    const usdcAccount = await getAccount(connection, userUsdcAta.address);
    console.log(`  cToken balance: ${ctokenAccount.amount}`);
    console.log(`  USDC balance: ${usdcAccount.amount}`);
  } catch (e: any) {
    console.log(`  ✗ Deposit failed: ${e.message?.slice(0, 200)}`);
    if (e.logs) {
      console.log("  Program logs:");
      for (const log of e.logs.slice(-10)) {
        console.log(`    ${log}`);
      }
    }
  }

  // ─── Step 6: Test redeem ───────────────────────────────────────────

  console.log("\n── Step 6: Test redeem (all cTokens) ──────────────────────");

  try {
    const ctokenAccountBefore = await getAccount(
      connection,
      userCtokenAta.address
    );
    const redeemAmount = ctokenAccountBefore.amount;

    if (redeemAmount === 0n) {
      console.log("  ⓘ No cTokens to redeem (deposit may have failed)");
    } else {
      console.log(`  Redeeming ${redeemAmount} cTokens...`);

      const refreshIx2 = buildRefreshReserve(
        reserveKp.publicKey,
        null,
        null,
        null,
        null
      );

      const redeemIx = buildRedeemReserveCollateral(
        wallet.publicKey,
        lendingMarketKp.publicKey,
        marketAuthority,
        reserveKp.publicKey,
        reserveCollMint,
        reserveLiqSupply,
        userCtokenAta.address,
        userUsdcAta.address,
        redeemAmount
      );

      await sendTx(
        connection,
        wallet,
        [refreshIx2, redeemIx],
        [],
        "redeem cTokens"
      );

      const usdcAccountAfter = await getAccount(
        connection,
        userUsdcAta.address
      );
      const ctokenAccountAfter = await getAccount(
        connection,
        userCtokenAta.address
      );
      console.log(`  USDC balance after redeem: ${usdcAccountAfter.amount}`);
      console.log(
        `  cToken balance after redeem: ${ctokenAccountAfter.amount}`
      );
    }
  } catch (e: any) {
    console.log(`  ✗ Redeem failed: ${e.message?.slice(0, 200)}`);
    if (e.logs) {
      console.log("  Program logs:");
      for (const log of e.logs.slice(-10)) {
        console.log(`    ${log}`);
      }
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Summary — All Addresses");
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  KLEND_PROGRAM_ID        = ${KLEND_PROGRAM_ID.toBase58()}`);
  console.log(
    `  LENDING_MARKET          = ${lendingMarketKp.publicKey.toBase58()}`
  );
  console.log(`  MARKET_AUTHORITY        = ${marketAuthority.toBase58()}`);
  console.log(`  USDC_MINT               = ${usdcMint.toBase58()}`);
  console.log(
    `  RESERVE                 = ${reserveKp.publicKey.toBase58()}`
  );
  console.log(`  RESERVE_LIQ_SUPPLY      = ${reserveLiqSupply.toBase58()}`);
  console.log(`  FEE_RECEIVER            = ${feeReceiver.toBase58()}`);
  console.log(`  CTOKEN_MINT             = ${reserveCollMint.toBase58()}`);
  console.log(`  RESERVE_COLL_SUPPLY     = ${reserveCollSupply.toBase58()}`);
  console.log(`  USER_USDC_ATA           = ${userUsdcAta.address.toBase58()}`);
  console.log(
    `  USER_CTOKEN_ATA         = ${userCtokenAta.address.toBase58()}`
  );
  console.log(
    "\n═══════════════════════════════════════════════════════════\n"
  );

  // Save addresses to file
  const addresses = {
    klendProgramId: KLEND_PROGRAM_ID.toBase58(),
    lendingMarket: lendingMarketKp.publicKey.toBase58(),
    marketAuthority: marketAuthority.toBase58(),
    usdcMint: usdcMint.toBase58(),
    reserve: reserveKp.publicKey.toBase58(),
    reserveLiqSupply: reserveLiqSupply.toBase58(),
    feeReceiver: feeReceiver.toBase58(),
    ctokenMint: reserveCollMint.toBase58(),
    reserveCollSupply: reserveCollSupply.toBase58(),
  };

  const outputPath = path.join(__dirname, "klend-devnet-addresses.json");
  fs.writeFileSync(outputPath, JSON.stringify(addresses, null, 2));
  console.log(`  Addresses saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
