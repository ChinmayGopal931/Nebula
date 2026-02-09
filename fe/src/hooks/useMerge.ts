"use client";

import { useState, useCallback } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import BN from "bn.js";

import { USDC_ADDRESS } from "@/lib/config";
import { Utxo } from "@/lib/utxo";
import { Keypair } from "@/lib/keypair";
import { buildProofInput, callTransact } from "@/lib/transaction";
import { useUTXOStore, StoredUTXO } from "@/stores/utxo-store";
import { useTreeStore } from "@/stores/tree-store";
import { useWasm } from "./useWasm";

export type MergeStep =
  | "idle"
  | "preparing"
  | "proving"
  | "signing"
  | "confirming"
  | "done"
  | "error";

interface MergeState {
  step: MergeStep;
  error: string | null;
  txSignature: string | null;
  merge: (utxoIdA: string, utxoIdB: string) => Promise<void>;
  reset: () => void;
}

export function useMerge(): MergeState {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const lightWasm = useWasm();
  const { tree, insertCommitments } = useTreeStore();
  const { utxos, addUTXO, markSpent, addTransaction } = useUTXOStore();

  const [step, setStep] = useState<MergeStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const merge = useCallback(
    async (utxoIdA: string, utxoIdB: string) => {
      if (!address || !publicClient || !walletClient || !lightWasm || !tree) {
        setError("Wallet not connected or WASM not loaded");
        return;
      }

      setStep("preparing");
      setError(null);
      setTxSignature(null);

      try {
        const storedA = utxos.find((u) => u.id === utxoIdA);
        const storedB = utxos.find((u) => u.id === utxoIdB);
        if (!storedA || !storedB)
          throw new Error("UTXOs not found");
        if (storedA.spent || storedB.spent)
          throw new Error("Cannot merge spent UTXOs");

        const tokenAddress = USDC_ADDRESS;
        const amountA = parseInt(storedA.amount);
        const amountB = parseInt(storedB.amount);
        const mergedAmount = amountA + amountB;

        // Reconstruct input UTXOs
        const keypairA = Keypair.fromPrivkey(
          storedA.keypairPrivkey,
          lightWasm
        );
        const keypairB = Keypair.fromPrivkey(
          storedB.keypairPrivkey,
          lightWasm
        );

        const inputA = new Utxo({
          lightWasm,
          amount: amountA,
          keypair: keypairA,
          blinding: storedA.blinding,
          index: storedA.index,
          tokenAddress,
        });
        const inputB = new Utxo({
          lightWasm,
          amount: amountB,
          keypair: keypairB,
          blinding: storedB.blinding,
          index: storedB.index,
          tokenAddress,
        });

        // Create merged output
        const mergedKeypair = Keypair.generateNew(lightWasm);
        const outputs = [
          new Utxo({
            lightWasm,
            amount: mergedAmount,
            keypair: mergedKeypair,
            index: tree.nextIndex,
            tokenAddress,
          }),
          new Utxo({ lightWasm, amount: 0, tokenAddress }),
        ];

        // For merge: extAmount = 0
        setStep("proving");
        const proofResult = await buildProofInput({
          inputs: [inputA, inputB],
          outputs,
          tree,
          extAmount: new BN(0),
          fee: new BN(0),
          recipient: address,
          feeRecipient: address,
          tokenAddress,
        });

        setStep("signing");
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
        await markSpent(utxoIdA);
        await markSpent(utxoIdB);

        // Store merged UTXO
        const mergedCommitment = await outputs[0].getCommitment();
        const mergedStoredUtxo: StoredUTXO = {
          id: mergedCommitment,
          amount: mergedAmount.toString(),
          blinding: outputs[0].blinding.toString(),
          keypairPrivkey: mergedKeypair.toHex(),
          index: tree.nextIndex - 2,
          tokenAddress,
          spent: false,
          createdAt: Date.now(),
          txHash: hash,
        };
        await addUTXO(mergedStoredUtxo);

        await addTransaction({
          signature: hash,
          type: "merge",
          amount: mergedAmount,
          timestamp: Date.now(),
          utxoIds: [utxoIdA, utxoIdB],
        });

        setTxSignature(hash);
        setStep("done");
      } catch (err: any) {
        setError(err.message || "Merge failed");
        setStep("error");
      }
    },
    [
      address,
      publicClient,
      walletClient,
      lightWasm,
      tree,
      utxos,
      insertCommitments,
      markSpent,
      addUTXO,
      addTransaction,
    ]
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setTxSignature(null);
  }, []);

  return { step, error, txSignature, merge, reset };
}
