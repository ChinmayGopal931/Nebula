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

// ==================== Proof Builder (same as Phase 1) ====================

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

async function callTransact(
  pool: PrivacyPool,
  signer: HardhatEthersSigner,
  proofResult: Awaited<ReturnType<typeof buildProofInput>>
) {
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

  return pool.connect(signer).transact(
    proof.a, proof.b, proof.c,
    root, publicAmount, extDataHash,
    inputNullifiers, outputCommitments, extDataForContract,
  );
}

// ==================== Tests ====================

describe("Phase 2: Yield Vault Integration", () => {
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

  let depositUtxo: Utxo;

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

    // Deploy MockYieldVault
    const MockYieldVaultFactory = await ethers.getContractFactory("MockYieldVault");
    vault = await MockYieldVaultFactory.deploy(await usdc.getAddress());

    // Mint USDC to user
    await usdc.mint(user.address, 100_000_000n); // 100 USDC

    // Approve pool to spend user's USDC
    await usdc.connect(user).approve(await pool.getAddress(), ethers.MaxUint256);
  });

  // =====================================================
  // Test 1: configureYield stores vault address
  // =====================================================
  it("1. configureYield — stores vault address and approves", async () => {
    await pool.connect(owner).configureYield(await vault.getAddress());

    expect(await pool.yieldVault()).to.equal(await vault.getAddress());

    // Verify pool has approved vault
    const allowance = await usdc.allowance(await pool.getAddress(), await vault.getAddress());
    expect(allowance).to.equal(ethers.MaxUint256);
  });

  // =====================================================
  // Test 2: configureYield second call (owner can reconfigure)
  // =====================================================
  it("2. configureYield — non-owner reverts", async () => {
    await expect(
      pool.connect(user).configureYield(await vault.getAddress())
    ).to.be.revertedWith("Not owner");
  });

  // =====================================================
  // Test 3: yieldDeposit — deposits all pool USDC to vault
  // =====================================================
  it("3. yieldDeposit — deposits all pool USDC, receives yTokens", async () => {
    // Mint USDC directly to pool for testing
    await usdc.mint(await pool.getAddress(), 10_000_000n); // 10 USDC

    const poolAddress = await pool.getAddress();
    const poolBalanceBefore = await usdc.balanceOf(poolAddress);
    const yTokensBefore = await vault.balanceOf(poolAddress);

    expect(poolBalanceBefore).to.equal(10_000_000n);

    await pool.connect(owner).yieldDeposit();

    const poolBalanceAfter = await usdc.balanceOf(poolAddress);
    const yTokensAfter = await vault.balanceOf(poolAddress);

    // Pool USDC should be zero (deposited all)
    expect(poolBalanceAfter).to.equal(0n);

    // yTokens received (1:1 with mock)
    expect(yTokensAfter - yTokensBefore).to.equal(10_000_000n);
  });

  // =====================================================
  // Test 4: yieldRedeem — redeems all yTokens
  // =====================================================
  it("4. yieldRedeem — redeems all yTokens, receives USDC", async () => {
    const poolAddress = await pool.getAddress();
    const yTokensBefore = await vault.balanceOf(poolAddress);
    expect(yTokensBefore).to.be.greaterThan(0n);

    await pool.connect(owner).yieldRedeem();

    const yTokensAfter = await vault.balanceOf(poolAddress);
    const poolBalanceAfter = await usdc.balanceOf(poolAddress);

    expect(yTokensAfter).to.equal(0n);
    expect(poolBalanceAfter).to.equal(10_000_000n);
  });

  // =====================================================
  // Test 5: yieldDeposit no-op when pool balance is zero
  // =====================================================
  it("5. yieldDeposit — no-op when pool balance is zero", async () => {
    // Deposit all first
    const poolAddress = await pool.getAddress();
    if ((await usdc.balanceOf(poolAddress)) > 0n) {
      await pool.yieldDeposit();
    }

    // Now pool is empty
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);

    // This should succeed as no-op
    await pool.yieldDeposit();
  });

  // =====================================================
  // Test 6: yieldRedeem no-op when yTokens are zero
  // =====================================================
  it("6. yieldRedeem — no-op when yTokens are zero", async () => {
    const poolAddress = await pool.getAddress();

    // Redeem any remaining
    if ((await vault.balanceOf(poolAddress)) > 0n) {
      await pool.yieldRedeem();
    }

    expect(await vault.balanceOf(poolAddress)).to.equal(0n);

    // This should succeed as no-op
    await pool.yieldRedeem();
  });

  // =====================================================
  // Test 7: Permissionless — any account can call yieldDeposit/yieldRedeem
  // =====================================================
  it("7. permissionless — random account calls yieldDeposit/yieldRedeem", async () => {
    const poolAddress = await pool.getAddress();

    // Mint USDC to pool
    const poolBalanceBefore = await usdc.balanceOf(poolAddress);
    await usdc.mint(poolAddress, 5_000_000n); // 5 USDC
    const totalBalance = poolBalanceBefore + 5_000_000n;

    // Random signer (not owner) calls yieldDeposit
    await pool.connect(user).yieldDeposit();

    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);

    // Random signer calls yieldRedeem
    await pool.connect(user).yieldRedeem();

    expect(await vault.balanceOf(poolAddress)).to.equal(0n);
    expect(await usdc.balanceOf(poolAddress)).to.equal(totalBalance);
  });

  // =====================================================
  // Test 8: Auto-yield deposit — transact auto-sweeps to vault
  // =====================================================
  it("8. auto-yield deposit — transact auto-sweeps USDC to vault", async () => {
    // Clean state: redeem any remaining
    const poolAddress = await pool.getAddress();
    if ((await vault.balanceOf(poolAddress)) > 0n) {
      await pool.yieldRedeem();
    }
    if ((await usdc.balanceOf(poolAddress)) > 0n) {
      await pool.yieldDeposit();
    }

    const depositAmount = 1_000_000; // 1 USDC
    const tokenAddress = await usdc.getAddress();
    const yTokensBefore = await vault.balanceOf(poolAddress);

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
      encryptedOutput1: Buffer.from("bundle_deposit_enc1"),
      encryptedOutput2: Buffer.from("bundle_deposit_enc2"),
      keyBasePath,
    });

    // transact() auto-sweeps to vault — no manual yieldDeposit needed
    await (await callTransact(pool, user, proofResult)).wait();

    for (const c of proofResult.outputCommitments) merkleTree.insert(c);
    depositUtxo = outputs[0];

    // Verify: pool USDC should be 0 (auto-swept), yTokens increased
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);
    const yTokensAfter = await vault.balanceOf(poolAddress);
    expect(yTokensAfter).to.be.greaterThan(yTokensBefore);
  });

  // =====================================================
  // Test 9: Auto-yield withdrawal — transact auto-redeems from vault
  // =====================================================
  it("9. auto-yield withdrawal — transact auto-redeems then sweeps remainder", async () => {
    const withdrawAmount = 500_000; // 0.5 USDC
    const tokenAddress = await usdc.getAddress();
    const poolAddress = await pool.getAddress();
    const recipientBalanceBefore = await usdc.balanceOf(recipient.address);

    // Confirm USDC is in vault (from test 8 auto-sweep)
    expect(await vault.balanceOf(poolAddress)).to.be.greaterThan(0n);
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);

    const changeAmount = depositUtxo.amount.toNumber() - withdrawAmount;
    const inputs = [
      depositUtxo,
      new Utxo({ lightWasm, tokenAddress }),
    ];
    const outputs = [
      new Utxo({ lightWasm, amount: changeAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const proofResult = await buildProofInput({
      inputs, outputs, tree: merkleTree,
      extAmount: new BN(-withdrawAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("bundle_withdraw_enc1"),
      encryptedOutput2: Buffer.from("bundle_withdraw_enc2"),
      keyBasePath,
    });

    // transact() auto-redeems from vault and auto-sweeps remainder — no manual calls
    await (await callTransact(pool, user, proofResult)).wait();

    for (const c of proofResult.outputCommitments) merkleTree.insert(c);

    // Verify recipient received USDC
    const recipientBalanceAfter = await usdc.balanceOf(recipient.address);
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(BigInt(withdrawAmount));

    // Pool USDC should be 0 (remainder swept back to vault)
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);
    // Remaining USDC (change) should be in vault as yTokens
    expect(await vault.balanceOf(poolAddress)).to.be.greaterThan(0n);
  });

  // =====================================================
  // Test 10: Round-trip — auto-yield deposit → auto-yield withdrawal
  // =====================================================
  it("10. round-trip — auto-yield handles deposit and withdrawal", async () => {
    const depositAmount = 2_000_000; // 2 USDC
    const tokenAddress = await usdc.getAddress();
    const poolAddress = await pool.getAddress();

    const userBalanceBefore = await usdc.balanceOf(user.address);
    const recipientBalanceBefore = await usdc.balanceOf(recipient.address);
    const yTokensBeforeRoundTrip = await vault.balanceOf(poolAddress);

    // === Deposit (auto-sweeps to vault) ===
    const depInputs = [new Utxo({ lightWasm, tokenAddress }), new Utxo({ lightWasm, tokenAddress })];
    const depOutputs = [
      new Utxo({ lightWasm, amount: depositAmount, keypair: sharedKeypair, index: merkleTree._layers[0].length, tokenAddress }),
      new Utxo({ lightWasm, amount: 0, tokenAddress }),
    ];

    const depResult = await buildProofInput({
      inputs: depInputs, outputs: depOutputs, tree: merkleTree,
      extAmount: new BN(depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("roundtrip_dep_enc1"),
      encryptedOutput2: Buffer.from("roundtrip_dep_enc2"),
      keyBasePath,
    });

    // No manual yieldDeposit — transact auto-sweeps
    await (await callTransact(pool, user, depResult)).wait();

    for (const c of depResult.outputCommitments) merkleTree.insert(c);
    const roundTripUtxo = depOutputs[0];

    // Verify: user paid, USDC in vault (auto-swept)
    const userBalanceAfterDeposit = await usdc.balanceOf(user.address);
    expect(userBalanceBefore - userBalanceAfterDeposit).to.equal(BigInt(depositAmount));
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);
    const yTokensAfterDeposit = await vault.balanceOf(poolAddress);
    expect(yTokensAfterDeposit - yTokensBeforeRoundTrip).to.equal(BigInt(depositAmount));

    // === Withdrawal (auto-redeems from vault) ===
    const wdInputs = [roundTripUtxo, new Utxo({ lightWasm, tokenAddress })];
    const wdOutputs = [new Utxo({ lightWasm, amount: 0, tokenAddress }), new Utxo({ lightWasm, amount: 0, tokenAddress })];

    const wdResult = await buildProofInput({
      inputs: wdInputs, outputs: wdOutputs, tree: merkleTree,
      extAmount: new BN(-depositAmount), fee: new BN(0),
      recipient: recipient.address, feeRecipient: user.address, tokenAddress,
      encryptedOutput1: Buffer.from("roundtrip_wd_enc1"),
      encryptedOutput2: Buffer.from("roundtrip_wd_enc2"),
      keyBasePath,
    });

    // No manual yieldRedeem — transact auto-redeems
    await (await callTransact(pool, user, wdResult)).wait();

    for (const c of wdResult.outputCommitments) merkleTree.insert(c);

    // Verify recipient received full amount
    const recipientBalanceAfter = await usdc.balanceOf(recipient.address);
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(BigInt(depositAmount));

    // Pool USDC should be 0 (remainder swept back to vault)
    expect(await usdc.balanceOf(poolAddress)).to.equal(0n);
    // Vault balance should be back to pre-round-trip level (deposited then fully withdrawn)
    const yTokensAfterRoundTrip = await vault.balanceOf(poolAddress);
    expect(yTokensAfterRoundTrip).to.equal(yTokensBeforeRoundTrip);
  });

  // TODO: devnet tests deferred
});
