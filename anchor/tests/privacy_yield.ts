import * as anchor from "@coral-xyz/anchor";
import { Program, EventParser, BorshCoder } from "@coral-xyz/anchor";
import { PrivacyYield } from "../target/types/privacy_yield";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, ComputeBudgetProgram, AddressLookupTableProgram, Transaction, sendAndConfirmTransaction, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { getAssociatedTokenAddress, createInitializeMintInstruction, createAssociatedTokenAccountInstruction, createMintToInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import * as path from 'path';
import BN from 'bn.js';
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";

import { DEFAULT_HEIGHT, FIELD_SIZE, ROOT_HISTORY_SIZE, ZERO_BYTES } from "./lib/constants";
import { Utxo } from "./lib/utxo";
import { Keypair } from "./lib/keypair";
import { MerkleTree } from "./lib/merkle_tree";
import { parseProofToBytesArray, parseToBytesArray, prove } from "./lib/prover";
import { bnToBytes, getExtDataHash, getMintAddressField, findNullifierPDAs, findCrossCheckNullifierPDAs, getProgramPDAs } from "./lib/utils";

// ==================== ALT Helpers ====================

let globalTestALT: PublicKey | null = null;

async function createGlobalTestALT(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> {
  if (globalTestALT) return globalTestALT;

  const recentSlot = await connection.getSlot('confirmed');
  let [lookupTableInst, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot,
  });

  const createALTTx = new Transaction().add(lookupTableInst);
  await sendAndConfirmTransaction(connection, createALTTx, [payer]);
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Add addresses in chunks
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
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  await new Promise(resolve => setTimeout(resolve, 1000));
  globalTestALT = lookupTableAddress;
  return lookupTableAddress;
}

async function createVersionedTransactionWithALT(
  connection: anchor.web3.Connection,
  payer: PublicKey,
  instructions: anchor.web3.TransactionInstruction[],
  altAddress: PublicKey
): Promise<VersionedTransaction> {
  const lookupTableAccount = await connection.getAddressLookupTable(altAddress);
  if (!lookupTableAccount.value) throw new Error(`ALT not found: ${altAddress.toString()}`);

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
    preflightCommitment: 'confirmed',
  });
  const latestBlockHash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    blockhash: latestBlockHash.blockhash,
    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
    signature,
  });
  return signature;
}

// ==================== Transaction Builder Helpers ====================

interface TransactParams {
  program: Program<PrivacyYield>;
  signer: anchor.web3.Keypair;
  recipient: anchor.web3.Keypair;
  mint: PublicKey;
  signerTokenAccount: PublicKey;
  recipientTokenAccount: PublicKey;
  proof: any;
  extData: any;
  treeAccountPDA: PublicKey;
  poolConfigPDA: PublicKey;
  lookupTableAddress: PublicKey;
  connection: anchor.web3.Connection;
}

async function buildAndSendTransact(params: TransactParams): Promise<string> {
  const { program, signer, recipient, mint, signerTokenAccount, recipientTokenAccount, proof, extData, treeAccountPDA, poolConfigPDA, lookupTableAddress, connection } = params;

  const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program.programId, proof);
  const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(program.programId, proof);

  const poolVault = await getAssociatedTokenAddress(mint, poolConfigPDA, true);

  const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  const extDataMinified = {
    extAmount: extData.extAmount,
    fee: extData.fee,
  };

  const tx = await program.methods
    .transact(proof, extDataMinified, extData.encryptedOutput1, extData.encryptedOutput2)
    .accounts({
      treeAccount: treeAccountPDA,
      nullifier0: nullifier0PDA,
      nullifier1: nullifier1PDA,
      nullifier2: nullifier2PDA,
      nullifier3: nullifier3PDA,
      poolConfig: poolConfigPDA,
      signer: signer.publicKey,
      mint,
      signerTokenAccount,
      recipient: recipient.publicKey,
      recipientTokenAccount,
      poolVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([signer])
    .preInstructions([modifyComputeUnits])
    .transaction();

  const versionedTx = await createVersionedTransactionWithALT(
    connection, signer.publicKey, tx.instructions, lookupTableAddress
  );

  return await sendAndConfirmVersionedTransaction(connection, versionedTx, [signer]);
}

// Build circuit input and generate proof
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
  const { inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, mintAddress, encryptedOutput1, encryptedOutput2, keyBasePath } = params;

  const mintAddressBase58 = mintAddress.toBase58();
  const mintAddressField = getMintAddressField(mintAddress);

  // Build Merkle paths
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

  const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
  const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

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

  // Public amount: ext_amount - fee (no fee in Phase 1, so just ext_amount)
  const publicAmount = extAmount;

  const circuitInput = {
    root,
    publicAmount: publicAmount.toString(),
    extDataHash: calculatedExtDataHash,
    mintAddress: mintAddressField,
    inputNullifier: inputNullifiers,
    inAmount: inputs.map(x => x.amount.toString(10)),
    inPrivateKey: inputs.map(x => x.keypair.privkey),
    inBlinding: inputs.map(x => x.blinding.toString(10)),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,
    outputCommitment: outputCommitments,
    outAmount: outputs.map(x => x.amount.toString(10)),
    outBlinding: outputs.map(x => x.blinding.toString(10)),
    outPubkey: outputs.map(x => x.keypair.pubkey),
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

describe("privacy-yield", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PrivacyYield as Program<PrivacyYield>;
  let lightWasm: LightWasm;

  let treeAccountPDA: PublicKey;
  let poolConfigPDA: PublicKey;
  let authority: anchor.web3.Keypair;
  let user: anchor.web3.Keypair;
  let recipient: anchor.web3.Keypair;
  let usdcMint: anchor.web3.Keypair;
  let userTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let merkleTree: MerkleTree;
  let lookupTableAddress: PublicKey;
  let keyBasePath: string;
  let mintAddressBase58: string;

  // Shared keypair for UTXO ownership across tests
  let sharedKeypair: Keypair;

  // Track UTXOs across tests for stateful scenarios
  let depositUtxo: Utxo;
  let depositUtxo2: Utxo;
  let changeUtxo: Utxo;
  let mergedUtxo: Utxo;

  before(async () => {
    lightWasm = await WasmFactory.getInstance();
    merkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
    keyBasePath = path.resolve(__dirname, '../../artifacts/transaction2');
    sharedKeypair = Keypair.generateNew(lightWasm);

    // Generate accounts
    authority = anchor.web3.Keypair.generate();
    user = anchor.web3.Keypair.generate();
    recipient = anchor.web3.Keypair.generate();
    usdcMint = anchor.web3.Keypair.generate();

    // Airdrop SOL
    const airdropSig = await provider.connection.requestAirdrop(
      authority.publicKey, 100 * LAMPORTS_PER_SOL
    );
    let bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, signature: airdropSig });

    const userAirdropSig = await provider.connection.requestAirdrop(
      user.publicKey, 100 * LAMPORTS_PER_SOL
    );
    bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, signature: userAirdropSig });

    const recipientAirdropSig = await provider.connection.requestAirdrop(
      recipient.publicKey, 1 * LAMPORTS_PER_SOL
    );
    bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, signature: recipientAirdropSig });

    // Create test USDC mint (6 decimals)
    const mintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: usdcMint.publicKey,
        space: 82,
        lamports: await provider.connection.getMinimumBalanceForRentExemption(82),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(usdcMint.publicKey, 6, authority.publicKey, authority.publicKey)
    );
    await provider.sendAndConfirm(mintTx, [authority, usdcMint]);

    mintAddressBase58 = usdcMint.publicKey.toBase58();

    // Create user token account and mint USDC
    userTokenAccount = await getAssociatedTokenAddress(usdcMint.publicKey, user.publicKey);
    const createUserAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(authority.publicKey, userTokenAccount, user.publicKey, usdcMint.publicKey)
    );
    await provider.sendAndConfirm(createUserAtaTx, [authority]);

    const mintAmount = 100_000_000; // 100 USDC
    const mintToUserTx = new Transaction().add(
      createMintToInstruction(usdcMint.publicKey, userTokenAccount, authority.publicKey, mintAmount)
    );
    await provider.sendAndConfirm(mintToUserTx, [authority]);

    // Create recipient token account
    recipientTokenAccount = await getAssociatedTokenAddress(usdcMint.publicKey, recipient.publicKey);
    const createRecipientAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(authority.publicKey, recipientTokenAccount, recipient.publicKey, usdcMint.publicKey)
    );
    await provider.sendAndConfirm(createRecipientAtaTx, [authority]);

    // Derive PDAs
    const pdas = getProgramPDAs(program.programId);
    treeAccountPDA = pdas.treeAccountPDA;
    poolConfigPDA = pdas.poolConfigPDA;

    // Initialize the program
    await program.methods
      .initialize()
      .accounts({
        treeAccount: treeAccountPDA,
        poolConfig: poolConfigPDA,
        usdcMint: usdcMint.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    // Create Address Lookup Table
    const poolVault = await getAssociatedTokenAddress(usdcMint.publicKey, poolConfigPDA, true);
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
    ];
    lookupTableAddress = await createGlobalTestALT(provider.connection, authority, altAddresses);
  });

  // ==================== Test 1: Initialize ====================
  it("1. Initialize — verify tree state, pool config, zero root", async () => {
    const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    expect(merkleTreeAccount.authority.equals(authority.publicKey)).to.be.true;
    expect(merkleTreeAccount.nextIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootHistory.length).to.equal(ROOT_HISTORY_SIZE);
    expect(merkleTreeAccount.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);

    const poolConfig = await program.account.poolConfig.fetch(poolConfigPDA);
    expect(poolConfig.authority.equals(authority.publicKey)).to.be.true;
    expect(poolConfig.usdcMint.equals(usdcMint.publicKey)).to.be.true;
  });

  // ==================== Test 2: Deposit ====================
  it("2. Deposit — 1 USDC, verify balances and tree update", async () => {
    const depositAmount = 1_000_000; // 1 USDC

    // Empty inputs (first deposit — no existing UTXOs to spend)
    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    // Output: 1 USDC UTXO + empty UTXO
    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const encryptedOutput1 = Buffer.from("deposit1_enc_output1");
    const encryptedOutput2 = Buffer.from("deposit1_enc_output2");

    const { proofToSubmit, extData, outputCommitments } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount),
      fee: new BN(0),
      recipient: recipientTokenAccount,
      feeRecipient: user.publicKey, // placeholder, no fees
      mintAddress: usdcMint.publicKey,
      encryptedOutput1, encryptedOutput2,
      keyBasePath,
    });

    // Get balance before
    const userBalanceBefore = (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount;

    const txSig = await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    expect(txSig).to.be.a('string');

    // Verify balance changed
    const userBalanceAfter = (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount;
    expect(parseInt(userBalanceBefore) - parseInt(userBalanceAfter)).to.equal(depositAmount);

    // Verify tree updated
    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }

    const onChainTree = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    expect(onChainTree.nextIndex.toString()).to.equal("2");

    // Save the deposit UTXO for later tests
    depositUtxo = outputs[0];
  });

  // ==================== Test 3: Full Withdrawal ====================
  it("3. Full withdrawal — spend deposit UTXO, verify recipient gets USDC", async () => {
    const withdrawAmount = 1_000_000; // 1 USDC (full withdrawal of deposit)

    // Inputs: spend the deposit UTXO
    const inputs = [
      depositUtxo,
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    // Outputs: two empty UTXOs (full withdrawal)
    const outputs = [
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const encryptedOutput1 = Buffer.from("withdraw_enc_output1");
    const encryptedOutput2 = Buffer.from("withdraw_enc_output2");

    const { proofToSubmit, extData, outputCommitments } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(-withdrawAmount),
      fee: new BN(0),
      recipient: recipientTokenAccount,
      feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1, encryptedOutput2,
      keyBasePath,
    });

    const recipientBalanceBefore = (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount;

    const txSig = await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    expect(txSig).to.be.a('string');

    // Verify recipient received USDC
    const recipientBalanceAfter = (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount;
    expect(parseInt(recipientBalanceAfter) - parseInt(recipientBalanceBefore)).to.equal(withdrawAmount);

    // Update tree
    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }
  });

  // ==================== Test 4: Partial Withdrawal ====================
  it("4. Partial withdrawal — deposit 2 USDC, withdraw 0.5, verify change UTXO", async () => {
    const depositAmount = 2_000_000; // 2 USDC

    // Deposit 2 USDC first
    const depositInputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const depositOutputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: depositProof, extData: depositExtData, outputCommitments: depositCommitments } = await buildProofInput({
      inputs: depositInputs, outputs: depositOutputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("partial_deposit_enc1"),
      encryptedOutput2: Buffer.from("partial_deposit_enc2"),
      keyBasePath,
    });

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: depositProof, extData: depositExtData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    for (const commitment of depositCommitments) {
      merkleTree.insert(commitment);
    }

    // Now withdraw 0.5 USDC (partial)
    const withdrawAmount = 500_000; // 0.5 USDC
    const changeAmount = depositAmount - withdrawAmount; // 1.5 USDC

    const withdrawInputs = [
      depositOutputs[0], // spend the 2 USDC UTXO
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: changeAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: withdrawProof, extData: withdrawExtData, outputCommitments: withdrawCommitments } = await buildProofInput({
      inputs: withdrawInputs, outputs: withdrawOutputs, tree: merkleTree,
      extAmount: new BN(-withdrawAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("partial_withdraw_enc1"),
      encryptedOutput2: Buffer.from("partial_withdraw_enc2"),
      keyBasePath,
    });

    const recipientBalanceBefore = (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount;

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: withdrawProof, extData: withdrawExtData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    const recipientBalanceAfter = (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount;
    expect(parseInt(recipientBalanceAfter) - parseInt(recipientBalanceBefore)).to.equal(withdrawAmount);

    for (const commitment of withdrawCommitments) {
      merkleTree.insert(commitment);
    }

    // Save change UTXO for next test
    changeUtxo = withdrawOutputs[0];
  });

  // ==================== Test 5: Spend Change UTXO ====================
  it("5. Spend change UTXO — withdraw remaining 1.5 USDC", async () => {
    const withdrawAmount = 1_500_000; // 1.5 USDC

    const inputs = [
      changeUtxo,
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit, extData, outputCommitments } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(-withdrawAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("change_withdraw_enc1"),
      encryptedOutput2: Buffer.from("change_withdraw_enc2"),
      keyBasePath,
    });

    const recipientBalanceBefore = (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount;

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    const recipientBalanceAfter = (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount;
    expect(parseInt(recipientBalanceAfter) - parseInt(recipientBalanceBefore)).to.equal(withdrawAmount);

    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }
  });

  // ==================== Test 6: Merge ====================
  it("6. Merge — deposit twice, merge into one UTXO", async () => {
    // Deposit 1 USDC (first)
    const deposit1Amount = 1_000_000;
    const deposit1Inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const deposit1Outputs = [
      new Utxo({ lightWasm, amount: deposit1Amount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: d1Proof, extData: d1ExtData, outputCommitments: d1Commitments } = await buildProofInput({
      inputs: deposit1Inputs, outputs: deposit1Outputs, tree: merkleTree,
      extAmount: new BN(deposit1Amount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("merge_dep1_enc1"),
      encryptedOutput2: Buffer.from("merge_dep1_enc2"),
      keyBasePath,
    });

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: d1Proof, extData: d1ExtData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    for (const commitment of d1Commitments) merkleTree.insert(commitment);

    // Deposit 1 USDC (second)
    const deposit2Amount = 1_000_000;
    const deposit2Inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const deposit2Outputs = [
      new Utxo({ lightWasm, amount: deposit2Amount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: d2Proof, extData: d2ExtData, outputCommitments: d2Commitments } = await buildProofInput({
      inputs: deposit2Inputs, outputs: deposit2Outputs, tree: merkleTree,
      extAmount: new BN(deposit2Amount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("merge_dep2_enc1"),
      encryptedOutput2: Buffer.from("merge_dep2_enc2"),
      keyBasePath,
    });

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: d2Proof, extData: d2ExtData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    for (const commitment of d2Commitments) merkleTree.insert(commitment);

    // Merge: spend both UTXOs, create one merged output, ext_amount=0
    const mergedAmount = deposit1Amount + deposit2Amount; // 2 USDC

    const mergeInputs = [
      deposit1Outputs[0],
      deposit2Outputs[0],
    ];

    const mergeOutputs = [
      new Utxo({ lightWasm, amount: mergedAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: mergeProof, extData: mergeExtData, outputCommitments: mergeCommitments } = await buildProofInput({
      inputs: mergeInputs, outputs: mergeOutputs, tree: merkleTree,
      extAmount: new BN(0), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("merge_enc1"),
      encryptedOutput2: Buffer.from("merge_enc2"),
      keyBasePath,
    });

    // Verify no token transfer happens (ext_amount=0)
    const userBalanceBefore = (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount;

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: mergeProof, extData: mergeExtData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    const userBalanceAfter = (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount;
    expect(parseInt(userBalanceAfter)).to.equal(parseInt(userBalanceBefore)); // No change

    for (const commitment of mergeCommitments) merkleTree.insert(commitment);

    // Save merged UTXO for potential future use
    mergedUtxo = mergeOutputs[0];
  });

  // ==================== Test 7: Double-spend Rejection ====================
  it("7. Double-spend rejection — reuse spent UTXO fails", async () => {
    // Try to spend depositUtxo again (was already spent in test 3)
    const inputs = [
      depositUtxo, // Already spent!
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit, extData } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(-1_000_000), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("doublespend_enc1"),
      encryptedOutput2: Buffer.from("doublespend_enc2"),
      keyBasePath,
    });

    try {
      await buildAndSendTransact({
        program, signer: user, recipient, mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount, recipientTokenAccount,
        proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
        lookupTableAddress, connection: provider.connection,
      });
      expect.fail("Transaction should have failed due to double-spend");
    } catch (error: any) {
      // The nullifier PDA already exists, so `init` will fail with "already in use"
      const errStr = error.toString();
      expect(errStr).to.not.include("should have failed");
      expect(errStr).to.satisfy((s: string) =>
        s.includes("already in use") || s.includes("custom program error"),
        "Expected 'already in use' (PDA exists) or a custom program error"
      );
    }
  });

  // ==================== Test 8: Invalid Proof Rejection ====================
  it("8. Invalid proof rejection — corrupt proof bytes fails", async () => {
    const depositAmount = 500_000; // 0.5 USDC

    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit, extData } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("invalid_proof_enc1"),
      encryptedOutput2: Buffer.from("invalid_proof_enc2"),
      keyBasePath,
    });

    // Corrupt the proof
    proofToSubmit.proofA[0] = (proofToSubmit.proofA[0] + 1) % 256;

    try {
      await buildAndSendTransact({
        program, signer: user, recipient, mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount, recipientTokenAccount,
        proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
        lookupTableAddress, connection: provider.connection,
      });
      expect.fail("Transaction should have failed due to invalid proof");
    } catch (error: any) {
      // Should fail with InvalidProof (error code 0x1775 = 6005)
      const errStr = error.toString();
      expect(errStr).to.not.include("should have failed");
      expect(errStr).to.satisfy((s: string) =>
        s.includes("InvalidProof") || s.includes("0x1775") || s.includes("custom program error"),
        "Expected InvalidProof error from on-chain proof verification"
      );
    }
  });

  // ==================== Test 9: Wrong Root Rejection ====================
  it("9. Wrong root rejection — fabricated root fails", async () => {
    const depositAmount = 500_000;

    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit, extData } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("wrong_root_enc1"),
      encryptedOutput2: Buffer.from("wrong_root_enc2"),
      keyBasePath,
    });

    // Fabricate a wrong root
    proofToSubmit.root = new Array(32).fill(1);

    try {
      await buildAndSendTransact({
        program, signer: user, recipient, mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount, recipientTokenAccount,
        proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
        lookupTableAddress, connection: provider.connection,
      });
      expect.fail("Transaction should have failed due to unknown root");
    } catch (error: any) {
      // Should fail with UnknownRoot (error code 0x1772 = 6002)
      const errStr = error.toString();
      expect(errStr).to.not.include("should have failed");
      expect(errStr).to.satisfy((s: string) =>
        s.includes("UnknownRoot") || s.includes("0x1772") || s.includes("custom program error"),
        "Expected UnknownRoot error for fabricated Merkle root"
      );
    }
  });

  // ==================== Test 10: Deposit with Consolidation ====================
  it("10. Deposit with consolidation — deposit while spending existing UTXO", async () => {
    const additionalDeposit = 1_000_000; // 1 USDC new deposit
    const existingAmount = mergedUtxo.amount.toNumber(); // 2 USDC from merge
    const totalAmount = existingAmount + additionalDeposit; // 3 USDC

    const inputs = [
      mergedUtxo, // Spend the 2 USDC merged UTXO
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: totalAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit, extData, outputCommitments } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(additionalDeposit), // Only depositing 1 USDC more
      fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("consolidation_enc1"),
      encryptedOutput2: Buffer.from("consolidation_enc2"),
      keyBasePath,
    });

    const userBalanceBefore = (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount;

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    const userBalanceAfter = (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount;
    // User should have paid only the additionalDeposit, not the full totalAmount
    expect(parseInt(userBalanceBefore) - parseInt(userBalanceAfter)).to.equal(additionalDeposit);

    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }
  });

  // ==================== Test 11: Event Emission Verification ====================
  it("11. Event emission — verify CommitmentData events on deposit", async () => {
    const depositAmount = 500_000; // 0.5 USDC

    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const encryptedOutput1 = Buffer.from("event_test_enc1");
    const encryptedOutput2 = Buffer.from("event_test_enc2");

    const treeLeafCountBefore = merkleTree._layers[0].length;

    const { proofToSubmit, extData, outputCommitments } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1, encryptedOutput2,
      keyBasePath,
    });

    const txSig = await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    // Update local tree FIRST (so subsequent tests aren't broken if event parsing fails)
    for (const commitment of outputCommitments) {
      merkleTree.insert(commitment);
    }

    // Fetch transaction logs — retry up to 3 times with increasing delay
    let txDetails: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      txDetails = await provider.connection.getTransaction(txSig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (txDetails?.meta?.logMessages) break;
    }
    expect(txDetails).to.not.be.null;
    expect(txDetails!.meta).to.not.be.null;
    expect(txDetails!.meta!.logMessages).to.not.be.null;

    const logs = txDetails!.meta!.logMessages!;
    const events: any[] = [];
    const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));

    // Try generator pattern (Anchor 0.31+)
    for (const event of eventParser.parseLogs(logs)) {
      events.push(event);
    }

    // Should have exactly 2 CommitmentData events (one per output)
    const commitmentEvents = events.filter(e => e.name === "commitmentData");
    expect(commitmentEvents.length).to.equal(2);

    // Verify indices are sequential starting from the tree size before this tx
    expect(commitmentEvents[0].data.index.toString()).to.equal(treeLeafCountBefore.toString());
    expect(commitmentEvents[1].data.index.toString()).to.equal((treeLeafCountBefore + 1).toString());

    // Verify commitment bytes match proof output commitments
    expect(Buffer.from(commitmentEvents[0].data.commitment).toString('hex'))
      .to.equal(Buffer.from(proofToSubmit.outputCommitments[0]).toString('hex'));
    expect(Buffer.from(commitmentEvents[1].data.commitment).toString('hex'))
      .to.equal(Buffer.from(proofToSubmit.outputCommitments[1]).toString('hex'));

    // Verify encrypted outputs match what was submitted
    expect(Buffer.from(commitmentEvents[0].data.encryptedOutput).toString())
      .to.equal("event_test_enc1");
    expect(Buffer.from(commitmentEvents[1].data.encryptedOutput).toString())
      .to.equal("event_test_enc2");
  });

  // ==================== Test 12: Tampered ExtAmount Rejection ====================
  it("12. Tampered extAmount — modified amount after proof fails", async () => {
    const depositAmount = 500_000; // 0.5 USDC

    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit, extData } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("tamper_amt_enc1"),
      encryptedOutput2: Buffer.from("tamper_amt_enc2"),
      keyBasePath,
    });

    // Tamper: double the ext_amount after proof was generated
    extData.extAmount = new BN(depositAmount * 2);

    try {
      await buildAndSendTransact({
        program, signer: user, recipient, mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount, recipientTokenAccount,
        proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
        lookupTableAddress, connection: provider.connection,
      });
      expect.fail("Should have failed — tampered extAmount");
    } catch (error: any) {
      const errStr = error.toString();
      expect(errStr).to.not.include("Should have failed");
      expect(errStr).to.satisfy((s: string) =>
        s.includes("ExtDataHashMismatch") || s.includes("0x1771") ||
        s.includes("InvalidPublicAmountData") || s.includes("0x1773") ||
        s.includes("custom program error"),
        "Expected ExtDataHashMismatch or InvalidPublicAmountData"
      );
    }
  });

  // ==================== Test 13: Cross-Check Double-Spend (Position-Swap) ====================
  it("13. Cross-check double-spend — position-swap attack caught", async () => {
    // Step 1: Deposit 1 USDC to create a fresh UTXO
    const amount = 1_000_000;
    const attackKeypair = Keypair.generateNew(lightWasm);

    const dInputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const dOutputs = [
      new Utxo({ lightWasm, amount, keypair: attackKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: dProof, extData: dExt, outputCommitments: dComm } = await buildProofInput({
      inputs: dInputs, outputs: dOutputs, tree: merkleTree,
      extAmount: new BN(amount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("xchk_dep_e1"),
      encryptedOutput2: Buffer.from("xchk_dep_e2"),
      keyBasePath,
    });

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: dProof, extData: dExt, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });
    for (const c of dComm) merkleTree.insert(c);

    const targetUtxo = dOutputs[0];

    // Step 2: Withdraw normally — target UTXO in input[0]
    // This creates nullifier0 PDA with the target's nullifier
    const w1Inputs = [
      targetUtxo,
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const w1Outputs = [
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: w1Proof, extData: w1Ext, outputCommitments: w1Comm } = await buildProofInput({
      inputs: w1Inputs, outputs: w1Outputs, tree: merkleTree,
      extAmount: new BN(-amount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("xchk_w1_e1"),
      encryptedOutput2: Buffer.from("xchk_w1_e2"),
      keyBasePath,
    });

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: w1Proof, extData: w1Ext, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });
    for (const c of w1Comm) merkleTree.insert(c);

    // Step 3: Attack — same UTXO but in input[1] (swapped position)
    // The circuit produces a valid proof, but cross-check nullifier2
    // (["nullifier0", targetNullifier]) already exists as a NullifierAccount
    // owned by the program — passing it as SystemAccount fails.
    const w2Inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }), // empty in slot 0
      targetUtxo, // reused UTXO in slot 1
    ];
    const w2Outputs = [
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: w2Proof, extData: w2Ext } = await buildProofInput({
      inputs: w2Inputs, outputs: w2Outputs, tree: merkleTree,
      extAmount: new BN(-amount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("xchk_w2_e1"),
      encryptedOutput2: Buffer.from("xchk_w2_e2"),
      keyBasePath,
    });

    try {
      await buildAndSendTransact({
        program, signer: user, recipient, mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount, recipientTokenAccount,
        proof: w2Proof, extData: w2Ext, treeAccountPDA, poolConfigPDA,
        lookupTableAddress, connection: provider.connection,
      });
      expect.fail("Should have failed — position-swap double-spend must be caught");
    } catch (error: any) {
      const errStr = error.toString();
      expect(errStr).to.not.include("Should have failed");
      // Cross-check nullifier2 PDA has wrong owner (program instead of system)
      expect(errStr).to.satisfy((s: string) =>
        s.includes("already in use") ||
        s.includes("AccountOwnedByWrongProgram") ||
        s.includes("0xbbf") ||
        s.includes("ConstraintOwner") ||
        s.includes("custom program error") ||
        s.includes("Error processing"),
        "Expected cross-check failure from position-swap attack"
      );
    }
  });

  // ==================== Test 14: Two-Output Split ====================
  it("14. Two-output split — split UTXO into two non-zero outputs then spend one", async () => {
    // Deposit 3 USDC
    const totalAmount = 3_000_000;
    const splitKeypair = Keypair.generateNew(lightWasm);

    const dInputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const dOutputs = [
      new Utxo({ lightWasm, amount: totalAmount, keypair: splitKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: dProof, extData: dExt, outputCommitments: dComm } = await buildProofInput({
      inputs: dInputs, outputs: dOutputs, tree: merkleTree,
      extAmount: new BN(totalAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("split_dep_e1"),
      encryptedOutput2: Buffer.from("split_dep_e2"),
      keyBasePath,
    });

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: dProof, extData: dExt, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });
    for (const c of dComm) merkleTree.insert(c);

    // Split: 3 USDC → 1 USDC + 2 USDC (ext_amount=0, no token transfer)
    const split1Amount = 1_000_000;
    const split2Amount = 2_000_000;

    const splitInputs = [
      dOutputs[0], // 3 USDC
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const splitOutputs = [
      new Utxo({ lightWasm, amount: split1Amount, keypair: splitKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: split2Amount, keypair: splitKeypair, index: merkleTree._layers[0].length + 1, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: sProof, extData: sExt, outputCommitments: sComm } = await buildProofInput({
      inputs: splitInputs, outputs: splitOutputs, tree: merkleTree,
      extAmount: new BN(0), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("split_s_e1"),
      encryptedOutput2: Buffer.from("split_s_e2"),
      keyBasePath,
    });

    // Verify no token transfer during split
    const userBalBefore = (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount;

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: sProof, extData: sExt, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    const userBalAfter = (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount;
    expect(parseInt(userBalAfter)).to.equal(parseInt(userBalBefore)); // No balance change

    for (const c of sComm) merkleTree.insert(c);

    // Withdraw the 1 USDC split output to prove it's spendable
    const wInputs = [
      splitOutputs[0], // 1 USDC
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];
    const wOutputs = [
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit: wProof, extData: wExt, outputCommitments: wComm } = await buildProofInput({
      inputs: wInputs, outputs: wOutputs, tree: merkleTree,
      extAmount: new BN(-split1Amount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("split_w_e1"),
      encryptedOutput2: Buffer.from("split_w_e2"),
      keyBasePath,
    });

    const recipBefore = (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount;

    await buildAndSendTransact({
      program, signer: user, recipient, mint: usdcMint.publicKey,
      signerTokenAccount: userTokenAccount, recipientTokenAccount,
      proof: wProof, extData: wExt, treeAccountPDA, poolConfigPDA,
      lookupTableAddress, connection: provider.connection,
    });

    const recipAfter = (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount;
    expect(parseInt(recipAfter) - parseInt(recipBefore)).to.equal(split1Amount);

    for (const c of wComm) merkleTree.insert(c);
  });

  // ==================== Test 15: Re-Initialization Prevention ====================
  it("15. Re-initialization — calling initialize twice fails", async () => {
    try {
      await program.methods
        .initialize()
        .accounts({
          treeAccount: treeAccountPDA,
          poolConfig: poolConfigPDA,
          usdcMint: usdcMint.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();
      expect.fail("Should have failed — already initialized");
    } catch (error: any) {
      const errStr = error.toString();
      expect(errStr).to.not.include("Should have failed");
      // PDA already exists, `init` constraint fails
      expect(errStr).to.satisfy((s: string) =>
        s.includes("already in use") ||
        s.includes("already been created") ||
        s.includes("custom program error"),
        "Expected failure because PDAs already initialized"
      );
    }
  });

  // ==================== Test 16: Tampered Encrypted Output ====================
  it("16. Tampered encrypted output — modified after proof fails", async () => {
    const depositAmount = 500_000; // 0.5 USDC

    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, amount: 0, mintAddress: mintAddressBase58 }),
    ];

    const { proofToSubmit, extData } = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipientTokenAccount, feeRecipient: user.publicKey,
      mintAddress: usdcMint.publicKey,
      encryptedOutput1: Buffer.from("real_enc_data_1"),
      encryptedOutput2: Buffer.from("real_enc_data_2"),
      keyBasePath,
    });

    // Tamper: modify encrypted output after proof was generated
    // This changes the on-chain extDataHash calculation
    extData.encryptedOutput1 = Buffer.from("TAMPERED_OUTPUT_DATA_XXXXX");

    try {
      await buildAndSendTransact({
        program, signer: user, recipient, mint: usdcMint.publicKey,
        signerTokenAccount: userTokenAccount, recipientTokenAccount,
        proof: proofToSubmit, extData, treeAccountPDA, poolConfigPDA,
        lookupTableAddress, connection: provider.connection,
      });
      expect.fail("Should have failed — tampered encrypted output");
    } catch (error: any) {
      const errStr = error.toString();
      expect(errStr).to.not.include("Should have failed");
      expect(errStr).to.satisfy((s: string) =>
        s.includes("ExtDataHashMismatch") || s.includes("0x1771") ||
        s.includes("custom program error"),
        "Expected ExtDataHashMismatch from tampered encrypted output"
      );
    }
  });

  // ==================== Test 17: Root Consistency ====================
  it("17. Root consistency — on-chain root matches local tree after all operations", async () => {
    const onChainTree = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

    // Convert local tree root (decimal string) to bytes
    const localRootStr = merkleTree.root();
    const localRootBytes = bnToBytes(new BN(localRootStr));

    // Compare on-chain root with local root
    expect(Array.from(onChainTree.root)).to.deep.equal(localRootBytes);

    // Verify next_index matches local tree leaf count
    expect(onChainTree.nextIndex.toString()).to.equal(merkleTree._layers[0].length.toString());

    // Verify current root is in root_history
    const rootIndex = onChainTree.rootIndex.toNumber();
    expect(Array.from(onChainTree.rootHistory[rootIndex])).to.deep.equal(localRootBytes);
  });
});
