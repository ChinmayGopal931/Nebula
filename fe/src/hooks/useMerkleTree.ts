"use client";

import { useEffect } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useTreeStore } from "@/stores/tree-store";
import { useWasm } from "./useWasm";

export function useMerkleTree() {
  const { connection } = useConnection();
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
    if (lightWasm && !tree && !isSyncing) {
      syncFromChain(connection, lightWasm);
    }
  }, [lightWasm, tree, isSyncing, connection, syncFromChain]);

  return {
    tree,
    isSyncing,
    onChainLeafCount,
    error,
    resync: () => {
      if (lightWasm) {
        syncFromChain(connection, lightWasm);
      }
    },
    insertCommitments,
  };
}
