import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import * as path from "path";
import BN from "bn.js";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";

import { PrivacyPool, MockUSDC, Groth16Verifier, MockYieldVault } from "../typechain-types";
import { DEFAULT_HEIGHT } from "./lib/constants";
import { Utxo } from "./lib/utxo";
import { Keypair } from "./lib/keypair";
import { MerkleTree } from "./lib/merkle_tree";
import { prove, parseProofForSolidity } from "./lib/prover";
import { getExtDataHash, getMintAddressField, toPublicAmount } from "./lib/utils";

// ==================== Proof Builder ====================

async function buildProofInput(params: {
  inputs: Utxo[];
  outputs: Utxo[];
  tree: MerkleTree;
  extAmount: BN;
  fee: BN;
  recipient: string;
  feeRecipient: string;
  tokenAddress: string;
  encryptedOutput1: Buffer;
  encryptedOutput2: Buffer;
  keyBasePath: string;
}) {
  const {
    inputs, outputs, tree, extAmount, fee,
    recipient, feeRecipient, tokenAddress,
    encryptedOutput1, encryptedOutput2, keyBasePath,
  } = params;

  const mintAddressField = getMintAddressField(tokenAddress);

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
    recipient, extAmount, encryptedOutput1, encryptedOutput2,
    fee, feeRecipient, tokenAddress,
  };

  const calculatedExtDataHash = getExtDataHash(extData);
  const publicAmount = toPublicAmount(extAmount);

  const circuitInput = {
    root,
    publicAmount,
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
  const solidityProof = parseProofForSolidity(proof);

  return { proof: solidityProof, publicSignals, extData, outputCommitments };
}

function formatTransactParams(proofResult: Awaited<ReturnType<typeof buildProofInput>>) {
  const { proof, publicSignals, extData } = proofResult;

  const root = BigInt(publicSignals[0]);
  const publicAmount = BigInt(publicSignals[1]);
  const extDataHash = BigInt(publicSignals[2]);
  const inputNullifiers: [string, string] = [
    ethers.zeroPadValue(ethers.toBeHex(BigInt(publicSignals[3])), 32),
    ethers.zeroPadValue(ethers.toBeHex(BigInt(publicSignals[4])), 32),
  ];
  const outputCommitments: [bigint, bigint] = [
    BigInt(publicSignals[5]),
    BigInt(publicSignals[6]),
  ];

  const extDataForContract = {
    recipient: extData.recipient,
    extAmount: extData.extAmount.toString(),
    encryptedOutput1: extData.encryptedOutput1,
    encryptedOutput2: extData.encryptedOutput2,
    fee: extData.fee.toString(),
    feeRecipient: extData.feeRecipient,
    tokenAddress: extData.tokenAddress,
  };

  return {
    proofA: proof.a,
    proofB: proof.b,
    proofC: proof.c,
    root,
    publicAmount,
    extDataHash,
    inputNullifiers,
    outputCommitments,
    extData: extDataForContract,
  };
}

async function callTransact(
  pool: PrivacyPool,
  signer: HardhatEthersSigner,
  proofResult: Awaited<ReturnType<typeof buildProofInput>>
) {
  const params = formatTransactParams(proofResult);
  return pool.connect(signer).transact(
    params.proofA, params.proofB, params.proofC,
    params.root, params.publicAmount, params.extDataHash,
    params.inputNullifiers, params.outputCommitments, params.extData,
  );
}

// ==================== Tests ====================

describe("Phase 3: Batch Transact", () => {
  let lightWasm: LightWasm;
  let pool: PrivacyPool;
  let usdc: MockUSDC;
  let verifier: Groth16Verifier;
  let vault: MockYieldVault;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  let merkleTree: MerkleTree;
  let keyBasePath: string;
  let sharedKeypair: Keypair;

  before(async () => {
    lightWasm = await WasmFactory.getInstance();
    merkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
    keyBasePath = path.resolve(__dirname, "../../artifacts/transaction2");
    sharedKeypair = Keypair.generateNew(lightWasm);

    [owner, user, recipient] = await ethers.getSigners();

    // Deploy PoseidonT3 library
    const PoseidonT3Factory = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3Factory.deploy();
    const poseidonT3Address = await poseidonT3.getAddress();

    // Deploy contracts
    const VerifierFactory = await ethers.getContractFactory("Groth16Verifier");
    verifier = await VerifierFactory.deploy();

    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDCFactory.deploy();

    const PrivacyPoolFactory = await ethers.getContractFactory("PrivacyPool", {
      libraries: { PoseidonT3: poseidonT3Address },
    });
    pool = await PrivacyPoolFactory.deploy(
      await verifier.getAddress(),
      await usdc.getAddress(),
      1_000_000_000_000n
    );

    // Deploy MockYieldVault and configure
    const MockYieldVaultFactory = await ethers.getContractFactory("MockYieldVault");
    vault = await MockYieldVaultFactory.deploy(await usdc.getAddress());
    await pool.connect(owner).configureYield(await vault.getAddress());

    // Mint USDC to user
    await usdc.mint(user.address, 100_000_000n); // 100 USDC

    // Approve pool to spend user's USDC
    await usdc.connect(user).approve(await pool.getAddress(), ethers.MaxUint256);
  });

  // =====================================================
  // Test 1: Single-item batch (equivalent to transact())
  // =====================================================
  it("1. single-item batch — equivalent to transact()", async () => {
    const depositAmount = 1_000_000; // 1 USDC
    const tokenAddress = await usdc.getAddress();
    const poolAddress = await pool.getAddress();

    const inputs = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_single_enc1"),
      encryptedOutput2: Buffer.from("batch_single_enc2"),
      keyBasePath,
    });

    const params = formatTransactParams(proofResult);
    const userBalanceBefore = await usdc.balanceOf(user.address);

    await pool.connect(user).batchTransact([params]);

    for (const c of proofResult.outputCommitments) merkleTree.insert(c);

    const userBalanceAfter = await usdc.balanceOf(user.address);
    expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(depositAmount));

    // Auto-yield: USDC should be in vault
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);
    expect(await vault.balanceOf(poolAddress)).to.be.greaterThan(0n);
  });

  // =====================================================
  // Test 2: Multi-deposit batch — two deposits in one tx
  // =====================================================
  it("2. multi-deposit batch — two deposits in one tx", async () => {
    const deposit1 = 1_000_000;
    const deposit2 = 2_000_000;
    const tokenAddress = await usdc.getAddress();
    const poolAddress = await pool.getAddress();

    // Build first deposit proof
    const inputs1 = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs1 = [
      new Utxo({ lightWasm, amount: deposit1, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const result1 = await buildProofInput({
      inputs: inputs1, outputs: outputs1, tree: merkleTree,
      extAmount: new BN(deposit1), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_multi_d1_e1"),
      encryptedOutput2: Buffer.from("batch_multi_d1_e2"),
      keyBasePath,
    });

    // Insert into local tree for second proof (simulates sequential processing)
    for (const c of result1.outputCommitments) merkleTree.insert(c);

    // Build second deposit proof using updated tree
    const inputs2 = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs2 = [
      new Utxo({ lightWasm, amount: deposit2, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const result2 = await buildProofInput({
      inputs: inputs2, outputs: outputs2, tree: merkleTree,
      extAmount: new BN(deposit2), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_multi_d2_e1"),
      encryptedOutput2: Buffer.from("batch_multi_d2_e2"),
      keyBasePath,
    });

    for (const c of result2.outputCommitments) merkleTree.insert(c);

    const params1 = formatTransactParams(result1);
    const params2 = formatTransactParams(result2);

    const userBalanceBefore = await usdc.balanceOf(user.address);

    await pool.connect(user).batchTransact([params1, params2]);

    const userBalanceAfter = await usdc.balanceOf(user.address);
    expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(deposit1 + deposit2));

    // All USDC swept to vault
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);
  });

  // =====================================================
  // Test 3: Mixed batch — deposit then withdrawal
  // =====================================================
  it("3. mixed batch — deposit then withdrawal uses root from deposit's insertion", async () => {
    const depositAmount = 3_000_000;
    const withdrawAmount = 1_000_000;
    const tokenAddress = await usdc.getAddress();

    // Build deposit proof
    const depInputs = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const depOutputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const depResult = await buildProofInput({
      inputs: depInputs, outputs: depOutputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_mix_dep_e1"),
      encryptedOutput2: Buffer.from("batch_mix_dep_e2"),
      keyBasePath,
    });

    // Insert into local tree for withdrawal proof
    for (const c of depResult.outputCommitments) merkleTree.insert(c);

    // Build withdrawal proof using the newly inserted deposit UTXO
    const changeAmount = depositAmount - withdrawAmount;
    const wdInputs = [
      depOutputs[0],
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const wdOutputs = [
      new Utxo({ lightWasm, amount: changeAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const wdResult = await buildProofInput({
      inputs: wdInputs, outputs: wdOutputs, tree: merkleTree,
      extAmount: new BN(-withdrawAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_mix_wd_e1"),
      encryptedOutput2: Buffer.from("batch_mix_wd_e2"),
      keyBasePath,
    });

    for (const c of wdResult.outputCommitments) merkleTree.insert(c);

    const depParams = formatTransactParams(depResult);
    const wdParams = formatTransactParams(wdResult);

    const recipientBalanceBefore = await usdc.balanceOf(recipient.address);
    const userBalanceBefore = await usdc.balanceOf(user.address);

    await pool.connect(user).batchTransact([depParams, wdParams]);

    // User paid net: depositAmount - withdrawAmount (withdrawal goes to recipient)
    const userBalanceAfter = await usdc.balanceOf(user.address);
    expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(depositAmount));

    // Recipient received withdrawal
    const recipientBalanceAfter = await usdc.balanceOf(recipient.address);
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(BigInt(withdrawAmount));
  });

  // =====================================================
  // Test 4: Batch with auto-yield — USDC ends up in vault
  // =====================================================
  it("4. batch with auto-yield — USDC ends up in vault after batch", async () => {
    const depositAmount = 5_000_000;
    const tokenAddress = await usdc.getAddress();
    const poolAddress = await pool.getAddress();

    const inputs = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_yield_enc1"),
      encryptedOutput2: Buffer.from("batch_yield_enc2"),
      keyBasePath,
    });

    for (const c of proofResult.outputCommitments) merkleTree.insert(c);

    const params = formatTransactParams(proofResult);
    const yTokensBefore = await vault.balanceOf(poolAddress);

    await pool.connect(user).batchTransact([params]);

    // Pool USDC = 0 (swept to vault)
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);

    // yTokens increased
    const yTokensAfter = await vault.balanceOf(poolAddress);
    expect(yTokensAfter).to.be.greaterThan(yTokensBefore);
  });

  // =====================================================
  // Test 5: Batch with invalid proof — entire batch reverts
  // =====================================================
  it("5. batch with invalid proof — entire batch reverts", async () => {
    const depositAmount = 1_000_000;
    const tokenAddress = await usdc.getAddress();

    // Build a valid proof
    const inputs = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_bad_enc1"),
      encryptedOutput2: Buffer.from("batch_bad_enc2"),
      keyBasePath,
    });

    // Corrupt the proof
    proofResult.proof.a = [proofResult.proof.a[0] + 1n, proofResult.proof.a[1]];

    const params = formatTransactParams(proofResult);

    await expect(pool.connect(user).batchTransact([params])).to.be.reverted;
  });

  // =====================================================
  // Test 6: Empty batch — reverts
  // =====================================================
  it("6. empty batch — reverts with 'Empty batch'", async () => {
    await expect(
      pool.connect(user).batchTransact([])
    ).to.be.revertedWith("Empty batch");
  });

  // =====================================================
  // Test 7: Batch exceeding size limit — reverts
  // =====================================================
  it("7. batch exceeding size limit — reverts with 'Batch too large'", async () => {
    // Create 51 dummy params (won't get to proof verification)
    const depositAmount = 1_000_000;
    const tokenAddress = await usdc.getAddress();

    const inputs = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_limit_enc1"),
      encryptedOutput2: Buffer.from("batch_limit_enc2"),
      keyBasePath,
    });

    const params = formatTransactParams(proofResult);

    // Create array of 51 identical params
    const tooMany = Array(51).fill(params);

    await expect(
      pool.connect(user).batchTransact(tooMany)
    ).to.be.revertedWith("Batch too large");
  });

  // =====================================================
  // Test 8: Sequential root dependency — later proof uses root from earlier insertion
  // =====================================================
  it("8. sequential root dependency — second proof uses root created by first", async () => {
    const deposit1 = 1_000_000;
    const deposit2 = 500_000;
    const tokenAddress = await usdc.getAddress();

    // First deposit: uses current root
    const inputs1 = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs1 = [
      new Utxo({ lightWasm, amount: deposit1, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const result1 = await buildProofInput({
      inputs: inputs1, outputs: outputs1, tree: merkleTree,
      extAmount: new BN(deposit1), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_seq_d1_e1"),
      encryptedOutput2: Buffer.from("batch_seq_d1_e2"),
      keyBasePath,
    });

    // Insert first deposit's commitments to update local tree (simulates on-chain insertion)
    for (const c of result1.outputCommitments) merkleTree.insert(c);

    // Second deposit: uses root AFTER first deposit's insertion
    const inputs2 = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs2 = [
      new Utxo({ lightWasm, amount: deposit2, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const result2 = await buildProofInput({
      inputs: inputs2, outputs: outputs2, tree: merkleTree,
      extAmount: new BN(deposit2), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("batch_seq_d2_e1"),
      encryptedOutput2: Buffer.from("batch_seq_d2_e2"),
      keyBasePath,
    });

    for (const c of result2.outputCommitments) merkleTree.insert(c);

    const params1 = formatTransactParams(result1);
    const params2 = formatTransactParams(result2);

    // The second proof's root was computed AFTER the first insertion,
    // meaning it depends on the on-chain state created by the first item in the batch.
    // This verifies sequential processing works correctly.
    const userBalanceBefore = await usdc.balanceOf(user.address);

    await pool.connect(user).batchTransact([params1, params2]);

    const userBalanceAfter = await usdc.balanceOf(user.address);
    expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(deposit1 + deposit2));

    // Verify tree is consistent
    const onChainRoot = await pool.currentRoot();
    const localRoot = BigInt(merkleTree.root());
    expect(onChainRoot).to.equal(localRoot);
  });
});
