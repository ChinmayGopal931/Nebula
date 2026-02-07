"use client";

import { useState, useEffect, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { POOL_VAULT, POOL_CTOKEN_ACCOUNT, USDC_MINT } from "@/lib/config";
import { useUTXOStore } from "@/stores/utxo-store";

interface PoolBalances {
  shieldedBalance: number; // User's private balance (from local UTXOs)
  walletBalance: number; // User's wallet USDC balance
  vaultBalance: number; // Public on-chain vault balance
  ctokenBalance: number; // cTokens held in klend
  totalPoolValue: number; // vault + ctoken value
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function usePoolBalance(): PoolBalances {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const getBalance = useUTXOStore((s) => s.getBalance);
  const utxos = useUTXOStore((s) => s.utxos);
  const [walletBalance, setWalletBalance] = useState(0);
  const [vaultBalance, setVaultBalance] = useState(0);
  const [ctokenBalance, setCtokenBalance] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const fetches: Promise<any>[] = [
        getAccount(connection, POOL_VAULT),
        getAccount(connection, POOL_CTOKEN_ACCOUNT),
      ];

      // Fetch user's wallet USDC balance
      if (publicKey) {
        const userAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
        fetches.push(getAccount(connection, userAta));
      }

      const results = await Promise.allSettled(fetches);

      setVaultBalance(
        results[0].status === "fulfilled" ? Number(results[0].value.amount) : 0
      );
      setCtokenBalance(
        results[1].status === "fulfilled" ? Number(results[1].value.amount) : 0
      );
      if (results[2]) {
        setWalletBalance(
          results[2].status === "fulfilled" ? Number(results[2].value.amount) : 0
        );
      }
    } catch {
      // Accounts may not exist yet
    } finally {
      setIsLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    shieldedBalance: getBalance(),
    walletBalance,
    vaultBalance,
    ctokenBalance,
    totalPoolValue: vaultBalance + ctokenBalance,
    isLoading,
    refresh,
  };
}
