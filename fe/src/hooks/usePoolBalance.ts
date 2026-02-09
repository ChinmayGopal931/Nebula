"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { POOL_ADDRESS, USDC_ADDRESS, ERC20_ABI } from "@/lib/config";
import { useUTXOStore } from "@/stores/utxo-store";

interface PoolBalances {
  shieldedBalance: number;
  walletBalance: number;
  vaultBalance: number;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function usePoolBalance(): PoolBalances {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const getBalance = useUTXOStore((s) => s.getBalance);
  const utxos = useUTXOStore((s) => s.utxos);
  const [walletBalance, setWalletBalance] = useState(0);
  const [vaultBalance, setVaultBalance] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    setIsLoading(true);
    try {
      // Fetch pool vault balance (USDC held by pool contract)
      const poolBalance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [POOL_ADDRESS],
      });
      setVaultBalance(Number(poolBalance));

      // Fetch user's wallet USDC balance
      if (address) {
        const userBalance = await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        });
        setWalletBalance(Number(userBalance));
      }
    } catch {
      // Contract may not exist yet
    } finally {
      setIsLoading(false);
    }
  }, [publicClient, address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    shieldedBalance: getBalance(),
    walletBalance,
    vaultBalance,
    isLoading,
    refresh,
  };
}
