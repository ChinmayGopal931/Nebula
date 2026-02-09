"use client";

import { useEffect } from "react";
import { usePublicClient } from "wagmi";
import { useTreeStore } from "@/stores/tree-store";
import { useWasm } from "./useWasm";

export function useMerkleTree() {
  const publicClient = usePublicClient();
  const lightWasm = useWasm();
  const {
    tree,
    isSyncing,
    onChainLeafCount,
    error,
    syncFromChain,
    insertCommitments,
  } = useTreeStore();

  useEffect(() => {
    if (lightWasm && publicClient && !tree && !isSyncing) {
      syncFromChain(publicClient, lightWasm);
    }
  }, [lightWasm, publicClient, tree, isSyncing, syncFromChain]);

  return {
    tree,
    isSyncing,
    onChainLeafCount,
    error,
    resync: () => {
      if (lightWasm && publicClient) {
        syncFromChain(publicClient, lightWasm);
      }
    },
    insertCommitments,
  };
}
