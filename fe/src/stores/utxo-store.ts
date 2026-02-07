import { create } from "zustand";
import { openDB, IDBPDatabase } from "idb";

export interface StoredUTXO {
  id: string; // commitment hash
  amount: string; // BN serialized
  blinding: string; // BN serialized
  keypairPrivkey: string; // hex string (ZK privkey)
  index: number; // merkle tree leaf index
  mintAddress: string; // USDC mint base58
  spent: boolean;
  createdAt: number;
  txSignature: string;
}

export interface TransactionRecord {
  signature: string;
  type: "deposit" | "withdraw" | "merge";
  amount: number; // in USDC lamports
  timestamp: number;
  utxoIds: string[]; // committed UTXOs
}

interface UTXOState {
  utxos: StoredUTXO[];
  transactions: TransactionRecord[];
  walletKey: string | null;
  isLoaded: boolean;

  // Actions
  init: (walletKey: string) => Promise<void>;
  addUTXO: (utxo: StoredUTXO) => Promise<void>;
  markSpent: (id: string) => Promise<void>;
  addTransaction: (tx: TransactionRecord) => Promise<void>;
  getUnspent: () => StoredUTXO[];
  getBalance: () => number;
  clear: () => void;
}

const DB_NAME = "privacy-yield";
const DB_VERSION = 1;

async function getDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("utxos")) {
        const utxoStore = db.createObjectStore("utxos", { keyPath: "id" });
        utxoStore.createIndex("walletKey", "walletKey");
        utxoStore.createIndex("spent", "spent");
      }
      if (!db.objectStoreNames.contains("transactions")) {
        const txStore = db.createObjectStore("transactions", {
          keyPath: "signature",
        });
        txStore.createIndex("walletKey", "walletKey");
      }
    },
  });
}

export const useUTXOStore = create<UTXOState>((set, get) => ({
  utxos: [],
  transactions: [],
  walletKey: null,
  isLoaded: false,

  init: async (walletKey: string) => {
    const db = await getDB();

    // Load UTXOs for this wallet
    const allUtxos = await db.getAll("utxos");
    const walletUtxos = allUtxos.filter(
      (u: any) => u.walletKey === walletKey
    ) as (StoredUTXO & { walletKey: string })[];

    // Load transactions for this wallet
    const allTxs = await db.getAll("transactions");
    const walletTxs = allTxs.filter(
      (t: any) => t.walletKey === walletKey
    ) as (TransactionRecord & { walletKey: string })[];

    set({
      utxos: walletUtxos,
      transactions: walletTxs.sort((a, b) => b.timestamp - a.timestamp),
      walletKey,
      isLoaded: true,
    });
  },

  addUTXO: async (utxo: StoredUTXO) => {
    const { walletKey } = get();
    if (!walletKey) return;

    const db = await getDB();
    await db.put("utxos", { ...utxo, walletKey });

    set((state) => ({
      utxos: [...state.utxos, utxo],
    }));
  },

  markSpent: async (id: string) => {
    const { walletKey, utxos } = get();
    if (!walletKey) return;

    const utxo = utxos.find((u) => u.id === id);
    if (!utxo) return;

    const updated = { ...utxo, spent: true };
    const db = await getDB();
    await db.put("utxos", { ...updated, walletKey });

    set((state) => ({
      utxos: state.utxos.map((u) => (u.id === id ? updated : u)),
    }));
  },

  addTransaction: async (tx: TransactionRecord) => {
    const { walletKey } = get();
    if (!walletKey) return;

    const db = await getDB();
    await db.put("transactions", { ...tx, walletKey });

    set((state) => ({
      transactions: [tx, ...state.transactions],
    }));
  },

  getUnspent: () => {
    return get().utxos.filter((u) => !u.spent);
  },

  getBalance: () => {
    return get()
      .utxos.filter((u) => !u.spent)
      .reduce((sum, u) => sum + parseInt(u.amount), 0);
  },

  clear: () => {
    set({
      utxos: [],
      transactions: [],
      walletKey: null,
      isLoaded: false,
    });
  },
}));
