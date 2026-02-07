"use client";

import { useUTXOStore } from "@/stores/utxo-store";
import { formatUSDC, shortenSignature } from "@/lib/utils";

const typeLabels = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  merge: "Merge",
};

const typeColors = {
  deposit: "text-accent",
  withdraw: "text-orange-400",
  merge: "text-blue-400",
};

export function TransactionHistory() {
  const transactions = useUTXOStore((s) => s.transactions);

  if (transactions.length === 0) {
    return (
      <div className="text-sm text-muted py-8 text-center">
        No transactions yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {transactions.slice(0, 20).map((tx) => (
        <div
          key={tx.signature}
          className="flex items-center justify-between border border-border px-4 py-3 bg-surface-0"
        >
          <div className="flex items-center gap-3">
            <span
              className={`text-xs font-medium uppercase tracking-wide ${typeColors[tx.type]}`}
            >
              {typeLabels[tx.type]}
            </span>
            <span className="text-sm font-mono">
              {formatUSDC(tx.amount)} USDC
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted">
              {new Date(tx.timestamp).toLocaleDateString()}
            </span>
            <a
              href={`https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted font-mono hover:text-accent transition-colors"
            >
              {shortenSignature(tx.signature)}
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
