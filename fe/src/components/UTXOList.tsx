"use client";

import { useUTXOStore } from "@/stores/utxo-store";
import { formatUSDC, shortenAddress } from "@/lib/utils";

export function UTXOList() {
  const getUnspent = useUTXOStore((s) => s.getUnspent);
  const unspent = getUnspent();

  if (unspent.length === 0) {
    return (
      <div className="text-xs text-muted py-6 text-center">
        no notes yet. deposit USDC to create your first private note.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {unspent.map((utxo, i) => (
        <div
          key={utxo.id}
          className="flex items-center justify-between px-3 py-2 bg-surface-0 border border-border text-xs"
        >
          <div className="flex items-center gap-3">
            <span className="text-muted">
              {String(i).padStart(2, "0")}
            </span>
            <span className="text-white">
              {formatUSDC(parseInt(utxo.amount))} USDC
            </span>
            <span className="text-muted">
              #{utxo.index}
            </span>
          </div>
          <span className="text-muted">
            {shortenAddress(utxo.id, 6)}
          </span>
        </div>
      ))}
    </div>
  );
}
