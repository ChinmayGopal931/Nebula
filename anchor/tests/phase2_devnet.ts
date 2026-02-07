/**
 * Phase 2 Devnet E2E Tests — full ZK proof flow against mock-klend on devnet
 *
 * Prerequisites:
 *   - privacy-yield deployed to devnet (5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw)
 *   - mock-klend deployed to devnet (CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk)
 *   - `yarn devnet:setup` has been run (creates devnet_config.json)
 *   - Wallet at ~/.config/solana/id.json has devnet SOL + is the authority
 *
 * Run: yarn test:devnet
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PrivacyYield } from "../target/types/privacy_yield";
import {
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
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";

import { Utxo } from "./lib/utxo";
import { Keypair as ZKKeypair } from "./lib/keypair";
import { MerkleTree } from "./lib/merkle_tree";
import {
  parseProofToBytesArray,
  parseToBytesArray,
  prove,
} from "./lib/prover";
import {
  getExtDataHash,
  getMintAddressField,
  findNullifierPDAs,
  findCrossCheckNullifierPDAs,
} from "./lib/utils";

// ==================== Config ====================

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
  await new Promise((resolve) => setTimeout(resolve, 2000));

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
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
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

describe("Phase 2: E2E Devnet Tests (mock-klend + ZK proofs)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;

  let program: Program<PrivacyYield>;
  let config: DevnetConfig;
  let lightWasm: LightWasm;

  // Addresses from config
  let MOCK_KLEND_PROGRAM_ID: PublicKey;
  let usdcMint: PublicKey;
  let lendingMarket: PublicKey;
  let lendingMarketAuthority: PublicKey;
  let reserve: PublicKey;
  let reserveLiquiditySupply: PublicKey;
  let reserveCollateralMint: PublicKey;
  let treeAccountPDA: PublicKey;
  let poolConfigPDA: PublicKey;
  let klendConfigPDA: PublicKey;
  let poolVault: PublicKey;
  let poolCtokenAccount: PublicKey;

  // Test accounts
  let userTokenAccount: PublicKey;
  let recipientKp: Keypair;
  let recipientTokenAccount: PublicKey;

  // ZK state
  let merkleTree: MerkleTree;
  let sharedKeypair: ZKKeypair;
  let keyBasePath: string;
  let mintAddressBase58: string;
  let lookupTableAddress: PublicKey;

  // Track UTXOs
  let depositUtxo: Utxo;

  before(async () => {
    // Load config
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new Error(
        `devnet_config.json not found. Run 'yarn devnet:setup' first.`
      );
    }
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

    // Load program from IDL
    const privacyYieldIdl = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../target/idl/privacy_yield.json"),
        "utf-8"
      )
    );
    program = new Program(
      privacyYieldIdl,
      provider
    ) as unknown as Program<PrivacyYield>;

    // Set addresses from config
    MOCK_KLEND_PROGRAM_ID = new PublicKey(config.mockKlendProgram);
    usdcMint = new PublicKey(config.usdcMint);
    lendingMarket = new PublicKey(config.lendingMarket);
    lendingMarketAuthority = new PublicKey(config.lendingMarketAuthority);
    reserve = new PublicKey(config.reserve);
    reserveLiquiditySupply = new PublicKey(config.reserveLiquiditySupply);
    reserveCollateralMint = new PublicKey(config.reserveCollateralMint);
    treeAccountPDA = new PublicKey(config.treeAccountPDA);
    poolConfigPDA = new PublicKey(config.poolConfigPDA);
    klendConfigPDA = new PublicKey(config.klendConfigPDA);
    poolVault = new PublicKey(config.poolVault);
    poolCtokenAccount = new PublicKey(config.poolCtokenAccount);

    mintAddressBase58 = usdcMint.toBase58();

    // Init ZK
    lightWasm = await WasmFactory.getInstance();
    merkleTree = new MerkleTree(26, lightWasm);
    keyBasePath = path.resolve(__dirname, "../../artifacts/transaction2");
    sharedKeypair = ZKKeypair.generateNew(lightWasm);

    // Sync merkle tree with on-chain state
    // MerkleTreeAccount layout (zero_copy): 8 (discriminator) + 32 (authority) + 8 (next_index u64) + ...
    const treeAccount = await connection.getAccountInfo(treeAccountPDA);
    if (treeAccount) {
      const nextIndex = Number(treeAccount.data.readBigUInt64LE(8 + 32));
      console.log("    On-chain tree has %d leaves", nextIndex);
      // Insert zero-commitment placeholders so our local tree index matches
      for (let i = 0; i < nextIndex; i++) {
        merkleTree.insert("0");
      }
    }

    // Create user token account (authority is our user for devnet)
    userTokenAccount = await getAssociatedTokenAddress(
      usdcMint,
      authority.publicKey
    );

    // Create recipient
    recipientKp = Keypair.generate();
    recipientTokenAccount = await getAssociatedTokenAddress(
      usdcMint,
      recipientKp.publicKey
    );

    // Create ALT with all addresses needed for bundled txs
    const altAddresses = [
      program.programId,
      treeAccountPDA,
      poolConfigPDA,
      poolVault,
      usdcMint,
      SystemProgram.programId,
      ComputeBudgetProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      klendConfigPDA,
      poolCtokenAccount,
      MOCK_KLEND_PROGRAM_ID,
      reserve,
      lendingMarket,
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

    console.log("    Config loaded:");
    console.log("    privacy-yield:", config.privacyYieldProgram);
    console.log("    mock-klend:", config.mockKlendProgram);
    console.log("    USDC mint:", usdcMint.toBase58().slice(0, 16));
    console.log("    ALT:", lookupTableAddress.toBase58().slice(0, 16));
  });

  // =====================================================
  // Test 1: Verify deployment — both programs exist, PDAs initialized
  // =====================================================
  it("1. Verify deployment — programs exist and PDAs initialized", async () => {
    const privacyYieldAccount = await connection.getAccountInfo(
      new PublicKey(config.privacyYieldProgram)
    );
    expect(privacyYieldAccount).to.not.be.null;
    expect(privacyYieldAccount!.executable).to.be.true;

    const mockKlendAccount = await connection.getAccountInfo(
      MOCK_KLEND_PROGRAM_ID
    );
    expect(mockKlendAccount).to.not.be.null;
    expect(mockKlendAccount!.executable).to.be.true;

    const poolConfig = await connection.getAccountInfo(poolConfigPDA);
    expect(poolConfig).to.not.be.null;

    const klendConfig = await connection.getAccountInfo(klendConfigPDA);
    expect(klendConfig).to.not.be.null;

    const treeAccount = await connection.getAccountInfo(treeAccountPDA);
    expect(treeAccount).to.not.be.null;

    console.log("    All programs deployed and PDAs initialized");
  });

  // =====================================================
  // Test 2: Mint test USDC to user
  // =====================================================
  it("2. Mint test USDC to user", async () => {
    // Create user ATA if it doesn't exist
    const userAtaInfo = await connection.getAccountInfo(userTokenAccount);
    if (!userAtaInfo) {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        authority.publicKey,
        userTokenAccount,
        authority.publicKey,
        usdcMint
      );
      await provider.sendAndConfirm(new Transaction().add(createAtaIx), [
        authority,
      ]);
    }

    // Mint 100 USDC
    const mintIx = createMintToInstruction(
      usdcMint,
      userTokenAccount,
      authority.publicKey,
      100_000_000 // 100 USDC
    );
    await provider.sendAndConfirm(new Transaction().add(mintIx), [authority]);

    const balance = await getAccount(connection, userTokenAccount);
    expect(Number(balance.amount)).to.be.greaterThanOrEqual(100_000_000);
    console.log("    User USDC balance:", Number(balance.amount));
  });

  // =====================================================
  // Test 3: Deposit USDC to pool — transact with ZK proof
  // =====================================================
  it("3. Deposit USDC to pool — transact with ZK proof", async () => {
    // Create recipient ATA if needed
    const recipientAtaInfo = await connection.getAccountInfo(
      recipientTokenAccount
    );
    if (!recipientAtaInfo) {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        authority.publicKey,
        recipientTokenAccount,
        recipientKp.publicKey,
        usdcMint
      );
      await provider.sendAndConfirm(new Transaction().add(createAtaIx), [
        authority,
      ]);
    }

    const depositAmount = 5_000_000; // 5 USDC

    // Check vault balance before deposit (may have leftover from previous runs)
    let vaultBefore = 0;
    try {
      const vaultInfo = await getAccount(connection, poolVault);
      vaultBefore = Number(vaultInfo.amount);
    } catch {
      // Vault doesn't exist yet — will be created by transact
    }

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

    const encryptedOutput1 = Buffer.from("devnet_deposit_enc1");
    const encryptedOutput2 = Buffer.from("devnet_deposit_enc2");

    const { proofToSubmit, extData, outputCommitments } =
      await buildProofInput({
        inputs,
        outputs,
        tree: merkleTree,
        extAmount: new BN(depositAmount),
        fee: new BN(0),
        recipient: recipientTokenAccount,
        feeRecipient: authority.publicKey,
        mintAddress: usdcMint,
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
        signer: authority.publicKey,
        mint: usdcMint,
        signerTokenAccount: userTokenAccount,
        recipient: recipientKp.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        poolVault: poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });

    const versionedTx = await createVersionedTransactionWithALT(
      connection,
      authority.publicKey,
      [computeBudgetIx, ...transactTx.instructions],
      lookupTableAddress
    );

    const txSig = await sendAndConfirmVersionedTransaction(
      connection,
      versionedTx,
      [authority]
    );

    // Update local tree
    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }
    depositUtxo = outputs[0];

    const vaultBalance = await getAccount(connection, poolVault);
    expect(Number(vaultBalance.amount)).to.equal(vaultBefore + depositAmount);
    console.log("    Deposit tx:", txSig.slice(0, 16));
    console.log("    Vault balance:", Number(vaultBalance.amount));
  });

  // =====================================================
  // Test 4: Kamino deposit — sweep vault USDC into mock-klend
  // =====================================================
  it("4. Kamino deposit — sweep vault USDC into mock-klend", async () => {
    const vaultBefore = await getAccount(connection, poolVault);
    expect(Number(vaultBefore.amount)).to.be.greaterThan(0);

    const ctokenBefore = await getAccount(connection, poolCtokenAccount);

    const tx = await program.methods
      .kaminoDeposit()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: authority.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserve,
        lendingMarket: lendingMarket,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    const vaultAfter = await getAccount(connection, poolVault);
    const ctokenAfter = await getAccount(connection, poolCtokenAccount);

    expect(Number(vaultAfter.amount)).to.equal(0);
    expect(Number(ctokenAfter.amount)).to.be.greaterThan(
      Number(ctokenBefore.amount)
    );

    console.log("    kamino_deposit tx:", tx.slice(0, 16));
    console.log("    vault: %d -> %d", Number(vaultBefore.amount), Number(vaultAfter.amount));
    console.log("    cTokens: %d -> %d", Number(ctokenBefore.amount), Number(ctokenAfter.amount));
  });

  // =====================================================
  // Test 5: Kamino redeem — get USDC back from mock-klend
  // =====================================================
  it("5. Kamino redeem — get USDC back from mock-klend", async () => {
    const ctokenBefore = await getAccount(connection, poolCtokenAccount);
    expect(Number(ctokenBefore.amount)).to.be.greaterThan(0);

    const vaultBefore = await getAccount(connection, poolVault);

    const tx = await program.methods
      .kaminoRedeem()
      .accounts({
        klendConfig: klendConfigPDA,
        poolConfig: poolConfigPDA,
        signer: authority.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserve,
        lendingMarket: lendingMarket,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint,
        reserveLiquiditySupply: reserveLiquiditySupply,
        reserveCollateralMint: reserveCollateralMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();

    const ctokenAfter = await getAccount(connection, poolCtokenAccount);
    const vaultAfter = await getAccount(connection, poolVault);

    expect(Number(ctokenAfter.amount)).to.equal(0);
    expect(Number(vaultAfter.amount)).to.be.greaterThan(
      Number(vaultBefore.amount)
    );

    console.log("    kamino_redeem tx:", tx.slice(0, 16));
    console.log("    cTokens: %d -> %d", Number(ctokenBefore.amount), Number(ctokenAfter.amount));
    console.log("    vault: %d -> %d", Number(vaultBefore.amount), Number(vaultAfter.amount));
  });

  // =====================================================
  // Test 6: Withdraw USDC from pool — transact with ZK proof
  // =====================================================
  it("6. Withdraw USDC from pool — transact with ZK proof", async () => {
    const withdrawAmount = 5_000_000; // withdraw all 5 USDC

    const inputs = [
      depositUtxo,
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const outputs = [
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const encryptedOutput1 = Buffer.from("devnet_withdraw_enc1");
    const encryptedOutput2 = Buffer.from("devnet_withdraw_enc2");

    const { proofToSubmit, extData, outputCommitments } =
      await buildProofInput({
        inputs,
        outputs,
        tree: merkleTree,
        extAmount: new BN(-withdrawAmount),
        fee: new BN(0),
        recipient: recipientTokenAccount,
        feeRecipient: authority.publicKey,
        mintAddress: usdcMint,
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
        signer: authority.publicKey,
        mint: usdcMint,
        signerTokenAccount: userTokenAccount,
        recipient: recipientKp.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        poolVault: poolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });

    const versionedTx = await createVersionedTransactionWithALT(
      connection,
      authority.publicKey,
      [computeBudgetIx, ...transactTx.instructions],
      lookupTableAddress
    );

    const txSig = await sendAndConfirmVersionedTransaction(
      connection,
      versionedTx,
      [authority]
    );

    // Update local tree
    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }

    console.log("    Withdraw tx:", txSig.slice(0, 16));

    const recipientBalance = await getAccount(
      connection,
      recipientTokenAccount
    );
    expect(Number(recipientBalance.amount)).to.equal(withdrawAmount);
    console.log("    Recipient received:", Number(recipientBalance.amount));
  });

  // =====================================================
  // Test 7: Verify balances — recipient got USDC, vault empty, cTokens zero
  // =====================================================
  it("7. Verify final balances", async () => {
    const vaultBalance = await getAccount(connection, poolVault);
    const ctokenBalance = await getAccount(connection, poolCtokenAccount);
    const recipientBalance = await getAccount(
      connection,
      recipientTokenAccount
    );

    console.log("    Vault:", Number(vaultBalance.amount));
    console.log("    cTokens:", Number(ctokenBalance.amount));
    console.log("    Recipient:", Number(recipientBalance.amount));

    // After deposit(5M) -> kaminoDeposit -> kaminoRedeem -> withdraw(5M):
    // vault should be 0, cTokens 0, recipient got 5 USDC
    expect(Number(vaultBalance.amount)).to.equal(0);
    expect(Number(ctokenBalance.amount)).to.equal(0);
    expect(Number(recipientBalance.amount)).to.be.greaterThanOrEqual(5_000_000);
  });

  // =====================================================
  // Test 8: Bundled deposit+yield — transact + kaminoDeposit in one tx
  // =====================================================
  it("8. Bundled deposit+yield — transact + kaminoDeposit in one tx", async () => {
    const depositAmount = 2_000_000; // 2 USDC
    const ctokenBefore = await getAccount(connection, poolCtokenAccount);

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

    const encryptedOutput1 = Buffer.from("devnet_bundle_enc1");
    const encryptedOutput2 = Buffer.from("devnet_bundle_enc2");

    const { proofToSubmit, extData, outputCommitments } =
      await buildProofInput({
        inputs,
        outputs,
        tree: merkleTree,
        extAmount: new BN(depositAmount),
        fee: new BN(0),
        recipient: recipientTokenAccount,
        feeRecipient: authority.publicKey,
        mintAddress: usdcMint,
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
        signer: authority.publicKey,
        mint: usdcMint,
        signerTokenAccount: userTokenAccount,
        recipient: recipientKp.publicKey,
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
        signer: authority.publicKey,
        poolVault: poolVault,
        poolCtokenAccount: poolCtokenAccount,
        klendProgram: MOCK_KLEND_PROGRAM_ID,
        reserve: reserve,
        lendingMarket: lendingMarket,
        lendingMarketAuthority: lendingMarketAuthority,
        reserveLiquidityMint: usdcMint,
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
      authority.publicKey,
      allInstructions,
      lookupTableAddress
    );

    const txSig = await sendAndConfirmVersionedTransaction(
      connection,
      versionedTx,
      [authority]
    );

    // Update local tree
    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }

    console.log("    Bundled deposit+yield tx:", txSig.slice(0, 16));

    // Verify: vault should be 0 (immediately swept to klend)
    const vaultAfter = await getAccount(connection, poolVault);
    expect(Number(vaultAfter.amount)).to.equal(0);

    // cTokens should have increased
    const ctokenAfter = await getAccount(connection, poolCtokenAccount);
    expect(Number(ctokenAfter.amount)).to.be.greaterThan(
      Number(ctokenBefore.amount)
    );
    console.log("    vault: 0 (swept)");
    console.log("    cTokens:", Number(ctokenAfter.amount));
  });
});
