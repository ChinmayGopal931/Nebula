"use client";

import { useUTXOStore } from "@/stores/utxo-store";
import { formatUSDC, shortenAddress } from "@/lib/utils";

export function UTXOList() {
  const getUnspent = useUTXOStore((s) => s.getUnspent);
  const unspent = getUnspent();

  if (unspent.length === 0) {
    return (
      <div className="text-sm text-muted py-8 text-center">
        No notes yet. Deposit USDC to create your first private note.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {unspent.map((utxo) => (
        <div
          key={utxo.id}
          className="flex items-center justify-between border border-border px-4 py-3 bg-surface-0"
        >
          <div>
            <span className="text-base font-mono">
              {formatUSDC(parseInt(utxo.amount))} USDC
            </span>
            <span className="text-xs text-muted ml-3">
              #{utxo.index}
            </span>
          </div>
          <div className="text-xs text-muted font-mono">
            {shortenAddress(utxo.id, 6)}
          </div>
        </div>
      ))}
    </div>
  );
}
