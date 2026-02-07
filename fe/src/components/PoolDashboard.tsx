"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePoolBalance } from "@/hooks/usePoolBalance";
import { useMerkleTree } from "@/hooks/useMerkleTree";
import { useUTXOStore } from "@/stores/utxo-store";
import { formatUSDC } from "@/lib/utils";
import { preloadArtifacts, getArtifactLoadStatus } from "@/lib/prover";
import { DepositForm } from "./DepositForm";
import { WithdrawForm } from "./WithdrawForm";
import { MergeForm } from "./MergeForm";
import { UTXOList } from "./UTXOList";
import { TransactionHistory } from "./TransactionHistory";

type Tab = "deposit" | "withdraw" | "merge";
type Section = "notes" | "history";

export function PoolDashboard() {
  const { publicKey } = useWallet();
  const {
    shieldedBalance,
    walletBalance,
    vaultBalance,
    ctokenBalance,
    isLoading: balanceLoading,
    refresh: refreshBalance,
  } = usePoolBalance();
  const { isSyncing, onChainLeafCount } = useMerkleTree();
  const { init: initUtxoStore, isLoaded: utxoLoaded } = useUTXOStore();

  const [activeTab, setActiveTab] = useState<Tab>("deposit");
  const [activeSection, setActiveSection] = useState<Section>("notes");
  const [artifactsReady, setArtifactsReady] = useState(false);

  // Init UTXO store when wallet connects
  useEffect(() => {
    if (publicKey) {
      initUtxoStore(publicKey.toBase58());
    }
  }, [publicKey, initUtxoStore]);

  // Preload ZK artifacts
  useEffect(() => {
    preloadArtifacts().then(() => setArtifactsReady(true));
  }, []);

  const tabs: { key: Tab; label: string }[] = [
    { key: "deposit", label: "Deposit" },
    { key: "withdraw", label: "Withdraw" },
    { key: "merge", label: "Merge" },
  ];

  return (
    <div className="max-w-2xl mx-auto px-4">
      {/* Status bar */}
      <div className="flex items-center gap-4 mb-8 text-xs text-muted">
        <div className="flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              isSyncing ? "bg-yellow-400 animate-pulse" : "bg-accent"
            }`}
          />
          {isSyncing ? "Syncing tree..." : `${onChainLeafCount} leaves`}
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              artifactsReady ? "bg-accent" : "bg-yellow-400 animate-pulse"
            }`}
          />
          {artifactsReady ? "ZK ready" : "Loading artifacts..."}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-accent" />
          Devnet
        </div>
      </div>

      {/* Balance cards */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="border border-border p-5 bg-surface-1">
          <div className="text-xs text-muted mb-2 uppercase tracking-wide">
            Wallet Balance
          </div>
          <div className="text-2xl font-mono">
            {balanceLoading ? "--" : formatUSDC(walletBalance)}
          </div>
          <div className="text-xs text-muted mt-1">USDC</div>
        </div>
        <div className="border border-accent/30 p-5 bg-surface-1">
          <div className="text-xs text-muted mb-2 uppercase tracking-wide">
            Shielded Balance
          </div>
          <div className="text-2xl font-mono">
            {utxoLoaded ? formatUSDC(shieldedBalance) : "--"}
          </div>
          <div className="text-xs text-muted mt-1">USDC (private)</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="border border-border p-5 bg-surface-1">
          <div className="text-xs text-muted mb-2 uppercase tracking-wide">
            Pool Vault
          </div>
          <div className="text-lg font-mono">
            {balanceLoading ? "--" : formatUSDC(vaultBalance)}
          </div>
          <div className="text-xs text-muted mt-1">USDC</div>
        </div>
        <div className="border border-border p-5 bg-surface-1">
          <div className="text-xs text-muted mb-2 uppercase tracking-wide">
            Earning Yield
          </div>
          <div className="text-lg font-mono">
            {balanceLoading ? "--" : formatUSDC(ctokenBalance)}
          </div>
          <div className="text-xs text-muted mt-1">cTokens</div>
        </div>
      </div>

      {/* Action tabs */}
      <div className="border border-border bg-surface-1 mb-8">
        <div className="flex border-b border-border">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 py-3 text-sm transition-colors ${
                activeTab === tab.key
                  ? "text-white border-b-2 border-accent"
                  : "text-muted hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="p-5">
          {activeTab === "deposit" && <DepositForm />}
          {activeTab === "withdraw" && <WithdrawForm />}
          {activeTab === "merge" && <MergeForm />}
        </div>
      </div>

      {/* Notes / History section */}
      <div className="border border-border bg-surface-1">
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveSection("notes")}
            className={`flex-1 py-3 text-sm transition-colors ${
              activeSection === "notes"
                ? "text-white border-b-2 border-accent"
                : "text-muted hover:text-white"
            }`}
          >
            Notes
          </button>
          <button
            onClick={() => setActiveSection("history")}
            className={`flex-1 py-3 text-sm transition-colors ${
              activeSection === "history"
                ? "text-white border-b-2 border-accent"
                : "text-muted hover:text-white"
            }`}
          >
            History
          </button>
        </div>
        <div className="p-5">
          {activeSection === "notes" && <UTXOList />}
          {activeSection === "history" && <TransactionHistory />}
        </div>
      </div>
    </div>
  );
}
