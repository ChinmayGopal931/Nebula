import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import BN from "bn.js";
import { WasmFactory, LightWasm } from "@lightprotocol/hasher.rs";

import { Keypair } from "../test/lib/keypair";
import { Utxo } from "../test/lib/utxo";
import { MerkleTree } from "../test/lib/merkle_tree";
import { prove, parseProofForSolidity } from "../test/lib/prover";
import {
  getExtDataHash,
  getMintAddressField,
  toPublicAmount,
} from "../test/lib/utils";
import { DEFAULT_HEIGHT } from "../test/lib/constants";

// ==================== Config ====================

const TOTAL_DEPOSITS = 200;
const DEPOSIT_AMOUNT = 1_000_000; // 1 USDC (6 decimals)
const STATS_INTERVAL = 10;
const KEY_BASE_PATH = path.resolve(
  __dirname,
  "../../artifacts/transaction2"
);

// ==================== Types ====================

interface ProgressData {
  completedTxs: number;
  commitments: string[];
  gasResults: { txIndex: number; gasUsed: number; txHash: string }[];
  keypairPrivkey: string;
}

// ==================== Helpers ====================

function loadDeployment() {
  const deploymentPath = path.resolve(
    __dirname,
    "../deployments/megaeth-testnet.json"
  );
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      `Deployment not found at ${deploymentPath}. Run yarn deploy:megaeth first.`
    );
  }
  return JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
}

function loadProgress(): ProgressData | null {
  const progressPath = path.resolve(
    __dirname,
    "../deployments/stress-test-progress.json"
  );
  if (fs.existsSync(progressPath)) {
    return JSON.parse(fs.readFileSync(progressPath, "utf-8"));
  }
  return null;
}

function saveProgress(data: ProgressData) {
  const progressPath = path.resolve(
    __dirname,
    "../deployments/stress-test-progress.json"
  );
  fs.writeFileSync(progressPath, JSON.stringify(data, null, 2));
}

function loadPoolAbi(): any[] {
  // Load from Hardhat compilation artifacts
  const artifactPath = path.resolve(
    __dirname,
    "../artifacts/contracts/PrivacyPool.sol/PrivacyPool.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `PrivacyPool artifact not found. Run yarn compile first.`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  return artifact.abi;
}

async function buildDepositProof(params: {
  lightWasm: LightWasm;
  tree: MerkleTree;
  keypair: Keypair;
  depositAmount: number;
  recipientAddress: string;
  tokenAddress: string;
}) {
  const { lightWasm, tree, keypair, depositAmount, recipientAddress, tokenAddress } =
    params;

  const extAmount = new BN(depositAmount);

  // Inputs: 2 zero UTXOs (fresh deposit)
  const input0 = new Utxo({ lightWasm, keypair, tokenAddress });
  const input1 = new Utxo({ lightWasm, keypair, tokenAddress });

  // Outputs: deposit amount + zero change
  const output0 = new Utxo({
    lightWasm,
    amount: depositAmount,
    keypair,
    tokenAddress,
  });
  const output1 = new Utxo({ lightWasm, keypair, tokenAddress });

  const inputs = [input0, input1];
  const outputs = [output0, output1];

  const mintAddressField = getMintAddressField(tokenAddress);

  // Build Merkle paths (zeros for empty inputs)
  const inputMerklePathIndices = [0, 0];
  const inputMerklePathElements = [
    new Array(tree.levels).fill(0),
    new Array(tree.levels).fill(0),
  ];

  const inputNullifiers = await Promise.all(inputs.map((x) => x.getNullifier()));
  const outputCommitments = await Promise.all(
    outputs.map((x) => x.getCommitment())
  );

  const root = tree.root();

  // Encrypted outputs (dummy bytes for stress test)
  const encryptedOutput1 = Buffer.alloc(68, 0xaa);
  const encryptedOutput2 = Buffer.alloc(68, 0xbb);

  const fee = new BN(0);
  const feeRecipient = recipientAddress;

  const extData = {
    recipient: recipientAddress,
    extAmount,
    encryptedOutput1,
    encryptedOutput2,
    fee,
    feeRecipient,
    tokenAddress,
  };

  const extDataHash = getExtDataHash(extData);
  const publicAmount = toPublicAmount(extAmount);

  const circuitInput = {
    root,
    publicAmount,
    extDataHash,
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

  const { proof, publicSignals } = await prove(circuitInput, KEY_BASE_PATH);
  const solidityProof = parseProofForSolidity(proof);

  return {
    proof: solidityProof,
    publicSignals,
    extData,
    outputCommitments,
  };
}

function formatCalldata(proofResult: any) {
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
    extDataForContract,
  };
}

function printStats(gasResults: { txIndex: number; gasUsed: number }[]) {
  if (gasResults.length === 0) return;

  const windowSize = 50;
  console.log("\n--- Gas Stats ---");
  console.log(`Total txs: ${gasResults.length}`);
  console.log(
    `Latest gas: ${gasResults[gasResults.length - 1].gasUsed.toLocaleString()}`
  );

  // Window averages
  for (
    let start = 0;
    start < gasResults.length;
    start += windowSize
  ) {
    const end = Math.min(start + windowSize, gasResults.length);
    const window = gasResults.slice(start, end);
    const avg =
      window.reduce((sum, r) => sum + r.gasUsed, 0) / window.length;
    console.log(
      `  Txs ${start}-${end - 1}: avg ${Math.round(avg).toLocaleString()} gas (${window.length} txs)`
    );
  }

  const totalGas = gasResults.reduce((sum, r) => sum + r.gasUsed, 0);
  const avgGas = totalGas / gasResults.length;
  console.log(`Overall avg: ${Math.round(avgGas).toLocaleString()} gas`);
  console.log("----------------\n");
}

// ==================== Main ====================

async function main() {
  console.log("=== MegaETH Nullifier Gas Stress Test ===\n");

  // Load deployment
  const deployment = loadDeployment();
  console.log(`Pool:     ${deployment.contracts.pool}`);
  console.log(`USDC:     ${deployment.contracts.usdc}`);
  console.log(`Verifier: ${deployment.contracts.verifier}`);

  // Connect to network
  const rpcUrl = process.env.MEGAETH_RPC_URL || "https://carrot.megaeth.com/rpc";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");
  }
  const wallet = new ethers.Wallet(privateKey, provider);
  const walletAddress = await wallet.getAddress();

  const balance = await provider.getBalance(walletAddress);
  console.log(`Wallet:   ${walletAddress}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

  // Load contracts
  const poolAbi = loadPoolAbi();
  const pool = new ethers.Contract(deployment.contracts.pool, poolAbi, wallet);
  const tokenAddress = deployment.contracts.usdc;

  // Init LightWasm + Keypair
  console.log("Initializing LightWasm...");
  const lightWasm = await WasmFactory.getInstance();

  // Load or init progress
  let progress = loadProgress();
  let keypair: Keypair;

  if (progress && progress.completedTxs > 0) {
    console.log(`Resuming from tx ${progress.completedTxs}/${TOTAL_DEPOSITS}`);
    keypair = new Keypair(lightWasm, progress.keypairPrivkey);
  } else {
    keypair = Keypair.generateNew(lightWasm);
    progress = {
      completedTxs: 0,
      commitments: [],
      gasResults: [],
      keypairPrivkey: keypair.privkey,
    };
  }

  // Rebuild Merkle tree from saved commitments
  console.log(
    `Rebuilding Merkle tree with ${progress.commitments.length} leaves...`
  );
  const tree = new MerkleTree(
    DEFAULT_HEIGHT,
    lightWasm,
    progress.commitments
  );
  console.log(`Tree root: ${tree.root()}`);

  // Get current nonce
  let nonce = await provider.getTransactionCount(walletAddress, "pending");
  console.log(`Starting nonce: ${nonce}\n`);

  // Main loop
  const startTime = Date.now();

  for (let i = progress.completedTxs; i < TOTAL_DEPOSITS; i++) {
    const txStartTime = Date.now();
    console.log(
      `[${i + 1}/${TOTAL_DEPOSITS}] Generating proof...`
    );

    try {
      // Build proof
      const proofResult = await buildDepositProof({
        lightWasm,
        tree,
        keypair,
        depositAmount: DEPOSIT_AMOUNT,
        recipientAddress: walletAddress,
        tokenAddress,
      });

      const calldata = formatCalldata(proofResult);

      // Send transaction
      console.log(
        `[${i + 1}/${TOTAL_DEPOSITS}] Sending tx (nonce=${nonce})...`
      );

      const tx = await pool.transact(
        calldata.proofA,
        calldata.proofB,
        calldata.proofC,
        calldata.root,
        calldata.publicAmount,
        calldata.extDataHash,
        calldata.inputNullifiers,
        calldata.outputCommitments,
        calldata.extDataForContract,
        { nonce, gasPrice: 1000000 }
      );

      const receipt = await tx.wait();
      const gasUsed = Number(receipt.gasUsed);
      const elapsed = ((Date.now() - txStartTime) / 1000).toFixed(1);

      console.log(
        `[${i + 1}/${TOTAL_DEPOSITS}] Confirmed! gas=${gasUsed.toLocaleString()} time=${elapsed}s tx=${receipt.hash}`
      );

      // Update local tree with both output commitments
      tree.insert(proofResult.outputCommitments[0]);
      tree.insert(proofResult.outputCommitments[1]);

      // Save progress — derive commitments from tree to prevent desync
      progress.completedTxs = i + 1;
      progress.commitments = tree.elements();
      progress.gasResults.push({
        txIndex: i,
        gasUsed,
        txHash: receipt.hash,
      });
      saveProgress(progress);

      nonce++;

      // Print stats periodically
      if ((i + 1) % STATS_INTERVAL === 0) {
        printStats(progress.gasResults);
      }
    } catch (err: any) {
      console.error(`[${i + 1}/${TOTAL_DEPOSITS}] ERROR: ${err.message}`);

      // Re-fetch nonce in case of out-of-sync
      nonce = await provider.getTransactionCount(walletAddress, "pending");
      console.log(`  Re-fetched nonce: ${nonce}`);

      // Wait a bit before retrying
      console.log("  Waiting 5s before retry...");
      await new Promise((r) => setTimeout(r, 5000));

      // Retry this iteration
      i--;
      continue;
    }
  }

  // Final summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const balanceAfter = await provider.getBalance(walletAddress);
  const ethSpent = balance - balanceAfter;

  console.log("\n========================================");
  console.log("         STRESS TEST COMPLETE");
  console.log("========================================");
  console.log(`Total deposits: ${progress.gasResults.length}`);
  console.log(`Total time:     ${totalTime}s`);
  console.log(`ETH spent:      ${ethers.formatEther(ethSpent)} ETH`);

  printStats(progress.gasResults);

  // Save CSV
  const csvPath = path.resolve(
    __dirname,
    "../deployments/stress-test-gas.csv"
  );
  const csvLines = ["txIndex,gasUsed,txHash"];
  for (const r of progress.gasResults) {
    csvLines.push(`${r.txIndex},${r.gasUsed},${r.txHash}`);
  }
  fs.writeFileSync(csvPath, csvLines.join("\n"));
  console.log(`Gas data saved to ${csvPath}`);

  // Trend analysis
  const windowSize = 50;
  const windows: { range: string; avg: number }[] = [];
  for (let start = 0; start < progress.gasResults.length; start += windowSize) {
    const end = Math.min(start + windowSize, progress.gasResults.length);
    const window = progress.gasResults.slice(start, end);
    const avg = window.reduce((sum, r) => sum + r.gasUsed, 0) / window.length;
    windows.push({ range: `${start}-${end - 1}`, avg: Math.round(avg) });
  }

  console.log("\n=== Trend Analysis ===");
  for (const w of windows) {
    console.log(`  Txs ${w.range}: avg ${w.avg.toLocaleString()} gas`);
  }

  if (windows.length >= 2) {
    const first = windows[0].avg;
    const last = windows[windows.length - 1].avg;
    const pctChange = (((last - first) / first) * 100).toFixed(2);
    console.log(
      `\nGas trend: ${pctChange}% (first window → last window)`
    );
    if (Math.abs(last - first) / first < 0.02) {
      console.log("Conclusion: Gas is STABLE — no bucket multiplier effect.");
    } else if (last > first) {
      console.log(
        "Conclusion: Gas is INCREASING — possible bucket multiplier effect!"
      );
    } else {
      console.log("Conclusion: Gas is DECREASING — likely rootHistory overwrites.");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
