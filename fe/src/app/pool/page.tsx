"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { WalletButton } from "@/components/WalletButton";
import { PoolDashboard } from "@/components/PoolDashboard";

export default function PoolPage() {
  const { connected } = useWallet();
  const router = useRouter();

  useEffect(() => {
    if (!connected) {
      router.push("/");
    }
  }, [connected, router]);

  if (!connected) return null;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-border">
        <span className="text-sm font-medium tracking-wide">
          Privacy Yield
        </span>
        <WalletButton />
      </nav>

      {/* Dashboard */}
      <main className="flex-1 py-10">
        <PoolDashboard />
      </main>

      {/* Footer */}
      <footer className="px-8 py-5 border-t border-border text-xs text-muted flex items-center justify-between">
        <span>Devnet</span>
        <span>ZK + MPC on Solana</span>
      </footer>
    </div>
  );
}
