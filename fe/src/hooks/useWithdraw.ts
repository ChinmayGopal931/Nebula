"use client";

import { useState, useCallback } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import BN from "bn.js";

import { USDC_ADDRESS } from "@/lib/config";
import { Utxo } from "@/lib/utxo";
import { Keypair } from "@/lib/keypair";
import { parseUSDC } from "@/lib/utils";
import { buildProofInput, callTransact } from "@/lib/transaction";
import { useUTXOStore, StoredUTXO } from "@/stores/utxo-store";
import { useTreeStore } from "@/stores/tree-store";
import { useWasm } from "./useWasm";

export type WithdrawStep =
  | "idle"
  | "preparing"
  | "proving"
  | "signing"
  | "confirming"
  | "done"
  | "error";

interface WithdrawState {
  step: WithdrawStep;
  error: string | null;
  txSignature: string | null;
  withdraw: (
    amountUSDC: string,
    utxoId: string,
    recipientAddress?: string
  ) => Promise<void>;
  reset: () => void;
}

export function useWithdraw(): WithdrawState {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const lightWasm = useWasm();
  const { tree, insertCommitments } = useTreeStore();
  const { utxos, addUTXO, markSpent, addTransaction } = useUTXOStore();

  const [step, setStep] = useState<WithdrawStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const withdraw = useCallback(
    async (
      amountUSDC: string,
      utxoId: string,
      recipientAddress?: string
    ) => {
      if (!address || !publicClient || !walletClient || !lightWasm || !tree) {
        setError("Wallet not connected or WASM not loaded");
        return;
      }

      setStep("preparing");
      setError(null);
      setTxSignature(null);

      try {
        const withdrawAmount = parseUSDC(amountUSDC);
        if (withdrawAmount <= 0)
          throw new Error("Amount must be greater than 0");

        const storedUtxo = utxos.find((u) => u.id === utxoId);
        if (!storedUtxo) throw new Error("UTXO not found");
        if (storedUtxo.spent) throw new Error("UTXO already spent");

        const utxoAmount = parseInt(storedUtxo.amount);
        if (withdrawAmount > utxoAmount)
          throw new Error("Insufficient UTXO balance");

        const tokenAddress = USDC_ADDRESS;
        const zkKeypair = Keypair.fromPrivkey(
          storedUtxo.keypairPrivkey,
          lightWasm
        );

        // Reconstruct the input UTXO
        const inputUtxo = new Utxo({
          lightWasm,
          amount: utxoAmount,
          keypair: zkKeypair,
          blinding: storedUtxo.blinding,
          index: storedUtxo.index,
          tokenAddress,
        });

        const changeAmount = utxoAmount - withdrawAmount;
        const isPartial = changeAmount > 0;

        // Build outputs
        const changeKeypair = isPartial
          ? Keypair.generateNew(lightWasm)
          : undefined;
        const outputs = [
          isPartial
            ? new Utxo({
                lightWasm,
                amount: changeAmount,
                keypair: changeKeypair,
                index: tree.nextIndex,
                tokenAddress,
              })
            : new Utxo({ lightWasm, amount: 0, tokenAddress }),
          new Utxo({ lightWasm, amount: 0, tokenAddress }),
        ];

        // Determine recipient
        const recipient = recipientAddress || address;

        // Build proof (direct withdrawal — no relayer)
        setStep("proving");
        const proofResult = await buildProofInput({
          inputs: [
            inputUtxo,
            new Utxo({ lightWasm, tokenAddress }),
          ],
          outputs,
          tree,
          extAmount: new BN(-withdrawAmount),
          fee: new BN(0),
          recipient,
          feeRecipient: address,
          tokenAddress,
        });

        // Send transaction directly
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
        await markSpent(utxoId);

        // Store change UTXO if partial withdrawal
        if (isPartial && changeKeypair) {
          const changeCommitment = await outputs[0].getCommitment();
          const changeStoredUtxo: StoredUTXO = {
            id: changeCommitment,
            amount: changeAmount.toString(),
            blinding: outputs[0].blinding.toString(),
            keypairPrivkey: changeKeypair.toHex(),
            index: tree.nextIndex - 2,
            tokenAddress,
            spent: false,
            createdAt: Date.now(),
            txHash: hash,
          };
          await addUTXO(changeStoredUtxo);
        }

        await addTransaction({
          signature: hash,
          type: "withdraw",
          amount: withdrawAmount,
          timestamp: Date.now(),
          utxoIds: [utxoId],
        });

        setTxSignature(hash);
        setStep("done");
      } catch (err: any) {
        setError(err.message || "Withdrawal failed");
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

  return { step, error, txSignature, withdraw, reset };
}
