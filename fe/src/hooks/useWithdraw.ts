"use client";

import { useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";

import { USDC_MINT, RELAYER_URL, RELAYER_PUBKEY } from "@/lib/config";
import { Utxo } from "@/lib/utxo";
import { Keypair } from "@/lib/keypair";
import { parseUSDC } from "@/lib/utils";
import { buildProofInput } from "@/lib/transaction";
import { useUTXOStore, StoredUTXO } from "@/stores/utxo-store";
import { useTreeStore } from "@/stores/tree-store";
import { useWasm } from "./useWasm";

export type WithdrawStep =
  | "idle"
  | "preparing"
  | "proving"
  | "relaying"
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

async function pollRelayerStatus(
  requestId: string,
  signal?: AbortSignal
): Promise<{ status: string; txSignature?: string; error?: string }> {
  const POLL_INTERVAL = 5000;
  const MAX_POLLS = 120; // 10 minutes max

  for (let i = 0; i < MAX_POLLS; i++) {
    if (signal?.aborted) throw new Error("Polling aborted");

    const res = await fetch(`${RELAYER_URL}/status/${requestId}`);
    if (!res.ok) throw new Error("Failed to check relayer status");

    const data = await res.json();

    if (data.status === "confirmed") {
      return { status: "confirmed", txSignature: data.txSignature };
    }
    if (data.status === "failed") {
      return { status: "failed", error: data.error || "Relayer submission failed" };
    }

    // Still queued or submitting — wait and retry
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  throw new Error("Relayer polling timed out");
}

export function useWithdraw(): WithdrawState {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction, publicKey } = useWallet();
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
      if (!wallet || !publicKey || !lightWasm || !tree) {
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

        const mintAddress = USDC_MINT.toBase58();
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
          mintAddress,
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
                mintAddress,
              })
            : new Utxo({ lightWasm, amount: 0, mintAddress }),
          new Utxo({ lightWasm, amount: 0, mintAddress }),
        ];

        // Determine recipient
        const recipientPubkey = recipientAddress
          ? new PublicKey(recipientAddress)
          : publicKey;
        const recipientTokenAccount = await getAssociatedTokenAddress(
          USDC_MINT,
          recipientPubkey
        );

        // Ensure recipient ATA exists (for external recipients)
        if (recipientAddress) {
          const ataInfo = await connection.getAccountInfo(
            recipientTokenAccount
          );
          if (!ataInfo) {
            const createAtaIx = createAssociatedTokenAccountInstruction(
              publicKey,
              recipientTokenAccount,
              recipientPubkey,
              USDC_MINT
            );
            const tx = new Transaction().add(createAtaIx);
            tx.feePayer = publicKey;
            tx.recentBlockhash = (
              await connection.getLatestBlockhash()
            ).blockhash;
            const sig = await sendTransaction(tx, connection);
            await connection.confirmTransaction(sig, "confirmed");
          }
        }

        // Build proof with relayer as feeRecipient
        setStep("proving");
        const proofResult = await buildProofInput({
          inputs: [
            inputUtxo,
            new Utxo({ lightWasm, mintAddress }),
          ],
          outputs,
          tree,
          extAmount: new BN(-withdrawAmount),
          fee: new BN(0),
          recipient: recipientTokenAccount,
          feeRecipient: RELAYER_PUBKEY,
        });

        // Send to relayer
        setStep("relaying");
        const relayerRes = await fetch(`${RELAYER_URL}/withdraw`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proof: proofResult.proofToSubmit,
            extDataMinified: {
              extAmount: proofResult.extData.extAmount.toString(),
              fee: proofResult.extData.fee.toString(),
            },
            encryptedOutput1: Array.from(proofResult.extData.encryptedOutput1),
            encryptedOutput2: Array.from(proofResult.extData.encryptedOutput2),
            recipientPubkey: recipientPubkey.toBase58(),
            recipientTokenAccount: recipientTokenAccount.toBase58(),
          }),
        });

        if (!relayerRes.ok) {
          const errData = await relayerRes.json().catch(() => ({}));
          throw new Error(errData.error || `Relayer returned ${relayerRes.status}`);
        }

        const { requestId } = await relayerRes.json();

        // Poll for completion
        setStep("confirming");
        const result = await pollRelayerStatus(requestId);

        if (result.status === "failed") {
          throw new Error(result.error || "Relayer submission failed");
        }

        const signature = result.txSignature!;

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
            mintAddress,
            spent: false,
            createdAt: Date.now(),
            txSignature: signature,
          };
          await addUTXO(changeStoredUtxo);
        }

        await addTransaction({
          signature,
          type: "withdraw",
          amount: withdrawAmount,
          timestamp: Date.now(),
          utxoIds: [utxoId],
        });

        setTxSignature(signature);
        setStep("done");
      } catch (err: any) {
        setError(err.message || "Withdrawal failed");
        setStep("error");
      }
    },
    [
      wallet,
      publicKey,
      lightWasm,
      tree,
      connection,
      sendTransaction,
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
