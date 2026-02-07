"use client";

import { useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import BN from "bn.js";

import { USDC_MINT } from "@/lib/config";
import { Utxo } from "@/lib/utxo";
import { Keypair } from "@/lib/keypair";
import {
  getProgram,
  getOrCreateALT,
  buildProofInput,
  buildTransactVersionedTx,
} from "@/lib/transaction";
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
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction, publicKey } = useWallet();
  const lightWasm = useWasm();
  const { tree, insertCommitments } = useTreeStore();
  const { utxos, addUTXO, markSpent, addTransaction } = useUTXOStore();

  const [step, setStep] = useState<MergeStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const merge = useCallback(
    async (utxoIdA: string, utxoIdB: string) => {
      if (!wallet || !publicKey || !lightWasm || !tree) {
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

        const mintAddress = USDC_MINT.toBase58();
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
          mintAddress,
        });
        const inputB = new Utxo({
          lightWasm,
          amount: amountB,
          keypair: keypairB,
          blinding: storedB.blinding,
          index: storedB.index,
          mintAddress,
        });

        // Create merged output
        const mergedKeypair = Keypair.generateNew(lightWasm);
        const outputs = [
          new Utxo({
            lightWasm,
            amount: mergedAmount,
            keypair: mergedKeypair,
            index: tree.nextIndex,
            mintAddress,
          }),
          new Utxo({ lightWasm, amount: 0, mintAddress }),
        ];

        // For merge: extAmount = 0, recipient = signer (placeholder)
        const signerTokenAccount = await getAssociatedTokenAddress(
          USDC_MINT,
          publicKey
        );

        setStep("proving");
        const proofResult = await buildProofInput({
          inputs: [inputA, inputB],
          outputs,
          tree,
          extAmount: new BN(0),
          fee: new BN(0),
          recipient: signerTokenAccount,
          feeRecipient: publicKey,
        });

        setStep("signing");
        const signAndSend = async (tx: Transaction) => {
          const sig = await sendTransaction(tx, connection);
          await connection.confirmTransaction(sig, "confirmed");
          return sig;
        };
        const altAddress = await getOrCreateALT(
          connection,
          publicKey,
          signAndSend
        );

        const provider = new AnchorProvider(connection, wallet, {
          commitment: "confirmed",
        });
        const program = getProgram(provider);

        const versionedTx = await buildTransactVersionedTx(
          connection,
          program,
          proofResult,
          publicKey,
          signerTokenAccount,
          publicKey,
          signerTokenAccount,
          altAddress
        );

        const signature = await sendTransaction(versionedTx, connection);
        setStep("confirming");

        const latestBlockhash = await connection.getLatestBlockhash();
        await connection.confirmTransaction(
          {
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            signature,
          },
          "confirmed"
        );

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
          mintAddress,
          spent: false,
          createdAt: Date.now(),
          txSignature: signature,
        };
        await addUTXO(mergedStoredUtxo);

        await addTransaction({
          signature,
          type: "merge",
          amount: mergedAmount,
          timestamp: Date.now(),
          utxoIds: [utxoIdA, utxoIdB],
        });

        setTxSignature(signature);
        setStep("done");
      } catch (err: any) {
        setError(err.message || "Merge failed");
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

  return { step, error, txSignature, merge, reset };
}
