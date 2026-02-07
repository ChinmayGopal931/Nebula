import { create } from "zustand";
import { Connection, PublicKey } from "@solana/web3.js";
import { LightWasm } from "@lightprotocol/hasher.rs";
import BN from "bn.js";
import { MerkleTree } from "@/lib/merkle-tree";
import { TREE_ACCOUNT_PDA, PRIVACY_YIELD_PROGRAM_ID } from "@/lib/config";
import { DEFAULT_HEIGHT } from "@/lib/constants";

interface TreeState {
  tree: MerkleTree | null;
  isSyncing: boolean;
  lastSyncedSignature: string | null;
  onChainLeafCount: number;
  error: string | null;

  initTree: (lightWasm: LightWasm) => void;
  syncFromChain: (
    connection: Connection,
    lightWasm: LightWasm
  ) => Promise<void>;
  insertCommitments: (commitments: string[]) => void;
}

export const useTreeStore = create<TreeState>((set, get) => ({
  tree: null,
  isSyncing: false,
  lastSyncedSignature: null,
  onChainLeafCount: 0,
  error: null,

  initTree: (lightWasm: LightWasm) => {
    set({ tree: new MerkleTree(DEFAULT_HEIGHT, lightWasm) });
  },

  syncFromChain: async (
    connection: Connection,
    lightWasm: LightWasm
  ) => {
    set({ isSyncing: true, error: null });

    try {
      // Read on-chain tree state
      const treeAccount = await connection.getAccountInfo(TREE_ACCOUNT_PDA);
      if (!treeAccount) {
        set({ isSyncing: false, error: "Tree account not found" });
        return;
      }

      // MerkleTreeAccount layout (zero_copy):
      // 8 (discriminator) + 32 (authority) + 8 (next_index u64)
      const nextIndex = Number(
        treeAccount.data.readBigUInt64LE(8 + 32)
      );

      const { tree } = get();
      let currentTree = tree;

      if (!currentTree) {
        currentTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
      }

      // Fetch commitment events from transaction history
      const signatures = await connection.getSignaturesForAddress(
        TREE_ACCOUNT_PDA,
        { limit: 1000 },
        "confirmed"
      );

      // Process in chronological order (oldest first)
      const sortedSigs = [...signatures].reverse();

      const commitments: string[] = [];

      for (const sigInfo of sortedSigs) {
        if (sigInfo.err) continue;

        try {
          const tx = await connection.getParsedTransaction(
            sigInfo.signature,
            {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            }
          );
          if (!tx?.meta?.logMessages) continue;

          // Parse CommitmentData events from logs
          // Anchor events are base64-encoded in logs after "Program data: "
          for (const log of tx.meta.logMessages) {
            if (!log.startsWith("Program data: ")) continue;
            const data = log.slice("Program data: ".length);

            try {
              const bytes = Uint8Array.from(atob(data), (c) =>
                c.charCodeAt(0)
              );

              // Check CommitmentData discriminator: [13, 110, 215, 127, 244, 62, 234, 34]
              const disc = [13, 110, 215, 127, 244, 62, 234, 34];
              const isCommitment = disc.every(
                (b, i) => bytes[i] === b
              );
              if (!isCommitment || bytes.length < 48) continue;

              // Parse: 8 (disc) + 8 (index u64) + 32 (commitment [u8; 32])
              const commitment = bytes.slice(16, 48);
              const commitmentBN = new BN(
                Array.from(commitment),
                16,
                "be"
              );
              commitments.push(commitmentBN.toString());
            } catch {
              // Skip unparseable logs
            }
          }
        } catch {
          // Skip failed tx fetches
        }
      }

      // If we got commitments from events, use them
      if (commitments.length > 0) {
        const freshTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
        for (const c of commitments) {
          freshTree.insert(c);
        }
        set({
          tree: freshTree,
          isSyncing: false,
          onChainLeafCount: nextIndex,
          lastSyncedSignature:
            sortedSigs.length > 0
              ? sortedSigs[sortedSigs.length - 1].signature
              : null,
        });
      } else {
        // Fallback: insert placeholder zeros for existing leaves
        const freshTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
        for (let i = 0; i < nextIndex; i++) {
          freshTree.insert("0");
        }
        set({
          tree: freshTree,
          isSyncing: false,
          onChainLeafCount: nextIndex,
        });
      }
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
