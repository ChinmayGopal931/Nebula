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
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction, publicKey } = useWallet();
  const lightWasm = useWasm();
  const { tree, insertCommitments } = useTreeStore();
  const { addUTXO, addTransaction } = useUTXOStore();

  const [step, setStep] = useState<DepositStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const deposit = useCallback(
    async (amountUSDC: string) => {
      if (!wallet || !publicKey || !lightWasm || !tree) {
        setError("Wallet not connected or WASM not loaded");
        return;
      }

      setStep("preparing");
      setError(null);
      setTxSignature(null);

      try {
        const amount = parseUSDC(amountUSDC);
        if (amount <= 0) throw new Error("Amount must be greater than 0");

        const mintAddress = USDC_MINT.toBase58();

        // Get or create ZK keypair for this session
        const zkKeypair = Keypair.generateNew(lightWasm);

        // Create UTXOs
        const inputs = [
          new Utxo({ lightWasm, mintAddress }),
          new Utxo({ lightWasm, mintAddress }),
        ];
        const outputs = [
          new Utxo({
            lightWasm,
            amount,
            keypair: zkKeypair,
            index: tree.nextIndex,
            mintAddress,
          }),
          new Utxo({ lightWasm, amount: 0, mintAddress }),
        ];

        // Get user's token account
        const signerTokenAccount = await getAssociatedTokenAddress(
          USDC_MINT,
          publicKey
        );

        // Build proof
        setStep("proving");
        const proofResult = await buildProofInput({
          inputs,
          outputs,
          tree,
          extAmount: new BN(amount),
          fee: new BN(0),
          recipient: signerTokenAccount, // For deposits, recipient is self
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

        // Store UTXO
        const commitment = await outputs[0].getCommitment();
        const storedUtxo: StoredUTXO = {
          id: commitment,
          amount: amount.toString(),
          blinding: outputs[0].blinding.toString(),
          keypairPrivkey: zkKeypair.toHex(),
          index: tree.nextIndex - 2, // Was inserted 2 ago (output0, output1)
          mintAddress,
          spent: false,
          createdAt: Date.now(),
          txSignature: signature,
        };

        await addUTXO(storedUtxo);
        await addTransaction({
          signature,
          type: "deposit",
          amount,
          timestamp: Date.now(),
          utxoIds: [commitment],
        });

        setTxSignature(signature);
        setStep("done");
      } catch (err: any) {
        setError(err.message || "Deposit failed");
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
