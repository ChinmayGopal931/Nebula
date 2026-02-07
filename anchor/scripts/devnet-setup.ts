/**
 * Devnet Setup Script — idempotent account creation for mock-klend + privacy-yield
 *
 * Creates:
 *   1. Test USDC mint (6 decimals)
 *   2. Mock-klend lending market + reserve
 *   3. Privacy-yield pool (initialize)
 *   4. Privacy-yield klend config (configureKlend)
 *   5. Saves all addresses to devnet_config.json
 *
 * Run: yarn devnet:setup
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PrivacyYield } from "../target/types/privacy_yield";
import { MockKlend } from "../target/types/mock_klend";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createInitializeMintInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const bs58 = anchor.utils.bytes.bs58;

const PRIVACY_YIELD_PROGRAM_ID = new PublicKey(
  "5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw"
);
const MOCK_KLEND_PROGRAM_ID = new PublicKey(
  "CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk"
);

const CONFIG_PATH = path.resolve(__dirname, "../devnet_config.json");

interface DevnetConfig {
  privacyYieldProgram: string;
  mockKlendProgram: string;
  usdcMint: string;
  usdcMintKeypair: string;
  lendingMarket: string;
  lendingMarketKeypair: string;
  reserve: string;
  reserveKeypair: string;
  lendingMarketAuthority: string;
  reserveLiquiditySupply: string;
  reserveCollateralMint: string;
  reserveCollateralSupply: string;
  feeReceiver: string;
  treeAccountPDA: string;
  poolConfigPDA: string;
  klendConfigPDA: string;
  poolVault: string;
  poolCtokenAccount: string;
}

function loadExistingConfig(): Partial<DevnetConfig> | null {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  }
  return null;
}

function saveConfig(config: DevnetConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n  Config saved to ${CONFIG_PATH}`);
}

describe("Devnet Setup", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;

  // Load IDLs manually since anchor.workspace won't have them on devnet
  let privacyYield: Program<PrivacyYield>;
  let mockKlend: Program<MockKlend>;

  // Keypairs — loaded from config or generated fresh
  let usdcMintKp: Keypair;
  let lendingMarketKp: Keypair;
  let reserveKp: Keypair;

  // Derived addresses
  let lendingMarketAuthority: PublicKey;
  let reserveLiquiditySupply: PublicKey;
  let reserveCollateralMint: PublicKey;
  let reserveCollateralSupply: PublicKey;
  let feeReceiver: PublicKey;
  let treeAccountPDA: PublicKey;
  let poolConfigPDA: PublicKey;
  let klendConfigPDA: PublicKey;
  let poolVault: PublicKey;
  let poolCtokenAccount: PublicKey;

  before(async () => {
    // Load programs from IDL files
    const privacyYieldIdl = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../target/idl/privacy_yield.json"),
        "utf-8"
      )
    );
    const mockKlendIdl = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../target/idl/mock_klend.json"),
        "utf-8"
      )
    );

    privacyYield = new Program(
      privacyYieldIdl,
      provider
    ) as unknown as Program<PrivacyYield>;
    mockKlend = new Program(
      mockKlendIdl,
      provider
    ) as unknown as Program<MockKlend>;

    // Load or generate keypairs
    const existing = loadExistingConfig();
    if (existing?.usdcMintKeypair) {
      usdcMintKp = Keypair.fromSecretKey(bs58.decode(existing.usdcMintKeypair));
      console.log("  Loaded USDC mint keypair from config");
    } else {
      usdcMintKp = Keypair.generate();
      console.log("  Generated new USDC mint keypair");
    }

    if (existing?.lendingMarketKeypair) {
      lendingMarketKp = Keypair.fromSecretKey(
        bs58.decode(existing.lendingMarketKeypair)
      );
      console.log("  Loaded lending market keypair from config");
    } else {
      lendingMarketKp = Keypair.generate();
      console.log("  Generated new lending market keypair");
    }

    if (existing?.reserveKeypair) {
      reserveKp = Keypair.fromSecretKey(bs58.decode(existing.reserveKeypair));
      console.log("  Loaded reserve keypair from config");
    } else {
      reserveKp = Keypair.generate();
      console.log("  Generated new reserve keypair");
    }

    // Derive all PDAs
    [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("lma"), lendingMarketKp.publicKey.toBuffer()],
      MOCK_KLEND_PROGRAM_ID
    );
    [reserveLiquiditySupply] = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve_liq_supply"), reserveKp.publicKey.toBuffer()],
      MOCK_KLEND_PROGRAM_ID
    );
    [feeReceiver] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_receiver"), reserveKp.publicKey.toBuffer()],
      MOCK_KLEND_PROGRAM_ID
    );
    [reserveCollateralMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve_coll_mint"), reserveKp.publicKey.toBuffer()],
      MOCK_KLEND_PROGRAM_ID
    );
    [reserveCollateralSupply] = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve_coll_supply"), reserveKp.publicKey.toBuffer()],
      MOCK_KLEND_PROGRAM_ID
    );
    [treeAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree")],
      PRIVACY_YIELD_PROGRAM_ID
    );
    [poolConfigPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_config")],
      PRIVACY_YIELD_PROGRAM_ID
    );
    [klendConfigPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("klend_config")],
      PRIVACY_YIELD_PROGRAM_ID
    );
    poolVault = await getAssociatedTokenAddress(
      usdcMintKp.publicKey,
      poolConfigPDA,
      true
    );
    poolCtokenAccount = await getAssociatedTokenAddress(
      reserveCollateralMint,
      poolConfigPDA,
      true
    );

    console.log("\n  Authority:", authority.publicKey.toBase58());
    console.log("  USDC mint:", usdcMintKp.publicKey.toBase58());
    console.log("  Lending market:", lendingMarketKp.publicKey.toBase58());
    console.log("  Reserve:", reserveKp.publicKey.toBase58());
  });

  it("1. Create test USDC mint", async () => {
    const existing = await connection.getAccountInfo(usdcMintKp.publicKey);
    if (existing) {
      console.log("    USDC mint already exists, skipping");
      return;
    }

    const mintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: usdcMintKp.publicKey,
        space: 82,
        lamports: await connection.getMinimumBalanceForRentExemption(82),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        usdcMintKp.publicKey,
        6,
        authority.publicKey,
        authority.publicKey
      )
    );
    await provider.sendAndConfirm(mintTx, [authority, usdcMintKp]);
    console.log("    USDC mint created:", usdcMintKp.publicKey.toBase58());
  });

  it("2. Init mock-klend lending market", async () => {
    const existing = await connection.getAccountInfo(
      lendingMarketKp.publicKey
    );
    if (existing) {
      console.log("    Lending market already exists, skipping");
      return;
    }

    const quoteCurrency = Buffer.alloc(32);
    Buffer.from("USD").copy(quoteCurrency);

    await mockKlend.methods
      .initLendingMarket([...quoteCurrency] as any)
      .accounts({
        owner: authority.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        systemProgram: SystemProgram.programId,
      })
      .signers([lendingMarketKp])
      .rpc();

    console.log(
      "    Lending market created:",
      lendingMarketKp.publicKey.toBase58()
    );
  });

  it("3. Init mock-klend reserve", async () => {
    const existing = await connection.getAccountInfo(reserveKp.publicKey);
    if (existing) {
      console.log("    Reserve already exists, skipping");
      return;
    }

    await mockKlend.methods
      .initReserve()
      .accounts({
        owner: authority.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserve: reserveKp.publicKey,
        liquidityMint: usdcMintKp.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        feeReceiver: feeReceiver,
        reserveCollateralMint: reserveCollateralMint,
        reserveCollateralSupply: reserveCollateralSupply,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([reserveKp])
      .rpc();

    console.log("    Reserve created:", reserveKp.publicKey.toBase58());
  });

  it("4. Initialize privacy-yield pool", async () => {
    const existing = await connection.getAccountInfo(poolConfigPDA);
    if (existing) {
      console.log("    Pool already initialized, skipping");
      return;
    }

    await privacyYield.methods
      .initialize()
      .accounts({
        treeAccount: treeAccountPDA,
        poolConfig: poolConfigPDA,
        usdcMint: usdcMintKp.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("    Pool initialized");
  });

  it("5. Configure klend on privacy-yield", async () => {
    const existing = await connection.getAccountInfo(klendConfigPDA);
    if (existing) {
      console.log("    Klend config already exists, skipping");
      return;
    }

    await privacyYield.methods
      .configureKlend()
      .accounts({
        poolConfig: poolConfigPDA,
        klendConfig: klendConfigPDA,
        collateralMint: reserveCollateralMint,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        lendingMarket: lendingMarketKp.publicKey,
        reserve: reserveKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquiditySupply: reserveLiquiditySupply,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("    Klend configured");
  });

  it("6. Save config", async () => {
    const config: DevnetConfig = {
      privacyYieldProgram: PRIVACY_YIELD_PROGRAM_ID.toBase58(),
      mockKlendProgram: MOCK_KLEND_PROGRAM_ID.toBase58(),
      usdcMint: usdcMintKp.publicKey.toBase58(),
      usdcMintKeypair: bs58.encode(usdcMintKp.secretKey),
      lendingMarket: lendingMarketKp.publicKey.toBase58(),
      lendingMarketKeypair: bs58.encode(lendingMarketKp.secretKey),
      reserve: reserveKp.publicKey.toBase58(),
      reserveKeypair: bs58.encode(reserveKp.secretKey),
      lendingMarketAuthority: lendingMarketAuthority.toBase58(),
      reserveLiquiditySupply: reserveLiquiditySupply.toBase58(),
      reserveCollateralMint: reserveCollateralMint.toBase58(),
      reserveCollateralSupply: reserveCollateralSupply.toBase58(),
      feeReceiver: feeReceiver.toBase58(),
      treeAccountPDA: treeAccountPDA.toBase58(),
      poolConfigPDA: poolConfigPDA.toBase58(),
      klendConfigPDA: klendConfigPDA.toBase58(),
      poolVault: poolVault.toBase58(),
      poolCtokenAccount: poolCtokenAccount.toBase58(),
    };

    saveConfig(config);

    // Verify saved config is loadable
    const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    console.log("    Config verified — %d keys", Object.keys(loaded).length);
  });
});
