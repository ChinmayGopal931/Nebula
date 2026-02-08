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
      <nav className="flex items-center justify-between px-8 py-4 border-b border-border">
        <span className="text-sm text-accent tracking-wider">
          NEBULA
        </span>
        <WalletButton />
      </nav>

      {/* Dashboard */}
      <main className="flex-1 py-8">
        <PoolDashboard />
      </main>

      {/* Footer */}
      <footer className="px-8 py-4 border-t border-border text-xs text-muted">
        <span>{process.env.NEXT_PUBLIC_COMMIT_HASH || "dev"}</span>
      </footer>
    </div>
  );
}
