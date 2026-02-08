"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { shortenAddress } from "@/lib/utils";

export function WalletButton() {
  const { publicKey, disconnect, connected } = useWallet();
  const { setVisible } = useWalletModal();

  if (connected && publicKey) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted">
          {shortenAddress(publicKey.toBase58())}
        </span>
        <button
          onClick={() => disconnect()}
          className="px-3 py-1.5 text-xs border border-border hover:border-accent hover:text-accent transition-colors"
        >
          disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setVisible(true)}
      className="px-4 py-2 text-xs bg-accent text-surface-0 hover:bg-accent-hover transition-colors"
    >
      connect wallet
    </button>
  );
}
