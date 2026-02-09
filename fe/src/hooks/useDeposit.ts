"use client";

import { useState, useCallback } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import BN from "bn.js";

import { USDC_ADDRESS } from "@/lib/config";
import { Utxo } from "@/lib/utxo";
import { Keypair } from "@/lib/keypair";
import { parseUSDC } from "@/lib/utils";
import {
  buildProofInput,
  ensureAllowance,
  callTransact,
} from "@/lib/transaction";
import { useUTXOStore, StoredUTXO } from "@/stores/utxo-store";
import { useTreeStore } from "@/stores/tree-store";
import { useWasm } from "./useWasm";

export type DepositStep =
  | "idle"
  | "preparing"
  | "proving"
  | "signing"
  | "confirming"
  | "done"
  | "error";

interface DepositState {
  step: DepositStep;
  error: string | null;
  txSignature: string | null;
  deposit: (amountUSDC: string) => Promise<void>;
  reset: () => void;
}

export function useDeposit(): DepositState {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const lightWasm = useWasm();
  const { tree, insertCommitments } = useTreeStore();
  const { addUTXO, addTransaction } = useUTXOStore();

  const [step, setStep] = useState<DepositStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const deposit = useCallback(
    async (amountUSDC: string) => {
      if (!address || !publicClient || !walletClient || !lightWasm || !tree) {
        setError("Wallet not connected or WASM not loaded");
        return;
      }

      setStep("preparing");
      setError(null);
      setTxSignature(null);

      try {
        const amount = parseUSDC(amountUSDC);
        if (amount <= 0) throw new Error("Amount must be greater than 0");

        const tokenAddress = USDC_ADDRESS;

        // Generate ZK keypair for this deposit
        const zkKeypair = Keypair.generateNew(lightWasm);

        // Create UTXOs
        const inputs = [
          new Utxo({ lightWasm, tokenAddress }),
          new Utxo({ lightWasm, tokenAddress }),
        ];
        const outputs = [
          new Utxo({
            lightWasm,
            amount,
            keypair: zkKeypair,
            index: tree.nextIndex,
            tokenAddress,
          }),
          new Utxo({ lightWasm, amount: 0, tokenAddress }),
        ];

        // Build proof
        setStep("proving");
        const proofResult = await buildProofInput({
          inputs,
          outputs,
          tree,
          extAmount: new BN(amount),
          fee: new BN(0),
          recipient: address,
          feeRecipient: address,
          tokenAddress,
        });

        // Approve USDC if needed, then send tx
        setStep("signing");
        await ensureAllowance(
          publicClient,
          walletClient,
          address,
          BigInt(amount)
        );

        const hash = await callTransact(
          publicClient,
          walletClient,
          proofResult,
          address
        );

        setStep("confirming");
        await publicClient.waitForTransactionReceipt({ hash });

        // Update local state
        insertCommitments(proofResult.outputCommitments);

        // Store UTXO
        const commitment = await outputs[0].getCommitment();
        const storedUtxo: StoredUTXO = {
          id: commitment,
          amount: amount.toString(),
          blinding: outputs[0].blinding.toString(),
          keypairPrivkey: zkKeypair.toHex(),
          index: tree.nextIndex - 2,
          tokenAddress,
          spent: false,
          createdAt: Date.now(),
          txHash: hash,
        };

        await addUTXO(storedUtxo);
        await addTransaction({
          signature: hash,
          type: "deposit",
          amount,
          timestamp: Date.now(),
          utxoIds: [commitment],
        });

        setTxSignature(hash);
        setStep("done");
      } catch (err: any) {
        setError(err.message || "Deposit failed");
        setStep("error");
      }
    },
    [
      address,
      publicClient,
      walletClient,
      lightWasm,
      tree,
      insertCommitments,
      addUTXO,
      addTransaction,
    ]
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setTxSignature(null);
  }, []);

  return { step, error, txSignature, deposit, reset };
}
