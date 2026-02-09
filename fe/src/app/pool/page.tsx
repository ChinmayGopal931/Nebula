"use client";

import Link from "next/link";
import { WalletButton } from "@/components/WalletButton";
import { PoolDashboard } from "@/components/PoolDashboard";

export default function PoolPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-4 border-b border-border">
        <Link href="/" className="text-sm text-accent tracking-wider hover:text-accent/80 transition-colors">
          PLASMA
        </Link>
        <WalletButton />
      </nav>

      {/* Dashboard */}
      <main className="flex-1 py-8">
        <PoolDashboard />
      </main>

      {/* Footer */}
      <footer className="flex items-center justify-between px-8 py-4 border-t border-border text-xs text-muted">
        <span>{process.env.NEXT_PUBLIC_COMMIT_HASH || "dev"}</span>
        <div className="flex items-center gap-4">
          <Link
            href="/docs"
            className="text-muted hover:text-accent transition-colors"
          >
            [ docs ]
          </Link>
          <Link
            href="/faucet"
            className="text-muted hover:text-accent transition-colors"
          >
            [ faucet ]
          </Link>
        </div>
      </footer>
    </div>
  );
}
