"use client";

import { useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";

import { USDC_MINT } from "@/lib/config";
import { Utxo } from "@/lib/utxo";
import { Keypair } from "@/lib/keypair";
import { parseUSDC } from "@/lib/utils";
import {
  getProgram,
  getOrCreateALT,
  buildProofInput,
  buildTransactVersionedTx,
} from "@/lib/transaction";
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

        // Build proof
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
          feeRecipient: publicKey,
        });

        // Create ALT if needed
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

        // Build versioned transaction
        const signerTokenAccount = await getAssociatedTokenAddress(
          USDC_MINT,
          publicKey
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
          recipientPubkey,
          recipientTokenAccount,
          altAddress
        );

        // Send
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
