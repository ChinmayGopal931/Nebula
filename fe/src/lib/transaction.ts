import BN from "bn.js";
import { LightWasm } from "@lightprotocol/hasher.rs";
import {
  type PublicClient,
  type WalletClient,
  type Hash,
  padHex,
  numberToHex,
} from "viem";

import { POOL_ADDRESS, USDC_ADDRESS, POOL_ABI, ERC20_ABI } from "./config";
import { Utxo } from "./utxo";
import { MerkleTree } from "./merkle-tree";
import {
  getExtDataHash,
  getMintAddressField,
  toPublicAmount,
} from "./utils";
import { prove, parseProofForSolidity } from "./prover";

export interface SolidityProof {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
}

export interface ProofResult {
  proof: SolidityProof;
  publicSignals: string[];
  extData: {
    recipient: string;
    extAmount: BN;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    fee: BN;
    feeRecipient: string;
    tokenAddress: string;
  };
  outputCommitments: string[];
}

export async function buildProofInput(params: {
  inputs: Utxo[];
  outputs: Utxo[];
  tree: MerkleTree;
  extAmount: BN;
  fee: BN;
  recipient: string; // EVM address
  feeRecipient: string; // EVM address
  tokenAddress: string; // EVM address
}): Promise<ProofResult> {
  const {
    inputs,
    outputs,
    tree,
    extAmount,
    fee,
    recipient,
    feeRecipient,
    tokenAddress,
  } = params;

  const mintAddressField = getMintAddressField(tokenAddress);

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

  const encryptedOutput1 = new Uint8Array(68).fill(0xaa);
  const encryptedOutput2 = new Uint8Array(68).fill(0xbb);

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
  const solidityProof = parseProofForSolidity(proof);

  return {
    proof: solidityProof,
    publicSignals,
    extData,
    outputCommitments,
  };
}

/**
 * Format proof result into calldata for the Solidity contract.
 */
export function formatCalldata(proofResult: ProofResult) {
  const { proof, publicSignals, extData } = proofResult;

  const root = BigInt(publicSignals[0]);
  const publicAmount = BigInt(publicSignals[1]);
  const extDataHash = BigInt(publicSignals[2]);

  // inputNullifiers must be bytes32 — pad to 32 bytes
  const inputNullifiers: [`0x${string}`, `0x${string}`] = [
    padHex(numberToHex(BigInt(publicSignals[3])), { size: 32 }),
    padHex(numberToHex(BigInt(publicSignals[4])), { size: 32 }),
  ];

  const outputCommitments: [bigint, bigint] = [
    BigInt(publicSignals[5]),
    BigInt(publicSignals[6]),
  ];

  const extDataForContract = {
    recipient: extData.recipient as `0x${string}`,
    extAmount: BigInt(extData.extAmount.toString()),
    encryptedOutput1: `0x${Buffer.from(extData.encryptedOutput1).toString("hex")}` as `0x${string}`,
    encryptedOutput2: `0x${Buffer.from(extData.encryptedOutput2).toString("hex")}` as `0x${string}`,
    fee: BigInt(extData.fee.toString()),
    feeRecipient: extData.feeRecipient as `0x${string}`,
    tokenAddress: extData.tokenAddress as `0x${string}`,
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

/**
 * Ensure ERC-20 allowance is sufficient, approve if not.
 */
export async function ensureAllowance(
  publicClient: PublicClient,
  walletClient: WalletClient,
  owner: `0x${string}`,
  amount: bigint
): Promise<void> {
  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, POOL_ADDRESS],
  });

  if ((allowance as bigint) < amount) {
    const hash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [POOL_ADDRESS, amount],
      account: owner,
      chain: walletClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

/**
 * Send the transact call to the PrivacyPool contract.
 */
export async function callTransact(
  publicClient: PublicClient,
  walletClient: WalletClient,
  proofResult: ProofResult,
  account: `0x${string}`
): Promise<Hash> {
  const calldata = formatCalldata(proofResult);

  const hash = await walletClient.writeContract({
    address: POOL_ADDRESS,
    abi: POOL_ABI,
    functionName: "transact",
    args: [
      calldata.proofA,
      calldata.proofB,
      calldata.proofC,
      calldata.root,
      calldata.publicAmount,
      calldata.extDataHash,
      calldata.inputNullifiers,
      calldata.outputCommitments,
      calldata.extDataForContract,
    ],
    account,
    chain: walletClient.chain,
  });

  return hash;
}
