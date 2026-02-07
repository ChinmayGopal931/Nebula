"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { WalletButton } from "@/components/WalletButton";

export default function Home() {
  const { connected } = useWallet();
  const router = useRouter();

  useEffect(() => {
    if (connected) {
      router.push("/pool");
    }
  }, [connected, router]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-border">
        <span className="text-sm font-medium tracking-wide">
          Privacy Yield
        </span>
        <WalletButton />
      </nav>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="max-w-lg text-center">
          <h1 className="text-4xl font-medium mb-4 tracking-tight">
            Private Yield on Solana
          </h1>
          <p className="text-muted text-lg mb-12 leading-relaxed">
            Deposit USDC privately, earn yield, withdraw anywhere.
            All proof generation happens in your browser.
          </p>

          {!connected && (
            <div className="inline-block">
              <WalletButton />
            </div>
          )}
        </div>

        {/* How it works */}
        <div className="mt-20 max-w-2xl w-full">
          <div className="grid grid-cols-3 gap-6">
            <div className="border border-border p-6 bg-surface-1">
              <div className="text-xs text-muted uppercase tracking-wide mb-3">
                01
              </div>
              <h3 className="text-sm font-medium mb-2">
                Deposit Privately
              </h3>
              <p className="text-xs text-muted leading-relaxed">
                Generate a ZK proof in your browser. Your deposit amount is
                shielded from on-chain observers.
              </p>
            </div>
            <div className="border border-border p-6 bg-surface-1">
              <div className="text-xs text-muted uppercase tracking-wide mb-3">
                02
              </div>
              <h3 className="text-sm font-medium mb-2">Earn Yield</h3>
              <p className="text-xs text-muted leading-relaxed">
                Pool funds are deployed to Kamino lending. Your share earns
                interest while remaining private.
              </p>
            </div>
            <div className="border border-border p-6 bg-surface-1">
              <div className="text-xs text-muted uppercase tracking-wide mb-3">
                03
              </div>
              <h3 className="text-sm font-medium mb-2">
                Withdraw Anywhere
              </h3>
              <p className="text-xs text-muted leading-relaxed">
                Withdraw to any Solana address. No one can link your
                withdrawal to your deposit.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-8 py-5 border-t border-border text-xs text-muted flex items-center justify-between">
        <span>Devnet</span>
        <span>ZK + MPC on Solana</span>
      </footer>
    </div>
  );
}
