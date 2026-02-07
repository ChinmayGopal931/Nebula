import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PrivacyYield } from "../target/types/privacy_yield";
import { MockKlend } from "../target/types/mock_klend";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Keypair,
  ComputeBudgetProgram,
  AddressLookupTableProgram,
  Transaction,
  sendAndConfirmTransaction,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import * as path from "path";
import BN from "bn.js";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";

import {
  DEFAULT_HEIGHT,
  FIELD_SIZE,
  ROOT_HISTORY_SIZE,
  ZERO_BYTES,
} from "./lib/constants";
import { Utxo } from "./lib/utxo";
import { Keypair as ZKKeypair } from "./lib/keypair";
import { MerkleTree } from "./lib/merkle_tree";
import {
  parseProofToBytesArray,
  parseToBytesArray,
  prove,
} from "./lib/prover";
import {
  bnToBytes,
  getExtDataHash,
  getMintAddressField,
  findNullifierPDAs,
  findCrossCheckNullifierPDAs,
  getProgramPDAs,
} from "./lib/utils";

// ==================== Program IDs ====================

const MOCK_KLEND_PROGRAM_ID = new PublicKey(
  "CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk"
);

// ==================== ALT Helpers ====================

let globalTestALT: PublicKey | null = null;

async function createGlobalTestALT(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> {
  if (globalTestALT) return globalTestALT;

  const recentSlot = await connection.getSlot("confirmed");
  const [lookupTableInst, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });

  const createALTTx = new Transaction().add(lookupTableInst);
  await sendAndConfirmTransaction(connection, createALTTx, [payer]);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const chunkSize = 20;
  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    const extendInstruction = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: chunk,
    });
    const extendTx = new Transaction().add(extendInstruction);
    await sendAndConfirmTransaction(connection, extendTx, [payer]);
    if (i + chunkSize < addresses.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  globalTestALT = lookupTableAddress;
  return lookupTableAddress;
}

async function createVersionedTransactionWithALT(
  connection: anchor.web3.Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  altAddress: PublicKey
): Promise<VersionedTransaction> {
  const lookupTableAccount =
    await connection.getAddressLookupTable(altAddress);
  if (!lookupTableAccount.value)
    throw new Error(`ALT not found: ${altAddress.toString()}`);

  const recentBlockhash = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: recentBlockhash.blockhash,
    instructions,
  }).compileToV0Message([lookupTableAccount.value]);

  return new VersionedTransaction(messageV0);
}

async function sendAndConfirmVersionedTransaction(
  connection: anchor.web3.Connection,
  transaction: VersionedTransaction,
  signers: anchor.web3.Keypair[]
): Promise<string> {
  transaction.sign(signers);
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const latestBlockHash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    blockhash: latestBlockHash.blockhash,
    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
    signature,
  });
  return signature;
}

// ==================== Proof Builder ====================

async function buildProofInput(params: {
  inputs: Utxo[];
  outputs: Utxo[];
  tree: MerkleTree;
  extAmount: BN;
  fee: BN;
  recipient: PublicKey;
  feeRecipient: PublicKey;
  mintAddress: PublicKey;
  encryptedOutput1: Buffer;
  encryptedOutput2: Buffer;
  keyBasePath: string;
}) {
  const {
    inputs,
    outputs,
    tree,
    extAmount,
    fee,
    recipient,
    feeRecipient,
    mintAddress,
    encryptedOutput1,
    encryptedOutput2,
    keyBasePath,
  } = params;

  const mintAddressField = getMintAddressField(mintAddress);

  const inputMerklePathIndices: number[] = [];
  const inputMerklePathElements: any[] = [];

  for (const input of inputs) {
    if (input.amount.gt(new BN(0))) {
      const commitment = await input.getCommitment();
      const idx = tree.indexOf(commitment);
      if (idx < 0) throw new Error(`Input commitment not found in tree`);
      input.index = idx;
      inputMerklePathIndices.push(idx);
      inputMerklePathElements.push(tree.path(idx).pathElements);
    } else {
      inputMerklePathIndices.push(0);
      inputMerklePathElements.push(new Array(tree.levels).fill(0));
    }
  }

  const inputNullifiers = await Promise.all(
    inputs.map((x) => x.getNullifier())
  );
  const outputCommitments = await Promise.all(
    outputs.map((x) => x.getCommitment())
  );

  const root = tree.root();

  const extData = {
    recipient,
    extAmount,
    encryptedOutput1,
    encryptedOutput2,
    fee,
    feeRecipient,
    mintAddress,
  };

  const calculatedExtDataHash = getExtDataHash(extData);
  const publicAmount = extAmount;

  const circuitInput = {
    root,
    publicAmount: publicAmount.toString(),
    extDataHash: calculatedExtDataHash,
    mintAddress: mintAddressField,
    inputNullifier: inputNullifiers,
    inAmount: inputs.map((x) => x.amount.toString(10)),
    inPrivateKey: inputs.map((x) => x.keypair.privkey),
    inBlinding: inputs.map((x) => x.blinding.toString(10)),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,
    outputCommitment: outputCommitments,
    outAmount: outputs.map((x) => x.amount.toString(10)),
    outBlinding: outputs.map((x) => x.blinding.toString(10)),
    outPubkey: outputs.map((x) => x.keypair.pubkey),
  };

  const { proof, publicSignals } = await prove(circuitInput, keyBasePath);

  const proofInBytes = parseProofToBytesArray(proof);
  const inputsInBytes = parseToBytesArray(publicSignals);

  const proofToSubmit = {
    proofA: proofInBytes.proofA,
    proofB: proofInBytes.proofB.flat(),
    proofC: proofInBytes.proofC,
    root: inputsInBytes[0],
    publicAmount: inputsInBytes[1],
    extDataHash: inputsInBytes[2],
    inputNullifiers: [inputsInBytes[3], inputsInBytes[4]],
    outputCommitments: [inputsInBytes[5], inputsInBytes[6]],
  };

  return { proofToSubmit, extData, outputCommitments };
}

// ==================== Tests ====================

describe("Phase 2: Klend Integration (localnet with mock-klend)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PrivacyYield as Program<PrivacyYield>;
  const mockKlend = anchor.workspace.MockKlend as Program<MockKlend>;

  let lightWasm: LightWasm;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const connection = provider.connection;

  // Privacy-yield PDAs
  let treeAccountPDA: PublicKey;
  let poolConfigPDA: PublicKey;
  const [klendConfigPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("klend_config")],
    new PublicKey("5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw")
  );

  // Token
  let usdcMint: anchor.web3.Keypair;
  let mintAddressBase58: string;

  // User accounts
  let user: anchor.web3.Keypair;
  let recipient: anchor.web3.Keypair;
  let userTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;

  // Pool accounts
  let poolVault: PublicKey;
  let poolCtokenAccount: PublicKey;

  // Klend accounts
  let lendingMarketKp: anchor.web3.Keypair;
  let reserveKp: anchor.web3.Keypair;
  let lendingMarketAuthority: PublicKey;
  let reserveLiquiditySupply: PublicKey;
  let feeReceiver: PublicKey;
  let reserveCollateralMint: PublicKey;
  let reserveCollateralSupply: PublicKey;

  // ZK state
  let merkleTree: MerkleTree;
  let sharedKeypair: ZKKeypair;
  let lookupTableAddress: PublicKey;
  let keyBasePath: string;

  // Track UTXOs
  let depositUtxo: Utxo;

  before(async () => {
    lightWasm = await WasmFactory.getInstance();
    merkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
    keyBasePath = path.resolve(__dirname, "../../artifacts/transaction2");
    sharedKeypair = ZKKeypair.generateNew(lightWasm);

    // Generate accounts
    user = anchor.web3.Keypair.generate();
    recipient = anchor.web3.Keypair.generate();
    usdcMint = anchor.web3.Keypair.generate();
    lendingMarketKp = anchor.web3.Keypair.generate();
    reserveKp = anchor.web3.Keypair.generate();

    // Airdrop SOL
    for (const kp of [authority, user, recipient]) {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        100 * LAMPORTS_PER_SOL
      );
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
        signature: sig,
      });
    }

    // ==================== 1. Create USDC mint ====================
    const mintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: usdcMint.publicKey,
        space: 82,
        lamports: await connection.getMinimumBalanceForRentExemption(82),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        usdcMint.publicKey,
        6,
        authority.publicKey,
        authority.publicKey
      )
    );
    await provider.sendAndConfirm(mintTx, [authority, usdcMint]);
    mintAddressBase58 = usdcMint.publicKey.toBase58();

    // Create user + recipient token accounts
    userTokenAccount = await getAssociatedTokenAddress(
      usdcMint.publicKey,
      user.publicKey
    );
    recipientTokenAccount = await getAssociatedTokenAddress(
      usdcMint.publicKey,
      recipient.publicKey
    );

    const createAtasTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        userTokenAccount,
        user.publicKey,
        usdcMint.publicKey
      ),
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        recipientTokenAccount,
        recipient.publicKey,
        usdcMint.publicKey
      )
    );
    await provider.sendAndConfirm(createAtasTx, [authority]);

    // Mint USDC to user
    const mintToUserTx = new Transaction().add(
      createMintToInstruction(
        usdcMint.publicKey,
        userTokenAccount,
        authority.publicKey,
        100_000_000 // 100 USDC
      )
    );
    await provider.sendAndConfirm(mintToUserTx, [authority]);

    // ==================== 2. Initialize privacy-yield ====================
    const pdas = getProgramPDAs(program.programId);
    treeAccountPDA = pdas.treeAccountPDA;
    poolConfigPDA = pdas.poolConfigPDA;

    await program.methods
      .initialize()
      .accounts({
        treeAccount: treeAccountPDA,
        poolConfig: poolConfigPDA,
        usdcMint: usdcMint.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    poolVault = await getAssociatedTokenAddress(
      usdcMint.publicKey,
      poolConfigPDA,
      true
    );

    // ==================== 3. Initialize mock-klend ====================
    // Derive mock-klend PDAs
    [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("lma"), lendingMarketKp.publicKey.toBuffer()],
      MOCK_KLEND_PROGRAM_ID
    );
    [reserveLiquiditySupply] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("reserve_liq_supply"),
        reserveKp.publicKey.toBuffer(),
      ],
      MOCK_KLEND_PROGRAM_ID
    );
    [feeReceiver] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_receiver"), reserveKp.publicKey.toBuffer()],
      MOCK_KLEND_PROGRAM_ID
    );
    [reserveCollateralMint] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("reserve_coll_mint"),
        reserveKp.publicKey.toBuffer(),
      ],
      MOCK_KLEND_PROGRAM_ID
    );
    [reserveCollateralSupply] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("reserve_coll_supply"),
        reserveKp.publicKey.toBuffer(),
      ],
      MOCK_KLEND_PROGRAM_ID
    );

    // 3a. Init Lending Market
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

    // 3b. Init Reserve
    await mockKlend.methods
      .initReserve()
      .accounts({
        owner: authority.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserve: reserveKp.publicKey,
        liquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        feeReceiver: feeReceiver,
        reserveCollateralMint: reserveCollateralMint,
        reserveCollateralSupply: reserveCollateralSupply,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([reserveKp])
      .rpc();

    console.log("    Mock klend initialized: market=%s, reserve=%s",
      lendingMarketKp.publicKey.toBase58().slice(0, 8),
      reserveKp.publicKey.toBase58().slice(0, 8)
    );

    // ==================== 4. Create ALT ====================
    poolCtokenAccount = await getAssociatedTokenAddress(
      reserveCollateralMint,
      poolConfigPDA,
      true
    );

    const altAddresses = [
      program.programId,
      treeAccountPDA,
      poolConfigPDA,
      poolVault,
      usdcMint.publicKey,
      SystemProgram.programId,
      ComputeBudgetProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      // Klend addresses
      klendConfigPDA,
      poolCtokenAccount,
      MOCK_KLEND_PROGRAM_ID,
      reserveKp.publicKey,
      lendingMarketKp.publicKey,
      lendingMarketAuthority,
      reserveLiquiditySupply,
      reserveCollateralMint,
      SYSVAR_INSTRUCTIONS_PUBKEY,
    ];

    lookupTableAddress = await createGlobalTestALT(
      connection,
      authority,
      altAddresses
    );

    console.log("    Setup complete. ALT: %s", lookupTableAddress.toBase58().slice(0, 8));
  });

  // =====================================================
  // Test 1: configure_klend stores addresses, creates cToken ATA
  // =====================================================
  it("1. configure_klend — stores addresses and creates cToken ATA", async () => {
    const tx = await program.methods
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

    console.log("    configure_klend tx:", tx.slice(0, 16));

    const config = await program.account.klendConfig.fetch(klendConfigPDA);
    expect(config.klendProgram.toBase58()).to.equal(
      MOCK_KLEND_PROGRAM_ID.toBase58()
    );
    expect(config.reserve.toBase58()).to.equal(
      reserveKp.publicKey.toBase58()
    );
    expect(config.lendingMarket.toBase58()).to.equal(
      lendingMarketKp.publicKey.toBase58()
    );
    expect(config.reserveCollateralMint.toBase58()).to.equal(
      reserveCollateralMint.toBase58()
    );

    const ctokenAta = await getAccount(connection, poolCtokenAccount);
    expect(ctokenAta.mint.toBase58()).to.equal(
      reserveCollateralMint.toBase58()
    );
    expect(ctokenAta.owner.toBase58()).to.equal(poolConfigPDA.toBase58());
  });

  // =====================================================
  // Test 2: configure_klend second call fails
  // =====================================================
  it("2. configure_klend — second call fails (PDA already exists)", async () => {
    try {
      await program.methods
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
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.contain("already in use");
    }
  });

  // =====================================================
  // Test 3: kamino_deposit — deposits all vault USDC
  // =====================================================
  it("3. kamino_deposit — deposits all vault USDC, receives cTokens", async () => {
    // Mint USDC directly to pool vault for testing
    const createVaultIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      poolVault,
      poolConfigPDA,
      usdcMint.publicKey
    );
    const mintToVaultIx = createMintToInstruction(
      usdcMint.publicKey,
      poolVault,
      authority.publicKey,
      10_000_000 // 10 USDC
    );
    const setupTx = new Transaction().add(createVaultIx, mintToVaultIx);
    await provider.sendAndConfirm(setupTx, [authority]);

    const vaultBefore = await getAccount(connection, poolVault);
    const ctokenBefore = await getAccount(connection, poolCtokenAccount);

    expect(Number(vaultBefore.amount)).to.equal(10_000_000);

    const tx = await program.methods
      .kaminoDeposit()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: authority.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    console.log("    kamino_deposit tx:", tx.slice(0, 16));

    const vaultAfter = await getAccount(connection, poolVault);
    const ctokenAfter = await getAccount(connection, poolCtokenAccount);

    // Vault should be empty (deposited ALL)
    expect(Number(vaultAfter.amount)).to.equal(0);

    // cTokens received (1:1 with mock)
    expect(Number(ctokenAfter.amount)).to.be.greaterThan(
      Number(ctokenBefore.amount)
    );
    expect(Number(ctokenAfter.amount) - Number(ctokenBefore.amount)).to.equal(10_000_000);
    console.log(
      "    cTokens received:",
      Number(ctokenAfter.amount) - Number(ctokenBefore.amount)
    );
  });

  // =====================================================
  // Test 4: kamino_redeem — redeems all cTokens
  // =====================================================
  it("4. kamino_redeem — redeems all cTokens, receives USDC", async () => {
    const ctokenBefore = await getAccount(connection, poolCtokenAccount);
    expect(Number(ctokenBefore.amount)).to.be.greaterThan(0);

    const tx = await program.methods
      .kaminoRedeem()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: authority.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    console.log("    kamino_redeem tx:", tx.slice(0, 16));

    const ctokenAfter = await getAccount(connection, poolCtokenAccount);
    const vaultAfter = await getAccount(connection, poolVault);

    expect(Number(ctokenAfter.amount)).to.equal(0);
    expect(Number(vaultAfter.amount)).to.equal(10_000_000);
    console.log("    USDC restored:", Number(vaultAfter.amount));
  });

  // =====================================================
  // Test 5: kamino_deposit no-op when vault is empty
  // =====================================================
  it("5. kamino_deposit — no-op when vault is empty", async () => {
    // Deposit all vault USDC first
    const vaultInfo = await getAccount(connection, poolVault);
    if (Number(vaultInfo.amount) > 0) {
      await program.methods
        .kaminoDeposit()
        .accounts({
          klendConfig: klendConfigPDA,
          poolConfig: poolConfigPDA,
          signer: authority.publicKey,
          poolVault: poolVault,
          poolCtokenAccount: poolCtokenAccount,
          klendProgram: MOCK_KLEND_PROGRAM_ID,
          reserve: reserveKp.publicKey,
          lendingMarket: lendingMarketKp.publicKey,
          lendingMarketAuthority: lendingMarketAuthority,
          reserveLiquidityMint: usdcMint.publicKey,
          reserveLiquiditySupply: reserveLiquiditySupply,
          reserveCollateralMint: reserveCollateralMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
    }

    // Now vault is empty, this should succeed as no-op
    const vaultBefore = await getAccount(connection, poolVault);
    expect(Number(vaultBefore.amount)).to.equal(0);

    const tx = await program.methods
      .kaminoDeposit()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: authority.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    console.log("    kamino_deposit no-op tx:", tx.slice(0, 16));
    // Success means no error thrown
  });

  // =====================================================
  // Test 6: kamino_redeem no-op when cTokens are zero
  // =====================================================
  it("6. kamino_redeem — no-op when cTokens are zero", async () => {
    // Redeem any remaining cTokens
    const ctokenInfo = await getAccount(connection, poolCtokenAccount);
    if (Number(ctokenInfo.amount) > 0) {
      await program.methods
        .kaminoRedeem()
        .accounts({
          klendConfig: klendConfigPDA,
          poolConfig: poolConfigPDA,
          signer: authority.publicKey,
          poolVault: poolVault,
          poolCtokenAccount: poolCtokenAccount,
          klendProgram: MOCK_KLEND_PROGRAM_ID,
          reserve: reserveKp.publicKey,
          lendingMarket: lendingMarketKp.publicKey,
          lendingMarketAuthority: lendingMarketAuthority,
          reserveLiquidityMint: usdcMint.publicKey,
          reserveLiquiditySupply: reserveLiquiditySupply,
          reserveCollateralMint: reserveCollateralMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
    }

    const ctokenBefore = await getAccount(connection, poolCtokenAccount);
    expect(Number(ctokenBefore.amount)).to.equal(0);

    const tx = await program.methods
      .kaminoRedeem()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: authority.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    console.log("    kamino_redeem no-op tx:", tx.slice(0, 16));
  });

  // =====================================================
  // Test 7: Permissionless — random keypair can call
  // =====================================================
  it("7. permissionless — random keypair calls kamino_deposit/redeem", async () => {
    // Mint some USDC to vault for deposit test
    const mintToVaultIx = createMintToInstruction(
      usdcMint.publicKey,
      poolVault,
      authority.publicKey,
      5_000_000 // 5 USDC
    );
    await provider.sendAndConfirm(
      new Transaction().add(mintToVaultIx),
      [authority]
    );

    // Random signer (not authority)
    const randomSigner = anchor.web3.Keypair.generate();
    const airdropSig = await connection.requestAirdrop(
      randomSigner.publicKey,
      1 * LAMPORTS_PER_SOL
    );
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
      signature: airdropSig,
    });

    // Random signer calls kamino_deposit
    await program.methods
      .kaminoDeposit()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: randomSigner.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([randomSigner])
      .rpc();

    console.log("    permissionless kamino_deposit succeeded");

    // Verify deposit worked
    const vaultAfterDeposit = await getAccount(connection, poolVault);
    expect(Number(vaultAfterDeposit.amount)).to.equal(0);

    // Random signer calls kamino_redeem
    await program.methods
      .kaminoRedeem()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: randomSigner.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([randomSigner])
      .rpc();

    console.log("    permissionless kamino_redeem succeeded");
  });

  // =====================================================
  // Test 8: Bundled deposit — transact(deposit) + kamino_deposit
  // =====================================================
  it("8. bundled deposit — transact + kamino_deposit in one tx", async () => {
    // Clean state: redeem any remaining cTokens first
    const ctokenInfo = await getAccount(connection, poolCtokenAccount);
    if (Number(ctokenInfo.amount) > 0) {
      await program.methods
        .kaminoRedeem()
        .accounts({
          klendConfig: klendConfigPDA,
          poolConfig: poolConfigPDA,
          signer: authority.publicKey,
          poolVault: poolVault,
          poolCtokenAccount: poolCtokenAccount,
          klendProgram: MOCK_KLEND_PROGRAM_ID,
          reserve: reserveKp.publicKey,
          lendingMarket: lendingMarketKp.publicKey,
          lendingMarketAuthority: lendingMarketAuthority,
          reserveLiquidityMint: usdcMint.publicKey,
          reserveLiquiditySupply: reserveLiquiditySupply,
          reserveCollateralMint: reserveCollateralMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
    }
    // Drain vault to start clean
    const vaultInfo = await getAccount(connection, poolVault);
    if (Number(vaultInfo.amount) > 0) {
      await program.methods
        .kaminoDeposit()
        .accounts({
          klendConfig: klendConfigPDA,
          poolConfig: poolConfigPDA,
          signer: authority.publicKey,
          poolVault: poolVault,
          poolCtokenAccount: poolCtokenAccount,
          klendProgram: MOCK_KLEND_PROGRAM_ID,
          reserve: reserveKp.publicKey,
          lendingMarket: lendingMarketKp.publicKey,
          lendingMarketAuthority: lendingMarketAuthority,
          reserveLiquidityMint: usdcMint.publicKey,
          reserveLiquiditySupply: reserveLiquiditySupply,
          reserveCollateralMint: reserveCollateralMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
    }

    const depositAmount = 1_000_000; // 1 USDC
    const ctokenBeforeBundle = await getAccount(connection, poolCtokenAccount);

    // Build ZK proof for deposit
    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const outputs = [
      new Utxo({
        lightWasm,
        amount: depositAmount,
        keypair: sharedKeypair,
        index: merkleTree._layers[0].length,
        mintAddress: mintAddressBase58,
      }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const encryptedOutput1 = Buffer.from("bundle_deposit_enc1");
    const encryptedOutput2 = Buffer.from("bundle_deposit_enc2");

    const { proofToSubmit, extData, outputCommitments } =
      await buildProofInput({
        inputs,
        outputs,
        tree: merkleTree,
        extAmount: new BN(depositAmount),
        fee: new BN(0),
        recipient: recipientTokenAccount,
        feeRecipient: user.publicKey,
        mintAddress: usdcMint.publicKey,
        encryptedOutput1,
        encryptedOutput2,
        keyBasePath,
      });

    // Build transact instruction
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(
      program.programId,
      proofToSubmit
    );
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(
      program.programId,
      proofToSubmit
    );

    const extDataMinified = {
      extAmount: extData.extAmount,
      fee: extData.fee,
    };

    const transactTx = await program.methods
      .transact(
        proofToSubmit,
        extDataMinified,
        extData.encryptedOutput1,
        extData.encryptedOutput2
      )
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: nullifier2PDA,
        nullifier3: nullifier3PDA,
        poolConfig: poolConfigPDA,
        signer: user.publicKey,
        mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        poolVault: poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    // Build kamino_deposit instruction
    const kaminoDepositTx = await program.methods
      .kaminoDeposit()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: user.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .transaction();

    // Bundle: computeBudget + transact + kamino_deposit
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });

    const allInstructions = [
      computeBudgetIx,
      ...transactTx.instructions,
      ...kaminoDepositTx.instructions,
    ];

    const versionedTx = await createVersionedTransactionWithALT(
      connection,
      user.publicKey,
      allInstructions,
      lookupTableAddress
    );

    const txSig = await sendAndConfirmVersionedTransaction(
      connection,
      versionedTx,
      [user]
    );
    console.log("    bundled deposit tx:", txSig.slice(0, 16));

    // Update local tree
    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }
    depositUtxo = outputs[0];

    // Verify: vault should be zero (deposited to mock-klend)
    const vaultAfter = await getAccount(connection, poolVault);
    expect(Number(vaultAfter.amount)).to.equal(0);

    // cTokens should have increased (1:1 with mock)
    const ctokenAfter = await getAccount(connection, poolCtokenAccount);
    expect(Number(ctokenAfter.amount)).to.be.greaterThan(
      Number(ctokenBeforeBundle.amount)
    );
    console.log("    vault after:", Number(vaultAfter.amount));
    console.log("    cTokens after:", Number(ctokenAfter.amount));
  });

  // =====================================================
  // Test 9: Bundled withdrawal — kamino_redeem + transact(withdraw)
  // =====================================================
  it("9. bundled withdrawal — kamino_redeem + transact in one tx", async () => {
    const withdrawAmount = 500_000; // 0.5 USDC
    const recipientBalanceBefore = Number(
      (await connection.getTokenAccountBalance(recipientTokenAccount)).value
        .amount
    );

    // Build ZK proof for partial withdrawal
    const changeAmount = depositUtxo.amount.toNumber() - withdrawAmount;
    const inputs = [
      depositUtxo,
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const outputs = [
      new Utxo({
        lightWasm,
        amount: changeAmount,
        keypair: sharedKeypair,
        index: merkleTree._layers[0].length,
        mintAddress: mintAddressBase58,
      }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const encryptedOutput1 = Buffer.from("bundle_withdraw_enc1");
    const encryptedOutput2 = Buffer.from("bundle_withdraw_enc2");

    const { proofToSubmit, extData, outputCommitments } =
      await buildProofInput({
        inputs,
        outputs,
        tree: merkleTree,
        extAmount: new BN(-withdrawAmount),
        fee: new BN(0),
        recipient: recipientTokenAccount,
        feeRecipient: user.publicKey,
        mintAddress: usdcMint.publicKey,
        encryptedOutput1,
        encryptedOutput2,
        keyBasePath,
      });

    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(
      program.programId,
      proofToSubmit
    );
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(
      program.programId,
      proofToSubmit
    );

    const extDataMinified = {
      extAmount: extData.extAmount,
      fee: extData.fee,
    };

    // Build kamino_redeem instruction
    const kaminoRedeemTx = await program.methods
      .kaminoRedeem()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: user.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .transaction();

    // Build transact instruction
    const transactTx = await program.methods
      .transact(
        proofToSubmit,
        extDataMinified,
        extData.encryptedOutput1,
        extData.encryptedOutput2
      )
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: nullifier2PDA,
        nullifier3: nullifier3PDA,
        poolConfig: poolConfigPDA,
        signer: user.publicKey,
        mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        poolVault: poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    // Bundle: computeBudget + kamino_redeem + transact
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });

    const allInstructions = [
      computeBudgetIx,
      ...kaminoRedeemTx.instructions,
      ...transactTx.instructions,
    ];

    const versionedTx = await createVersionedTransactionWithALT(
      connection,
      user.publicKey,
      allInstructions,
      lookupTableAddress
    );

    const txSig = await sendAndConfirmVersionedTransaction(
      connection,
      versionedTx,
      [user]
    );
    console.log("    bundled withdrawal tx:", txSig.slice(0, 16));

    // Update local tree
    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }

    // Verify: recipient received USDC
    const recipientBalanceAfter = Number(
      (await connection.getTokenAccountBalance(recipientTokenAccount)).value
        .amount
    );
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(
      withdrawAmount
    );

    // cTokens should be zero (fully redeemed)
    const ctokenAfter = await getAccount(connection, poolCtokenAccount);
    expect(Number(ctokenAfter.amount)).to.equal(0);

    console.log(
      "    recipient received:",
      recipientBalanceAfter - recipientBalanceBefore
    );
    console.log("    vault remaining:", Number((await getAccount(connection, poolVault)).amount));
  });

  // =====================================================
  // Test 10: Round-trip — deposit bundle → withdrawal bundle
  // =====================================================
  it("10. round-trip — deposit bundle then withdrawal bundle", async () => {
    const depositAmount = 2_000_000; // 2 USDC
    const userBalanceBefore = Number(
      (await connection.getTokenAccountBalance(userTokenAccount)).value.amount
    );
    const recipientBalanceBefore = Number(
      (await connection.getTokenAccountBalance(recipientTokenAccount)).value
        .amount
    );

    // === Deposit Bundle ===
    const depInputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const depOutputs = [
      new Utxo({
        lightWasm,
        amount: depositAmount,
        keypair: sharedKeypair,
        index: merkleTree._layers[0].length,
        mintAddress: mintAddressBase58,
      }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const depEnc1 = Buffer.from("roundtrip_dep_enc1");
    const depEnc2 = Buffer.from("roundtrip_dep_enc2");

    const depResult = await buildProofInput({
      inputs: depInputs,
      outputs: depOutputs,
      tree: merkleTree,
      extAmount: new BN(depositAmount),
      fee: new BN(0),
      recipient: recipientTokenAccount,
      feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: depEnc1,
      encryptedOutput2: depEnc2,
      keyBasePath,
    });

    const depNullifiers = findNullifierPDAs(
      program.programId,
      depResult.proofToSubmit
    );
    const depCrossNullifiers = findCrossCheckNullifierPDAs(
      program.programId,
      depResult.proofToSubmit
    );

    const depTransactTx = await program.methods
      .transact(
        depResult.proofToSubmit,
        { extAmount: depResult.extData.extAmount, fee: depResult.extData.fee },
        depResult.extData.encryptedOutput1,
        depResult.extData.encryptedOutput2
      )
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: depNullifiers.nullifier0PDA,
        nullifier1: depNullifiers.nullifier1PDA,
        nullifier2: depCrossNullifiers.nullifier2PDA,
        nullifier3: depCrossNullifiers.nullifier3PDA,
        poolConfig: poolConfigPDA,
        signer: user.publicKey,
        mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        poolVault: poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    const depKaminoTx = await program.methods
      .kaminoDeposit()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: user.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .transaction();

    const depVtx = await createVersionedTransactionWithALT(
      connection,
      user.publicKey,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        ...depTransactTx.instructions,
        ...depKaminoTx.instructions,
      ],
      lookupTableAddress
    );
    await sendAndConfirmVersionedTransaction(connection, depVtx, [user]);

    for (const c of depResult.outputCommitments) {
      merkleTree.insert(c);
    }
    const roundTripUtxo = depOutputs[0];

    // Verify deposit: user balance decreased, cTokens increased
    const userBalanceAfterDeposit = Number(
      (await connection.getTokenAccountBalance(userTokenAccount)).value.amount
    );
    expect(userBalanceBefore - userBalanceAfterDeposit).to.equal(depositAmount);

    const ctokenAfterDeposit = await getAccount(connection, poolCtokenAccount);
    expect(Number(ctokenAfterDeposit.amount)).to.be.greaterThan(0);
    console.log(
      "    after deposit: user spent %d, cTokens=%d",
      depositAmount,
      Number(ctokenAfterDeposit.amount)
    );

    // === Withdrawal Bundle (full) ===
    const wdInputs = [
      roundTripUtxo,
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const wdOutputs = [
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const wdEnc1 = Buffer.from("roundtrip_wd_enc1");
    const wdEnc2 = Buffer.from("roundtrip_wd_enc2");

    const wdResult = await buildProofInput({
      inputs: wdInputs,
      outputs: wdOutputs,
      tree: merkleTree,
      extAmount: new BN(-depositAmount),
      fee: new BN(0),
      recipient: recipientTokenAccount,
      feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: wdEnc1,
      encryptedOutput2: wdEnc2,
      keyBasePath,
    });

    const wdNullifiers = findNullifierPDAs(
      program.programId,
      wdResult.proofToSubmit
    );
    const wdCrossNullifiers = findCrossCheckNullifierPDAs(
      program.programId,
      wdResult.proofToSubmit
    );

    const wdKaminoTx = await program.methods
      .kaminoRedeem()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: user.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserveKp.publicKey,
        lendingMarket: lendingMarketKp.publicKey,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint.publicKey,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .transaction();

    const wdTransactTx = await program.methods
      .transact(
        wdResult.proofToSubmit,
        { extAmount: wdResult.extData.extAmount, fee: wdResult.extData.fee },
        wdResult.extData.encryptedOutput1,
        wdResult.extData.encryptedOutput2
      )
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: wdNullifiers.nullifier0PDA,
        nullifier1: wdNullifiers.nullifier1PDA,
        nullifier2: wdCrossNullifiers.nullifier2PDA,
        nullifier3: wdCrossNullifiers.nullifier3PDA,
        poolConfig: poolConfigPDA,
        signer: user.publicKey,
        mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        poolVault: poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    const wdVtx = await createVersionedTransactionWithALT(
      connection,
      user.publicKey,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        ...wdKaminoTx.instructions,
        ...wdTransactTx.instructions,
      ],
      lookupTableAddress
    );
    await sendAndConfirmVersionedTransaction(connection, wdVtx, [user]);

    for (const c of wdResult.outputCommitments) {
      merkleTree.insert(c);
    }

    // Verify: recipient received the full amount
    const recipientBalanceAfter = Number(
      (await connection.getTokenAccountBalance(recipientTokenAccount)).value
        .amount
    );
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(
      depositAmount
    );

    // cTokens should be zero
    const ctokenFinal = await getAccount(connection, poolCtokenAccount);
    expect(Number(ctokenFinal.amount)).to.equal(0);

    console.log(
      "    round-trip complete: recipient received %d USDC",
      recipientBalanceAfter - recipientBalanceBefore
    );
  });
});
