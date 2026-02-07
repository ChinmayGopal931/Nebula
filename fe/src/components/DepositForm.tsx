"use client";

import { useState } from "react";
import { useDeposit } from "@/hooks/useDeposit";
import { ProofStatus } from "./ProofStatus";

export function DepositForm() {
  const [amount, setAmount] = useState("");
  const { step, error, txSignature, deposit, reset } = useDeposit();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || parseFloat(amount) <= 0) return;
    await deposit(amount);
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-muted mb-1.5">
            Amount (USDC)
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-surface-0 border border-border px-4 py-3 text-lg font-mono focus:outline-none focus:border-border-hover placeholder:text-muted/40"
              disabled={step !== "idle"}
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-muted">
              USDC
            </span>
          </div>
        </div>

        <button
          type="submit"
          disabled={
            !amount ||
            parseFloat(amount) <= 0 ||
            step !== "idle"
          }
          className="w-full py-3 text-sm font-medium bg-accent text-surface-0 hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Deposit
        </button>
      </form>

      <ProofStatus
        step={step}
        error={error}
        txSignature={txSignature}
        onClose={() => {
          reset();
          if (step === "done") setAmount("");
        }}
      />
    </>
  );
}
