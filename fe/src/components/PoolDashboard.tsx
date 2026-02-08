"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePoolBalance } from "@/hooks/usePoolBalance";
import { useMerkleTree } from "@/hooks/useMerkleTree";
import { useUTXOStore } from "@/stores/utxo-store";
import { formatUSDC } from "@/lib/utils";
import { preloadArtifacts } from "@/lib/prover";
import { DepositForm } from "./DepositForm";
import { WithdrawForm } from "./WithdrawForm";
// import { MergeForm } from "./MergeForm";
import { UTXOList } from "./UTXOList";
import { TransactionHistory } from "./TransactionHistory";

type Tab = "deposit" | "withdraw";
type Section = "notes" | "history";

export function PoolDashboard() {
  const { publicKey } = useWallet();
  const {
    shieldedBalance,
    walletBalance,
    vaultBalance,
    ctokenBalance,
    isLoading: balanceLoading,
  } = usePoolBalance();
  const { isSyncing, onChainLeafCount } = useMerkleTree();
  const { init: initUtxoStore, isLoaded: utxoLoaded } = useUTXOStore();

  const [activeTab, setActiveTab] = useState<Tab>("deposit");
  const [activeSection, setActiveSection] = useState<Section>("notes");
  const [artifactsReady, setArtifactsReady] = useState(false);

  useEffect(() => {
    if (publicKey) {
      initUtxoStore(publicKey.toBase58());
    }
  }, [publicKey, initUtxoStore]);

  useEffect(() => {
    preloadArtifacts().then(() => setArtifactsReady(true));
  }, []);

  const tabs: { key: Tab; label: string }[] = [
    { key: "deposit", label: "deposit" },
    { key: "withdraw", label: "withdraw" },
  ];

  return (
    <div className="max-w-2xl mx-auto px-4">
      {/* System status */}
      <div className="flex items-center gap-6 mb-8 text-xs">
        <span className="text-muted">sys</span>
        <span className={isSyncing ? "text-yellow-400" : "text-green-500"}>
          {isSyncing
            ? `[SYNC] tree...`
            : `[OK] ${onChainLeafCount} leaves`}
        </span>
        <span className="text-green-500">[OK] devnet</span>
      </div>

      {/* Balances */}
      <div className="mb-8 space-y-1">
        <div className="text-xs text-muted mb-3 uppercase tracking-widest">
          {"// balances"}
        </div>
        <div className="grid grid-cols-2 gap-px bg-border">
          <div className="bg-surface-0 p-5">
            <div className="text-xs text-muted mb-2">wallet_balance</div>
            <div className="text-xl text-white">
              {balanceLoading ? "..." : formatUSDC(walletBalance)}
            </div>
            <div className="text-xs text-muted mt-1">USDC</div>
          </div>
          <div className="bg-surface-0 p-5 border-l border-accent/30">
            <div className="text-xs text-accent mb-2">shielded_balance</div>
            <div className="text-xl text-white">
              {utxoLoaded ? formatUSDC(shieldedBalance) : "..."}
            </div>
            <div className="text-xs text-muted mt-1">USDC (private)</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border">
          <div className="bg-surface-0 p-5">
            <div className="text-xs text-muted mb-2">pool_vault</div>
            <div className="text-lg text-white">
              {balanceLoading ? "..." : formatUSDC(vaultBalance)}
            </div>
            <div className="text-xs text-muted mt-1">USDC</div>
          </div>
          <div className="bg-surface-0 p-5">
            <div className="text-xs text-muted mb-2">earning_yield</div>
            <div className="text-lg text-white">
              {balanceLoading ? "..." : formatUSDC(ctokenBalance)}
            </div>
            <div className="text-xs text-muted mt-1">cTokens</div>
          </div>
        </div>
      </div>

      {/* Action tabs */}
      <div className="mb-8">
        <div className="flex gap-0 mb-0">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-xs transition-colors ${
                activeTab === tab.key
                  ? "bg-surface-1 text-accent border border-border border-b-surface-1"
                  : "text-muted hover:text-white border border-transparent"
              }`}
            >
              [{tab.label}]
            </button>
          ))}
        </div>
        <div className="border border-border bg-surface-1 p-5">
          {activeTab === "deposit" && <DepositForm />}
          {activeTab === "withdraw" && <WithdrawForm />}
        </div>
      </div>

      {/* Notes / History */}
      <div>
        <div className="flex gap-0 mb-0">
          {(
            [
              { key: "notes" as Section, label: "notes" },
              { key: "history" as Section, label: "history" },
            ] as const
          ).map((sec) => (
            <button
              key={sec.key}
              onClick={() => setActiveSection(sec.key)}
              className={`px-4 py-2 text-xs transition-colors ${
                activeSection === sec.key
                  ? "bg-surface-1 text-accent border border-border border-b-surface-1"
                  : "text-muted hover:text-white border border-transparent"
              }`}
            >
              [{sec.label}]
            </button>
          ))}
        </div>
        <div className="border border-border bg-surface-1 p-5">
          {activeSection === "notes" && <UTXOList />}
          {activeSection === "history" && <TransactionHistory />}
        </div>
      </div>
    </div>
  );
}
