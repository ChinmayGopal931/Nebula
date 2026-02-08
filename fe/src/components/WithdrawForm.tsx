"use client";

import { useState } from "react";
import { useWithdraw } from "@/hooks/useWithdraw";
import { useUTXOStore } from "@/stores/utxo-store";
import { formatUSDC } from "@/lib/utils";
import { ProofStatus } from "./ProofStatus";

export function WithdrawForm() {
  const [amount, setAmount] = useState("");
  const [selectedUtxo, setSelectedUtxo] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [showRecipient, setShowRecipient] = useState(false);
  const { step, error, txSignature, withdraw, reset } = useWithdraw();
  const getUnspent = useUTXOStore((s) => s.getUnspent);

  const unspentUtxos = getUnspent();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || !selectedUtxo) return;
    await withdraw(
      amount,
      selectedUtxo,
      showRecipient && recipientAddress
        ? recipientAddress
        : undefined
    );
  };

  const selectedUtxoData = unspentUtxos.find(
    (u) => u.id === selectedUtxo
  );
  const maxAmount = selectedUtxoData
    ? parseInt(selectedUtxoData.amount) / 1_000_000
    : 0;

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs text-muted mb-2">
            {">"} select note
          </label>
          <select
            value={selectedUtxo}
            onChange={(e) => {
              setSelectedUtxo(e.target.value);
              setAmount("");
            }}
            className="w-full bg-surface-0 border border-border px-4 py-3 text-sm text-white focus:outline-none focus:border-accent appearance-none cursor-pointer"
            disabled={step !== "idle"}
          >
            <option value="">-- select --</option>
            {unspentUtxos.map((u) => (
              <option key={u.id} value={u.id}>
                {formatUSDC(parseInt(u.amount))} USDC
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-muted">
              {">"} amount (USDC)
            </label>
            {selectedUtxoData && (
              <button
                type="button"
                onClick={() => setAmount(maxAmount.toString())}
                className="text-xs text-accent hover:text-accent-hover transition-colors"
                disabled={step !== "idle"}
              >
                max: {maxAmount.toFixed(2)}
              </button>
            )}
          </div>
          <div className="relative">
            <input
              type="number"
              step="0.01"
              min="0"
              max={maxAmount}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-surface-0 border border-border px-4 py-3 text-lg text-white focus:outline-none focus:border-accent placeholder:text-muted/30"
              disabled={!selectedUtxo || step !== "idle"}
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-muted">
              USDC
            </span>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowRecipient(!showRecipient)}
            className="text-xs text-muted hover:text-accent transition-colors"
          >
            {showRecipient
              ? "- hide recipient"
              : "+ custom recipient"}
          </button>
          {showRecipient && (
            <input
              type="text"
              value={recipientAddress}
              onChange={(e) => setRecipientAddress(e.target.value)}
              placeholder="solana address (default: your wallet)"
              className="mt-2 w-full bg-surface-0 border border-border px-4 py-2.5 text-xs text-white focus:outline-none focus:border-accent placeholder:text-muted/30"
              disabled={step !== "idle"}
            />
          )}
        </div>

        <button
          type="submit"
          disabled={
            !amount ||
            !selectedUtxo ||
            parseFloat(amount) <= 0 ||
            parseFloat(amount) > maxAmount ||
            step !== "idle"
          }
          className="w-full py-3 text-xs bg-accent text-surface-0 hover:bg-accent-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          [ execute withdraw ]
        </button>
      </form>

      <ProofStatus
        step={step}
        error={error}
        txSignature={txSignature}
        onClose={() => {
          reset();
          if (step === "done") {
            setAmount("");
            setSelectedUtxo("");
          }
        }}
      />
    </>
  );
}
