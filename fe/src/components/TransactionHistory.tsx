"use client";

import { useUTXOStore } from "@/stores/utxo-store";
import { formatUSDC, shortenSignature } from "@/lib/utils";

const typeLabels: Record<string, string> = {
  deposit: "DEPOSIT",
  withdraw: "WITHDRAW",
  merge: "MERGE",
};

const typeColors: Record<string, string> = {
  deposit: "text-green-500",
  withdraw: "text-accent",
  merge: "text-blue-400",
};

export function TransactionHistory() {
  const transactions = useUTXOStore((s) => s.transactions);

  if (transactions.length === 0) {
    return (
      <div className="text-xs text-muted py-6 text-center">
        no transactions yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {transactions.slice(0, 20).map((tx) => (
        <div
          key={tx.signature}
          className="flex items-center justify-between px-3 py-2 bg-surface-0 border border-border text-xs"
        >
          <div className="flex items-center gap-3">
            <span
              className={typeColors[tx.type] || "text-muted"}
            >
              {typeLabels[tx.type] || tx.type}
            </span>
            <span className="text-white">
              {formatUSDC(tx.amount)} USDC
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted">
              {new Date(tx.timestamp).toLocaleDateString()}
            </span>
            <a
              href={`https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted hover:text-accent transition-colors"
            >
              {shortenSignature(tx.signature)}
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
