import { Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  Connection,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { LightWasm } from "@lightprotocol/hasher.rs";

import {
  PRIVACY_YIELD_PROGRAM_ID,
  MOCK_KLEND_PROGRAM_ID,
  USDC_MINT,
  POOL_CONFIG_PDA,
  TREE_ACCOUNT_PDA,
  KLEND_CONFIG_PDA,
  POOL_VAULT,
  POOL_CTOKEN_ACCOUNT,
  LENDING_MARKET,
  LENDING_MARKET_AUTHORITY,
  RESERVE,
  RESERVE_LIQUIDITY_SUPPLY,
  RESERVE_COLLATERAL_MINT,
} from "./config";
import idl from "./idl/privacy_yield.json";
import { Utxo } from "./utxo";
import { MerkleTree } from "./merkle-tree";
import {
  getExtDataHash,
  getMintAddressField,
  findNullifierPDAs,
  findCrossCheckNullifierPDAs,
} from "./utils";
import {
  prove,
  parseProofToBytesArray,
  parseToBytesArray,
} from "./prover";

// ALT cache
const ALT_STORAGE_KEY = "privacy-yield-alt-address";

function getCachedALTAddress(): PublicKey | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(ALT_STORAGE_KEY);
  return stored ? new PublicKey(stored) : null;
}

function setCachedALTAddress(address: PublicKey) {
  if (typeof window !== "undefined") {
    localStorage.setItem(ALT_STORAGE_KEY, address.toBase58());
  }
}

export function getProgram(provider: AnchorProvider): Program {
  return new Program(idl as any, provider);
}

export async function getOrCreateALT(
  connection: Connection,
  payer: PublicKey,
  signAndSendTransaction: (tx: Transaction) => Promise<string>
): Promise<PublicKey> {
  // Try cached ALT first
  const cached = getCachedALTAddress();
  if (cached) {
    const account = await connection.getAddressLookupTable(cached);
    if (account.value) return cached;
  }

  // Create new ALT
  const recentSlot = await connection.getSlot("confirmed");
  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer,
      payer,
      recentSlot,
    });

  const createTx = new Transaction().add(createIx);
  createTx.feePayer = payer;
  createTx.recentBlockhash = (
    await connection.getLatestBlockhash()
  ).blockhash;
  await signAndSendTransaction(createTx);

  // Wait for slot activation
  await new Promise((r) => setTimeout(r, 2000));

  // Extend with all needed addresses
  const addresses = [
    PRIVACY_YIELD_PROGRAM_ID,
    TREE_ACCOUNT_PDA,
    POOL_CONFIG_PDA,
    POOL_VAULT,
    USDC_MINT,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    KLEND_CONFIG_PDA,
    POOL_CTOKEN_ACCOUNT,
    MOCK_KLEND_PROGRAM_ID,
    RESERVE,
    LENDING_MARKET,
    LENDING_MARKET_AUTHORITY,
    RESERVE_LIQUIDITY_SUPPLY,
    RESERVE_COLLATERAL_MINT,
    SYSVAR_INSTRUCTIONS_PUBKEY,
  ];

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer,
    authority: payer,
    lookupTable: lookupTableAddress,
    addresses,
  });

  const extendTx = new Transaction().add(extendIx);
  extendTx.feePayer = payer;
  extendTx.recentBlockhash = (
    await connection.getLatestBlockhash()
  ).blockhash;
  await signAndSendTransaction(extendTx);

  await new Promise((r) => setTimeout(r, 2000));

  setCachedALTAddress(lookupTableAddress);
  return lookupTableAddress;
}

export async function createVersionedTx(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  altAddress: PublicKey
): Promise<VersionedTransaction> {
  const lookupTableAccount =
    await connection.getAddressLookupTable(altAddress);
  if (!lookupTableAccount.value)
    throw new Error("ALT not found: " + altAddress.toBase58());

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([lookupTableAccount.value]);

  return new VersionedTransaction(messageV0);
}

export interface ProofResult {
  proofToSubmit: {
    proofA: number[];
    proofB: number[];
    proofC: number[];
    root: number[];
    publicAmount: number[];
    extDataHash: number[];
    inputNullifiers: number[][];
    outputCommitments: number[][];
  };
  extData: {
    recipient: PublicKey;
    extAmount: BN;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    fee: BN;
    feeRecipient: PublicKey;
    mintAddress: PublicKey;
  };
  outputCommitments: string[];
}

export async function buildProofInput(params: {
  inputs: Utxo[];
  outputs: Utxo[];
  tree: MerkleTree;
  extAmount: BN;
  fee: BN;
  recipient: PublicKey;
  feeRecipient: PublicKey;
}): Promise<ProofResult> {
  const {
    inputs,
    outputs,
    tree,
    extAmount,
    fee,
    recipient,
    feeRecipient,
  } = params;

  const mintAddress = USDC_MINT;
  const mintAddressField = getMintAddressField(mintAddress);

  const inputMerklePathIndices: number[] = [];
  const inputMerklePathElements: any[] = [];

  for (const input of inputs) {
    if (input.amount.gt(new BN(0))) {
      const commitment = await input.getCommitment();
      const idx = tree.indexOf(commitment);
      if (idx < 0) throw new Error("Input commitment not found in tree");
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

  const encryptedOutput1 = new TextEncoder().encode("enc_out_1");
  const encryptedOutput2 = new TextEncoder().encode("enc_out_2");

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

  const circuitInput = {
    root,
    publicAmount: extAmount.toString(),
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

  const { proof, publicSignals } = await prove(circuitInput);

  const proofInBytes = parseProofToBytesArray(proof);
  const inputsInBytes = parseToBytesArray(publicSignals);

  const proofToSubmit = {
    proofA: proofInBytes.proofA,
    proofB: proofInBytes.proofB,
    proofC: proofInBytes.proofC,
    root: inputsInBytes[0],
    publicAmount: inputsInBytes[1],
    extDataHash: inputsInBytes[2],
    inputNullifiers: [inputsInBytes[3], inputsInBytes[4]],
    outputCommitments: [inputsInBytes[5], inputsInBytes[6]],
  };

  return { proofToSubmit, extData, outputCommitments };
}

export async function buildTransactInstruction(
  program: Program,
  proofResult: ProofResult,
  signer: PublicKey,
  signerTokenAccount: PublicKey,
  recipientPubkey: PublicKey,
  recipientTokenAccount: PublicKey
): Promise<TransactionInstruction[]> {
  const { proofToSubmit, extData } = proofResult;

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

  const tx = await (program.methods as any)
    .transact(
      proofToSubmit,
      extDataMinified,
      Buffer.from(extData.encryptedOutput1),
      Buffer.from(extData.encryptedOutput2)
    )
    .accounts({
      treeAccount: TREE_ACCOUNT_PDA,
      nullifier0: nullifier0PDA,
      nullifier1: nullifier1PDA,
      nullifier2: nullifier2PDA,
      nullifier3: nullifier3PDA,
      poolConfig: POOL_CONFIG_PDA,
      signer,
      mint: USDC_MINT,
      signerTokenAccount,
      recipient: recipientPubkey,
      recipientTokenAccount,
      poolVault: POOL_VAULT,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  return tx.instructions;
}

export async function buildTransactVersionedTx(
  connection: Connection,
  program: Program,
  proofResult: ProofResult,
  signer: PublicKey,
  signerTokenAccount: PublicKey,
  recipientPubkey: PublicKey,
  recipientTokenAccount: PublicKey,
  altAddress: PublicKey
): Promise<VersionedTransaction> {
  const instructions = await buildTransactInstruction(
    program,
    proofResult,
    signer,
    signerTokenAccount,
    recipientPubkey,
    recipientTokenAccount
  );

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });

  return createVersionedTx(
    connection,
    signer,
    [computeBudgetIx, ...instructions],
    altAddress
  );
}
