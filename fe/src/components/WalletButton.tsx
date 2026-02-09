"use client";

import { useAccount, useDisconnect } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { shortenAddress } from "@/lib/utils";

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted">
          {shortenAddress(address)}
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
      onClick={() => openConnectModal?.()}
      className="px-4 py-2 text-xs bg-accent text-surface-0 hover:bg-accent-hover transition-colors"
    >
      connect wallet
    </button>
  );
}
