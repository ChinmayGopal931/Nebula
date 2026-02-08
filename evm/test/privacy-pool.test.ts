import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import * as path from "path";
import BN from "bn.js";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";

import { PrivacyPool, MockUSDC, Groth16Verifier } from "../typechain-types";
import { DEFAULT_HEIGHT, FIELD_SIZE, ROOT_HISTORY_SIZE, ZERO_BYTES } from "./lib/constants";
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
    tokenAddress,
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

  return {
    proof: solidityProof,
    publicSignals,
    extData,
    outputCommitments,
    inputNullifiers,
  };
}

// ==================== Helper to call transact ====================

async function callTransact(
  pool: PrivacyPool,
  signer: HardhatEthersSigner,
  proofResult: Awaited<ReturnType<typeof buildProofInput>>
) {
  const { proof, publicSignals, extData } = proofResult;

  // Public signals order: [root, publicAmount, extDataHash, null0, null1, comm0, comm1]
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

  return pool.connect(signer).transact(
    proof.a,
    proof.b,
    proof.c,
    root,
    publicAmount,
    extDataHash,
    inputNullifiers,
    outputCommitments,
    extDataForContract,
  );
}

// ==================== Tests ====================

describe("Privacy Pool (Phase 1)", () => {
  let lightWasm: LightWasm;
  let pool: PrivacyPool;
  let usdc: MockUSDC;
  let verifier: Groth16Verifier;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  let merkleTree: MerkleTree;
  let keyBasePath: string;
  let sharedKeypair: Keypair;

  // Track UTXOs across tests
  let depositUtxo: Utxo;
  let depositUtxo2: Utxo;
  let changeUtxo: Utxo;
  let mergedUtxo: Utxo;

  before(async () => {
    lightWasm = await WasmFactory.getInstance();
    merkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
    keyBasePath = path.resolve(__dirname, "../../artifacts/transaction2");
    sharedKeypair = Keypair.generateNew(lightWasm);

    [owner, user, recipient] = await ethers.getSigners();

    // Deploy PoseidonT3 library first
    const PoseidonT3Factory = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3Factory.deploy();
    const poseidonT3Address = await poseidonT3.getAddress();

    // Deploy contracts
    const VerifierFactory = await ethers.getContractFactory("Groth16Verifier");
    verifier = await VerifierFactory.deploy();

    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDCFactory.deploy();

    const PrivacyPoolFactory = await ethers.getContractFactory("PrivacyPool", {
      libraries: {
        PoseidonT3: poseidonT3Address,
      },
    });
    const maxDeposit = 1_000_000_000_000n; // 1M USDC
    pool = await PrivacyPoolFactory.deploy(
      await verifier.getAddress(),
      await usdc.getAddress(),
      maxDeposit
    );

    // Mint USDC to user
    await usdc.mint(user.address, 100_000_000n); // 100 USDC

    // Approve pool to spend user's USDC
    await usdc.connect(user).approve(await pool.getAddress(), ethers.MaxUint256);
  });

  // ==================== Test 1: Initialize ====================
  it("1. Initialize — verify tree state, pool config, zero root", async () => {
    const root = await pool.currentRoot();
    const nextIndex = await pool.nextIndex();

    // Verify the on-chain root matches our expected empty tree root
    expect(nextIndex).to.equal(0n);

    // Check root matches local tree
    const expectedRoot = BigInt(merkleTree.root());
    expect(root).to.equal(expectedRoot);

    // Verify root history
    const rootInHistory = await pool.rootHistory(0);
    expect(rootInHistory).to.equal(expectedRoot);
  });

  // ==================== Test 2: Deposit ====================
  it("2. Deposit — 1 USDC, verify balances and tree update", async () => {
    const depositAmount = 1_000_000; // 1 USDC
    const tokenAddress = await usdc.getAddress();

    const inputs = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const encryptedOutput1 = Buffer.from("deposit1_enc_output1");
    const encryptedOutput2 = Buffer.from("deposit1_enc_output2");

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount),
      fee: new BN(0),
      recipient: recipient.address,
      feeRecipient: user.address,
      tokenAddress,
      encryptedOutput1, encryptedOutput2,
      keyBasePath,
    });

    const userBalanceBefore = await usdc.balanceOf(user.address);

    const tx = await callTransact(pool, user, proofResult);
    await tx.wait();

    // Verify balance changed
    const userBalanceAfter = await usdc.balanceOf(user.address);
    expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(depositAmount));

    // Update local tree
    for (const commitment of proofResult.outputCommitments) {
      merkleTree.insert(commitment);
    }

    // Verify on-chain tree updated
    expect(await pool.nextIndex()).to.equal(2n);

    depositUtxo = outputs[0];
  });

  // ==================== Test 3: Full Withdrawal ====================
  it("3. Full withdrawal — spend deposit UTXO, verify recipient gets USDC", async () => {
    const withdrawAmount = 1_000_000;
    const tokenAddress = await usdc.getAddress();

    const inputs = [
      depositUtxo,
      new Utxo({ lightWasm, tokenAddress }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(-withdrawAmount),
      fee: new BN(0),
      recipient: recipient.address,
      feeRecipient: user.address,
      tokenAddress,
      encryptedOutput1: Buffer.from("withdraw_enc_output1"),
      encryptedOutput2: Buffer.from("withdraw_enc_output2"),
      keyBasePath,
    });

    const recipientBalanceBefore = await usdc.balanceOf(recipient.address);

    const tx = await callTransact(pool, user, proofResult);
    await tx.wait();

    const recipientBalanceAfter = await usdc.balanceOf(recipient.address);
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(BigInt(withdrawAmount));

    for (const commitment of proofResult.outputCommitments) {
      merkleTree.insert(commitment);
    }
  });

  // ==================== Test 4: Partial Withdrawal ====================
  it("4. Partial withdrawal — deposit 2 USDC, withdraw 0.5, verify change UTXO", async () => {
    const depositAmount = 2_000_000;
    const tokenAddress = await usdc.getAddress();

    // Deposit 2 USDC
    const depositInputs = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];

    const depositOutputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const depositResult = await buildProofInput({
      inputs: depositInputs, outputs: depositOutputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("partial_deposit_enc1"),
      encryptedOutput2: Buffer.from("partial_deposit_enc2"),
      keyBasePath,
    });

    await (await callTransact(pool, user, depositResult)).wait();
    for (const c of depositResult.outputCommitments) merkleTree.insert(c);

    // Withdraw 0.5 USDC
    const withdrawAmount = 500_000;
    const changeAmount = depositAmount - withdrawAmount;

    const withdrawInputs = [
      depositOutputs[0],
      new Utxo({ lightWasm, tokenAddress }),
    ];

    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: changeAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const withdrawResult = await buildProofInput({
      inputs: withdrawInputs, outputs: withdrawOutputs, tree: merkleTree,
      extAmount: new BN(-withdrawAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("partial_withdraw_enc1"),
      encryptedOutput2: Buffer.from("partial_withdraw_enc2"),
      keyBasePath,
    });

    const recipientBalanceBefore = await usdc.balanceOf(recipient.address);
    await (await callTransact(pool, user, withdrawResult)).wait();
    const recipientBalanceAfter = await usdc.balanceOf(recipient.address);
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(BigInt(withdrawAmount));

    for (const c of withdrawResult.outputCommitments) merkleTree.insert(c);
    changeUtxo = withdrawOutputs[0];
  });

  // ==================== Test 5: Spend Change UTXO ====================
  it("5. Spend change UTXO — withdraw remaining 1.5 USDC", async () => {
    const withdrawAmount = 1_500_000;
    const tokenAddress = await usdc.getAddress();

    const inputs = [
      changeUtxo,
      new Utxo({ lightWasm, tokenAddress }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(-withdrawAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("change_withdraw_enc1"),
      encryptedOutput2: Buffer.from("change_withdraw_enc2"),
      keyBasePath,
    });

    const recipientBalanceBefore = await usdc.balanceOf(recipient.address);
    await (await callTransact(pool, user, proofResult)).wait();
    const recipientBalanceAfter = await usdc.balanceOf(recipient.address);
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(BigInt(withdrawAmount));

    for (const c of proofResult.outputCommitments) merkleTree.insert(c);
  });

  // ==================== Test 6: Merge ====================
  it("6. Merge — deposit twice, merge into one UTXO", async () => {
    const tokenAddress = await usdc.getAddress();

    // Deposit 1 USDC (first)
    const deposit1Amount = 1_000_000;
    const d1Inputs = [new Utxo({ lightWasm, tokenAddress }), new Utxo({ lightWasm, tokenAddress })];
    const d1Outputs = [
      new Utxo({ lightWasm, amount: deposit1Amount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const d1Result = await buildProofInput({
      inputs: d1Inputs, outputs: d1Outputs, tree: merkleTree,
      extAmount: new BN(deposit1Amount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("merge_dep1_enc1"),
      encryptedOutput2: Buffer.from("merge_dep1_enc2"),
      keyBasePath,
    });
    await (await callTransact(pool, user, d1Result)).wait();
    for (const c of d1Result.outputCommitments) merkleTree.insert(c);

    // Deposit 1 USDC (second)
    const deposit2Amount = 1_000_000;
    const d2Inputs = [new Utxo({ lightWasm, tokenAddress }), new Utxo({ lightWasm, tokenAddress })];
    const d2Outputs = [
      new Utxo({ lightWasm, amount: deposit2Amount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const d2Result = await buildProofInput({
      inputs: d2Inputs, outputs: d2Outputs, tree: merkleTree,
      extAmount: new BN(deposit2Amount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("merge_dep2_enc1"),
      encryptedOutput2: Buffer.from("merge_dep2_enc2"),
      keyBasePath,
    });
    await (await callTransact(pool, user, d2Result)).wait();
    for (const c of d2Result.outputCommitments) merkleTree.insert(c);

    // Merge: ext_amount=0, no token transfer
    const mergedAmount = deposit1Amount + deposit2Amount;
    const mergeInputs = [d1Outputs[0], d2Outputs[0]];
    const mergeOutputs = [
      new Utxo({ lightWasm, amount: mergedAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const mergeResult = await buildProofInput({
      inputs: mergeInputs, outputs: mergeOutputs, tree: merkleTree,
      extAmount: new BN(0), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("merge_enc1"),
      encryptedOutput2: Buffer.from("merge_enc2"),
      keyBasePath,
    });

    const userBalanceBefore = await usdc.balanceOf(user.address);
    await (await callTransact(pool, user, mergeResult)).wait();
    const userBalanceAfter = await usdc.balanceOf(user.address);
    expect(userBalanceAfter).to.equal(userBalanceBefore); // No change

    for (const c of mergeResult.outputCommitments) merkleTree.insert(c);
    mergedUtxo = mergeOutputs[0];
  });

  // ==================== Test 7: Double-spend Rejection ====================
  it("7. Double-spend rejection — reuse spent UTXO fails", async () => {
    const tokenAddress = await usdc.getAddress();

    const inputs = [
      depositUtxo, // Already spent in test 3!
      new Utxo({ lightWasm, tokenAddress }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(-1_000_000), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("doublespend_enc1"),
      encryptedOutput2: Buffer.from("doublespend_enc2"),
      keyBasePath,
    });

    await expect(callTransact(pool, user, proofResult)).to.be.revertedWithCustomError(pool, "AlreadySpent");
  });

  // ==================== Test 8: Invalid Proof Rejection ====================
  it("8. Invalid proof rejection — corrupt proof bytes fails", async () => {
    const depositAmount = 500_000;
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
      encryptedOutput1: Buffer.from("invalid_proof_enc1"),
      encryptedOutput2: Buffer.from("invalid_proof_enc2"),
      keyBasePath,
    });

    // Corrupt the proof
    proofResult.proof.a = [proofResult.proof.a[0] + 1n, proofResult.proof.a[1]];

    await expect(callTransact(pool, user, proofResult)).to.be.reverted;
  });

  // ==================== Test 9: Wrong Root Rejection ====================
  it("9. Wrong root rejection — fabricated root fails", async () => {
    const depositAmount = 500_000;
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
      encryptedOutput1: Buffer.from("wrong_root_enc1"),
      encryptedOutput2: Buffer.from("wrong_root_enc2"),
      keyBasePath,
    });

    // Replace root with fabricated value
    proofResult.publicSignals[0] = "12345";

    await expect(callTransact(pool, user, proofResult)).to.be.revertedWithCustomError(pool, "UnknownRoot");
  });

  // ==================== Test 10: Deposit with Consolidation ====================
  it("10. Deposit with consolidation — deposit while spending existing UTXO", async () => {
    const additionalDeposit = 1_000_000;
    const tokenAddress = await usdc.getAddress();
    const existingAmount = mergedUtxo.amount.toNumber();
    const totalAmount = existingAmount + additionalDeposit;

    const inputs = [
      mergedUtxo,
      new Utxo({ lightWasm, tokenAddress }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: totalAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(additionalDeposit),
      fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("consolidation_enc1"),
      encryptedOutput2: Buffer.from("consolidation_enc2"),
      keyBasePath,
    });

    const userBalanceBefore = await usdc.balanceOf(user.address);
    await (await callTransact(pool, user, proofResult)).wait();
    const userBalanceAfter = await usdc.balanceOf(user.address);
    expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(additionalDeposit));

    for (const c of proofResult.outputCommitments) merkleTree.insert(c);
  });

  // ==================== Test 11: Event Emission Verification ====================
  it("11. Event emission — verify NewCommitment events on deposit", async () => {
    const depositAmount = 500_000;
    const tokenAddress = await usdc.getAddress();

    const inputs = [
      new Utxo({ lightWasm, tokenAddress }),
      new Utxo({ lightWasm, tokenAddress }),
    ];

    const outputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const encryptedOutput1 = Buffer.from("event_test_enc1");
    const encryptedOutput2 = Buffer.from("event_test_enc2");

    const treeLeafCountBefore = merkleTree._layers[0].length;

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1, encryptedOutput2,
      keyBasePath,
    });

    const tx = await callTransact(pool, user, proofResult);
    const receipt = await tx.wait();

    // Update local tree
    for (const c of proofResult.outputCommitments) merkleTree.insert(c);

    // Check events
    const commitmentEvents = receipt!.logs.filter(
      (log) => {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "NewCommitment";
        } catch {
          return false;
        }
      }
    );

    expect(commitmentEvents.length).to.equal(2);

    const event0 = pool.interface.parseLog({ topics: commitmentEvents[0].topics as string[], data: commitmentEvents[0].data })!;
    const event1 = pool.interface.parseLog({ topics: commitmentEvents[1].topics as string[], data: commitmentEvents[1].data })!;

    expect(event0.args.index).to.equal(BigInt(treeLeafCountBefore));
    expect(event1.args.index).to.equal(BigInt(treeLeafCountBefore + 1));

    expect(ethers.hexlify(event0.args.encryptedOutput)).to.equal(ethers.hexlify(encryptedOutput1));
    expect(ethers.hexlify(event1.args.encryptedOutput)).to.equal(ethers.hexlify(encryptedOutput2));
  });

  // ==================== Test 12: Tampered ExtAmount Rejection ====================
  it("12. Tampered extAmount — modified amount after proof fails", async () => {
    const depositAmount = 500_000;
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
      encryptedOutput1: Buffer.from("tamper_amt_enc1"),
      encryptedOutput2: Buffer.from("tamper_amt_enc2"),
      keyBasePath,
    });

    // Tamper: double the ext_amount
    proofResult.extData.extAmount = new BN(depositAmount * 2);

    await expect(callTransact(pool, user, proofResult)).to.be.reverted;
  });

  // ==================== Test 13: Cross-Check Double-Spend (Position-Swap) ====================
  it("13. Cross-check double-spend — position-swap attack caught", async () => {
    const amount = 1_000_000;
    const tokenAddress = await usdc.getAddress();
    const attackKeypair = Keypair.generateNew(lightWasm);

    // Deposit to create a UTXO
    const dInputs = [new Utxo({ lightWasm, tokenAddress }), new Utxo({ lightWasm, tokenAddress })];
    const dOutputs = [
      new Utxo({ lightWasm, amount, keypair: attackKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const dResult = await buildProofInput({
      inputs: dInputs, outputs: dOutputs, tree: merkleTree,
      extAmount: new BN(amount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("xchk_dep_e1"),
      encryptedOutput2: Buffer.from("xchk_dep_e2"),
      keyBasePath,
    });
    await (await callTransact(pool, user, dResult)).wait();
    for (const c of dResult.outputCommitments) merkleTree.insert(c);

    const targetUtxo = dOutputs[0];

    // Withdraw normally (target in input[0])
    const w1Inputs = [targetUtxo, new Utxo({ lightWasm, tokenAddress })];
    const w1Outputs = [new Utxo({ lightWasm, amount: 0, tokenAddress }), new Utxo({ lightWasm, amount: 0, tokenAddress })];

    const w1Result = await buildProofInput({
      inputs: w1Inputs, outputs: w1Outputs, tree: merkleTree,
      extAmount: new BN(-amount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("xchk_w1_e1"),
      encryptedOutput2: Buffer.from("xchk_w1_e2"),
      keyBasePath,
    });
    await (await callTransact(pool, user, w1Result)).wait();
    for (const c of w1Result.outputCommitments) merkleTree.insert(c);

    // Attack: same UTXO in input[1] (swapped position)
    // On EVM, this is caught by the single mapping — same nullifier value regardless of position
    const w2Inputs = [new Utxo({ lightWasm, tokenAddress }), targetUtxo];
    const w2Outputs = [new Utxo({ lightWasm, amount: 0, tokenAddress }), new Utxo({ lightWasm, amount: 0, tokenAddress })];

    const w2Result = await buildProofInput({
      inputs: w2Inputs, outputs: w2Outputs, tree: merkleTree,
      extAmount: new BN(-amount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("xchk_w2_e1"),
      encryptedOutput2: Buffer.from("xchk_w2_e2"),
      keyBasePath,
    });

    // Should fail — the nullifier for targetUtxo is already in the mapping
    await expect(callTransact(pool, user, w2Result)).to.be.revertedWithCustomError(pool, "AlreadySpent");
  });

  // ==================== Test 14: Two-Output Split ====================
  it("14. Two-output split — split UTXO into two non-zero outputs then spend one", async () => {
    const totalAmount = 3_000_000;
    const tokenAddress = await usdc.getAddress();
    const splitKeypair = Keypair.generateNew(lightWasm);

    // Deposit 3 USDC
    const dInputs = [new Utxo({ lightWasm, tokenAddress }), new Utxo({ lightWasm, tokenAddress })];
    const dOutputs = [
      new Utxo({ lightWasm, amount: totalAmount, keypair: splitKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];
    const dResult = await buildProofInput({
      inputs: dInputs, outputs: dOutputs, tree: merkleTree,
      extAmount: new BN(totalAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("split_dep_e1"),
      encryptedOutput2: Buffer.from("split_dep_e2"),
      keyBasePath,
    });
    await (await callTransact(pool, user, dResult)).wait();
    for (const c of dResult.outputCommitments) merkleTree.insert(c);

    // Split: 3 USDC → 1 + 2 (ext_amount=0)
    const split1Amount = 1_000_000;
    const split2Amount = 2_000_000;

    const splitInputs = [dOutputs[0], new Utxo({ lightWasm, tokenAddress })];
    const splitOutputs = [
      new Utxo({ lightWasm, amount: split1Amount, keypair: splitKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: split2Amount, keypair: splitKeypair, index: merkleTree._layers[0].length + 1, tokenAddress }),
    ];

    const splitResult = await buildProofInput({
      inputs: splitInputs, outputs: splitOutputs, tree: merkleTree,
      extAmount: new BN(0), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("split_s_e1"),
      encryptedOutput2: Buffer.from("split_s_e2"),
      keyBasePath,
    });

    const userBalBefore = await usdc.balanceOf(user.address);
    await (await callTransact(pool, user, splitResult)).wait();
    const userBalAfter = await usdc.balanceOf(user.address);
    expect(userBalAfter).to.equal(userBalBefore); // No balance change

    for (const c of splitResult.outputCommitments) merkleTree.insert(c);

    // Withdraw the 1 USDC split output
    const wInputs = [splitOutputs[0], new Utxo({ lightWasm, tokenAddress })];
    const wOutputs = [new Utxo({ lightWasm, amount: 0, tokenAddress }), new Utxo({ lightWasm, amount: 0, tokenAddress })];

    const wResult = await buildProofInput({
      inputs: wInputs, outputs: wOutputs, tree: merkleTree,
      extAmount: new BN(-split1Amount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("split_w_e1"),
      encryptedOutput2: Buffer.from("split_w_e2"),
      keyBasePath,
    });

    const recipBefore = await usdc.balanceOf(recipient.address);
    await (await callTransact(pool, user, wResult)).wait();
    const recipAfter = await usdc.balanceOf(recipient.address);
    expect(recipAfter - recipBefore).to.equal(BigInt(split1Amount));

    for (const c of wResult.outputCommitments) merkleTree.insert(c);
  });

  // ==================== Test 15: Re-Initialization Prevention ====================
  it("15. Re-initialization — not applicable (constructor only runs once)", async () => {
    // On EVM, constructor runs exactly once at deployment.
    // There's no re-init vector. Verify the contract state hasn't changed.
    const root = await pool.currentRoot();
    expect(root).to.not.equal(0n);

    // Verify nextIndex > 0 (we've done many operations)
    const nextIndex = await pool.nextIndex();
    expect(nextIndex).to.be.greaterThan(0n);
  });

  // ==================== Test 16: Tampered Encrypted Output ====================
  it("16. Tampered encrypted output — modified after proof fails", async () => {
    const depositAmount = 500_000;
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
      encryptedOutput1: Buffer.from("real_enc_data_1"),
      encryptedOutput2: Buffer.from("real_enc_data_2"),
      keyBasePath,
    });

    // Tamper: modify encrypted output
    proofResult.extData.encryptedOutput1 = Buffer.from("TAMPERED_OUTPUT_DATA_XXXXX");

    await expect(callTransact(pool, user, proofResult)).to.be.revertedWithCustomError(pool, "ExtDataHashMismatch");
  });

  // ==================== Test 17: Root Consistency ====================
  it("17. Root consistency — on-chain root matches local tree after all operations", async () => {
    const onChainRoot = await pool.currentRoot();
    const localRoot = BigInt(merkleTree.root());

    expect(onChainRoot).to.equal(localRoot);

    // Verify nextIndex matches local tree leaf count
    const onChainNextIndex = await pool.nextIndex();
    expect(onChainNextIndex).to.equal(BigInt(merkleTree._layers[0].length));

    // Verify current root is in root history
    const currentRootIndex = await pool.rootIndex();
    const rootInHistory = await pool.rootHistory(currentRootIndex);
    expect(rootInHistory).to.equal(localRoot);
  });
});
