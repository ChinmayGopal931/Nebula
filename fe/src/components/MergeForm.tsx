"use client";

import { useState } from "react";
import { useMerge } from "@/hooks/useMerge";
import { useUTXOStore } from "@/stores/utxo-store";
import { formatUSDC } from "@/lib/utils";
import { ProofStatus } from "./ProofStatus";

export function MergeForm() {
  const [utxoA, setUtxoA] = useState("");
  const [utxoB, setUtxoB] = useState("");
  const { step, error, txSignature, merge, reset } = useMerge();
  const getUnspent = useUTXOStore((s) => s.getUnspent);

  const unspentUtxos = getUnspent();

  if (unspentUtxos.length < 2) {
    return (
      <p className="text-sm text-muted py-4">
        Need at least 2 notes to merge.
      </p>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!utxoA || !utxoB || utxoA === utxoB) return;
    await merge(utxoA, utxoB);
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-muted mb-1.5">
            Note A
          </label>
          <select
            value={utxoA}
            onChange={(e) => setUtxoA(e.target.value)}
            className="w-full bg-surface-0 border border-border px-4 py-3 text-sm focus:outline-none focus:border-border-hover appearance-none cursor-pointer"
            disabled={step !== "idle"}
          >
            <option value="">Select note...</option>
            {unspentUtxos
              .filter((u) => u.id !== utxoB)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {formatUSDC(parseInt(u.amount))} USDC
                </option>
              ))}
          </select>
        </div>

        <div>
          <label className="block text-sm text-muted mb-1.5">
            Note B
          </label>
          <select
            value={utxoB}
            onChange={(e) => setUtxoB(e.target.value)}
            className="w-full bg-surface-0 border border-border px-4 py-3 text-sm focus:outline-none focus:border-border-hover appearance-none cursor-pointer"
            disabled={step !== "idle"}
          >
            <option value="">Select note...</option>
            {unspentUtxos
              .filter((u) => u.id !== utxoA)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {formatUSDC(parseInt(u.amount))} USDC
                </option>
              ))}
          </select>
        </div>

        {utxoA && utxoB && (
          <div className="text-sm text-muted border border-border px-4 py-3 bg-surface-0">
            Merged amount:{" "}
            <span className="text-white font-mono">
              {formatUSDC(
                parseInt(
                  unspentUtxos.find((u) => u.id === utxoA)?.amount ||
                    "0"
                ) +
                  parseInt(
                    unspentUtxos.find((u) => u.id === utxoB)?.amount ||
                      "0"
                  )
              )}{" "}
              USDC
            </span>
          </div>
        )}

        <button
          type="submit"
          disabled={
            !utxoA || !utxoB || utxoA === utxoB || step !== "idle"
          }
          className="w-full py-3 text-sm font-medium bg-accent text-surface-0 hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Merge Notes
        </button>
      </form>

      <ProofStatus
        step={step}
        error={error}
        txSignature={txSignature}
        onClose={() => {
          reset();
          if (step === "done") {
            setUtxoA("");
            setUtxoB("");
          }
        }}
      />
    </>
  );
}
