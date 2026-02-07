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
        <span className="text-sm text-muted font-mono">
          {shortenAddress(publicKey.toBase58())}
        </span>
        <button
          onClick={() => disconnect()}
          className="px-4 py-2 text-sm bg-surface-1 border border-border hover:border-border-hover transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setVisible(true)}
      className="px-6 py-2.5 text-sm font-medium bg-accent text-surface-0 hover:bg-accent-hover transition-colors"
    >
      Connect Wallet
    </button>
  );
}
