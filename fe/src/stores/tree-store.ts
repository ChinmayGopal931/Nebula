import { create } from "zustand";
import { type PublicClient, parseAbiItem } from "viem";
import { LightWasm } from "@lightprotocol/hasher.rs";
import { MerkleTree } from "@/lib/merkle-tree";
import { POOL_ADDRESS } from "@/lib/config";
import { DEFAULT_HEIGHT } from "@/lib/constants";

interface TreeState {
  tree: MerkleTree | null;
  isSyncing: boolean;
  onChainLeafCount: number;
  error: string | null;

  initTree: (lightWasm: LightWasm) => void;
  syncFromChain: (
    publicClient: PublicClient,
    lightWasm: LightWasm
  ) => Promise<void>;
  insertCommitments: (commitments: string[]) => void;
}

export const useTreeStore = create<TreeState>((set, get) => ({
  tree: null,
  isSyncing: false,
  onChainLeafCount: 0,
  error: null,

  initTree: (lightWasm: LightWasm) => {
    set({ tree: new MerkleTree(DEFAULT_HEIGHT, lightWasm) });
  },

  syncFromChain: async (
    publicClient: PublicClient,
    lightWasm: LightWasm
  ) => {
    set({ isSyncing: true, error: null });

    try {
      // Query NewCommitment events from the PrivacyPool contract
      const logs = await publicClient.getLogs({
        address: POOL_ADDRESS,
        event: parseAbiItem(
          "event NewCommitment(uint256 indexed commitment, uint256 index, bytes encryptedOutput)"
        ),
        fromBlock: 0n,
        toBlock: "latest",
      });

      // Sort by blockNumber + logIndex for correct ordering
      const sortedLogs = [...logs].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return Number(a.blockNumber! - b.blockNumber!);
        }
        return (a.logIndex ?? 0) - (b.logIndex ?? 0);
      });

      const freshTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

      for (const log of sortedLogs) {
        const commitment = (log.args as any).commitment as bigint;
        freshTree.insert(commitment.toString());
      }

      set({
        tree: freshTree,
        isSyncing: false,
        onChainLeafCount: sortedLogs.length,
      });
    } catch (err: any) {
      set({
        isSyncing: false,
        error: err.message || "Failed to sync tree",
      });
    }
  },

  insertCommitments: (commitments: string[]) => {
    const { tree } = get();
    if (!tree) return;

    for (const c of commitments) {
      tree.insert(c);
    }

    set({
      tree,
      onChainLeafCount: tree.nextIndex,
    });
  },
}));
