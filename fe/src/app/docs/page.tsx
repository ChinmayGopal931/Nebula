"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";

const ASCII_DOCS = [
  "    ██████╗  ██████╗  ██████╗███████╗",
  "    ██╔══██╗██╔═══██╗██╔════╝██╔════╝",
  "    ██║  ██║██║   ██║██║     ███████╗",
  "    ██║  ██║██║   ██║██║     ╚════██║",
  "    ██████╔╝╚██████╔╝╚██████╗███████║",
  "    ╚═════╝  ╚═════╝  ╚═════╝╚══════╝",
];

interface HistoryLine {
  text: string;
  style: string;
}

const TOPICS: Record<string, HistoryLine[]> = {
  help: [
    { text: "", style: "" },
    { text: "available commands:", style: "text-accent" },
    { text: "", style: "" },
    { text: "  what         — what is plasma?", style: "text-white" },
    { text: "  how          — how does it work?", style: "text-white" },
    { text: "  deposit      — how deposits work", style: "text-white" },
    { text: "  withdraw     — how withdrawals work", style: "text-white" },
    { text: "  merge        — what is merging?", style: "text-white" },
    { text: "  privacy      — how is privacy achieved?", style: "text-white" },
    {
      text: "  zk           — what are zero-knowledge proofs?",
      style: "text-white",
    },
    { text: "  utxo         — what are shielded notes?", style: "text-white" },
    {
      text: "  merkle       — how does the merkle tree work?",
      style: "text-white",
    },
    { text: "  yield        — how does yield work?", style: "text-white" },
    { text: "  fees         — are there fees?", style: "text-white" },
    { text: "  trust        — what do I need to trust?", style: "text-white" },
    { text: "  contracts    — smart contract addresses", style: "text-white" },
    { text: "  contact      — links and socials", style: "text-white" },
    { text: "  clear        — clear terminal", style: "text-white" },
    { text: "  back         — return to vault", style: "text-white" },
    { text: "", style: "" },
    { text: "type any command and press [ENTER]", style: "text-muted" },
    { text: "", style: "" },
  ],
  what: [
    { text: "", style: "" },
    { text: "PLASMA — private yield protocol", style: "text-accent font-bold" },
    { text: "", style: "" },
    {
      text: "plasma is a privacy pool on MegaETH that breaks the on-chain",
      style: "text-white",
    },
    { text: "link between deposits and withdrawals.", style: "text-white" },
    { text: "", style: "" },
    {
      text: "you deposit USDC into a shielded pool. you receive encrypted",
      style: "text-white",
    },
    {
      text: "notes (UTXOs) that only you can see. when you withdraw, nobody",
      style: "text-white",
    },
    { text: "can tell which deposit it came from.", style: "text-white" },
    { text: "", style: "" },
    {
      text: "while your funds sit in the pool, they earn yield automatically.",
      style: "text-white",
    },
    {
      text: "all of this is verified by zero-knowledge proofs — no trust",
      style: "text-white",
    },
    {
      text: "required. the smart contract enforces everything.",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "tl;dr: deposit USDC. earn yield. withdraw anywhere. privately.",
      style: "text-accent",
    },
    { text: "", style: "" },
  ],
  how: [
    { text: "", style: "" },
    { text: "how it works — step by step", style: "text-accent font-bold" },
    { text: "", style: "" },
    { text: "1. DEPOSIT", style: "text-green-500" },
    {
      text: "   you commit USDC to the pool. the contract stores a",
      style: "text-white",
    },
    {
      text: "   cryptographic commitment in a merkle tree. you get a",
      style: "text-white",
    },
    {
      text: "   shielded note (UTXO) stored locally in your browser.",
      style: "text-white",
    },
    { text: "", style: "" },
    { text: "2. PROVE", style: "text-green-500" },
    {
      text: "   when you want to withdraw, your browser generates a",
      style: "text-white",
    },
    {
      text: "   groth16 zero-knowledge proof. this proof says:",
      style: "text-white",
    },
    {
      text: '   "I know a valid note in the tree" without revealing which.',
      style: "text-muted",
    },
    { text: "", style: "" },
    { text: "3. WITHDRAW", style: "text-green-500" },
    {
      text: "   the contract verifies the proof on-chain, checks the",
      style: "text-white",
    },
    {
      text: "   nullifier hasn't been used (prevents double-spend),",
      style: "text-white",
    },
    {
      text: "   and sends USDC to any address you specify.",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "the contract never knows which deposit corresponds to",
      style: "text-accent",
    },
    { text: "which withdrawal. that's the privacy.", style: "text-accent" },
    { text: "", style: "" },
  ],
  deposit: [
    { text: "", style: "" },
    { text: "deposits", style: "text-accent font-bold" },
    { text: "", style: "" },
    { text: "when you deposit USDC:", style: "text-white" },
    { text: "", style: "" },
    {
      text: "  1. your browser generates a random keypair (poseidon-based)",
      style: "text-white",
    },
    {
      text: "  2. creates a UTXO: commitment = poseidon(amount, pubkey, blinding)",
      style: "text-white",
    },
    {
      text: "  3. generates a ZK proof that the commitment is valid",
      style: "text-white",
    },
    {
      text: "  4. sends USDC + proof to the pool contract",
      style: "text-white",
    },
    {
      text: "  5. contract verifies proof, takes USDC, inserts commitment",
      style: "text-white",
    },
    { text: "     into the merkle tree", style: "text-white" },
    { text: "", style: "" },
    {
      text: "your note is stored in your browser's IndexedDB. if you lose",
      style: "text-yellow-500",
    },
    {
      text: "it, you lose access to your funds. back up your keypair.",
      style: "text-yellow-500",
    },
    { text: "", style: "" },
    {
      text: "the pool auto-deposits idle USDC into a yield vault.",
      style: "text-muted",
    },
    { text: "", style: "" },
  ],
  withdraw: [
    { text: "", style: "" },
    { text: "withdrawals", style: "text-accent font-bold" },
    { text: "", style: "" },
    { text: "when you withdraw:", style: "text-white" },
    { text: "", style: "" },
    {
      text: "  1. select a note (UTXO) from your local wallet",
      style: "text-white",
    },
    {
      text: "  2. enter amount — full or partial (change note created)",
      style: "text-white",
    },
    {
      text: "  3. optionally enter a different recipient address",
      style: "text-white",
    },
    { text: "  4. browser generates a ZK proof proving:", style: "text-white" },
    {
      text: "     - you know the secret key for the note",
      style: "text-muted",
    },
    { text: "     - the note exists in the merkle tree", style: "text-muted" },
    {
      text: "     - the nullifier is fresh (not double-spent)",
      style: "text-muted",
    },
    { text: "     - the amounts balance out correctly", style: "text-muted" },
    {
      text: "  5. contract verifies proof, records nullifier, sends USDC",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "the recipient address is included in the proof's public",
      style: "text-white",
    },
    {
      text: "inputs — nobody can tamper with it after proving.",
      style: "text-white",
    },
    { text: "", style: "" },
  ],
  merge: [
    { text: "", style: "" },
    { text: "merging notes", style: "text-accent font-bold" },
    { text: "", style: "" },
    {
      text: "merge combines two small notes into one larger note.",
      style: "text-white",
    },
    { text: "this is useful for consolidating dust.", style: "text-white" },
    { text: "", style: "" },
    {
      text: "  input:  note A (500 USDC) + note B (300 USDC)",
      style: "text-muted",
    },
    { text: "  output: note C (800 USDC)", style: "text-green-500" },
    { text: "", style: "" },
    {
      text: "no USDC enters or leaves the pool during a merge.",
      style: "text-white",
    },
    {
      text: "it's a purely internal operation verified by ZK proof.",
      style: "text-white",
    },
    {
      text: "both input notes are nullified, one new note is created.",
      style: "text-white",
    },
    { text: "", style: "" },
  ],
  privacy: [
    { text: "", style: "" },
    { text: "privacy model", style: "text-accent font-bold" },
    { text: "", style: "" },
    { text: "what is hidden:", style: "text-green-500" },
    {
      text: "  - which deposit corresponds to which withdrawal",
      style: "text-white",
    },
    { text: "  - your total balance in the pool", style: "text-white" },
    { text: "  - how many notes you have", style: "text-white" },
    {
      text: "  - the link between your deposit and withdrawal addresses",
      style: "text-white",
    },
    { text: "", style: "" },
    { text: "what is public:", style: "text-yellow-500" },
    { text: "  - total pool TVL (sum of all deposits)", style: "text-white" },
    { text: "  - individual deposit/withdrawal amounts", style: "text-white" },
    {
      text: "  - that a deposit or withdrawal happened (just not whose)",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "privacy set = all deposits of the same denomination since",
      style: "text-white",
    },
    {
      text: "the pool started. larger pool = stronger privacy.",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "the system uses a UTXO model (like zcash) with variable",
      style: "text-muted",
    },
    {
      text: "amounts, not fixed denominations (like tornado cash).",
      style: "text-muted",
    },
    { text: "", style: "" },
  ],
  zk: [
    { text: "", style: "" },
    { text: "zero-knowledge proofs", style: "text-accent font-bold" },
    { text: "", style: "" },
    {
      text: "plasma uses groth16 ZK-SNARKs on the BN254 curve.",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "a ZK proof lets you prove a statement is true without",
      style: "text-white",
    },
    {
      text: "revealing the underlying data. in our case:",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: '  "I know a valid note in the merkle tree with sufficient',
      style: "text-muted",
    },
    {
      text: '   balance, and I know the secret key to spend it."',
      style: "text-muted",
    },
    { text: "", style: "" },
    {
      text: "the verifier (smart contract) can confirm this is true",
      style: "text-white",
    },
    {
      text: "without learning which note, which balance, or which key.",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "circuit: 2-input, 2-output UTXO transaction (circom)",
      style: "text-muted",
    },
    {
      text: "prover:  snarkjs WASM (runs in your browser, ~5-15s)",
      style: "text-muted",
    },
    { text: "verifier: solidity (on-chain, ~200k gas)", style: "text-muted" },
    { text: "curve:   BN254 (alt_bn128)", style: "text-muted" },
    {
      text: "hash:    poseidon (ZK-friendly, ~8x cheaper than SHA256)",
      style: "text-muted",
    },
    { text: "", style: "" },
  ],
  utxo: [
    { text: "", style: "" },
    { text: "shielded notes (UTXOs)", style: "text-accent font-bold" },
    { text: "", style: "" },
    {
      text: "a note is an encrypted record of ownership:",
      style: "text-white",
    },
    { text: "", style: "" },
    { text: "  struct Note {", style: "text-muted" },
    {
      text: "    amount:    u64     // USDC amount (6 decimals)",
      style: "text-muted",
    },
    {
      text: "    pubkey:    field   // owner's poseidon public key",
      style: "text-muted",
    },
    {
      text: "    blinding:  field   // random 248-bit blinding factor",
      style: "text-muted",
    },
    { text: "  }", style: "text-muted" },
    { text: "", style: "" },
    {
      text: "  commitment = poseidon(amount, pubkey, blinding)",
      style: "text-green-500",
    },
    {
      text: "  nullifier  = poseidon(commitment, privkey, pathIndex)",
      style: "text-green-500",
    },
    { text: "", style: "" },
    {
      text: "the commitment goes on-chain (in the merkle tree).",
      style: "text-white",
    },
    {
      text: "the nullifier is revealed only when you spend the note.",
      style: "text-white",
    },
    {
      text: "nobody can link a commitment to its nullifier without",
      style: "text-white",
    },
    { text: "knowing the private key.", style: "text-white" },
    { text: "", style: "" },
  ],
  merkle: [
    { text: "", style: "" },
    { text: "merkle tree", style: "text-accent font-bold" },
    { text: "", style: "" },
    {
      text: "the pool uses an append-only merkle tree (height 26).",
      style: "text-white",
    },
    { text: "that's 2^26 = 67,108,864 possible notes.", style: "text-white" },
    { text: "", style: "" },
    {
      text: "when you deposit, your commitment is inserted as the next",
      style: "text-white",
    },
    {
      text: "leaf. the contract stores only the root + a history of",
      style: "text-white",
    },
    {
      text: "100 recent roots (not the full tree — that would be huge).",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "to prove membership, you provide a merkle path (26 hashes)",
      style: "text-white",
    },
    {
      text: "inside your ZK proof. the circuit verifies the path leads",
      style: "text-white",
    },
    {
      text: "to a known root. the contract checks the root exists in",
      style: "text-white",
    },
    { text: "its history buffer.", style: "text-white" },
    { text: "", style: "" },
    {
      text: "your browser rebuilds the tree from NewCommitment events",
      style: "text-muted",
    },
    {
      text: "emitted by the contract — fully trustless, no indexer.",
      style: "text-muted",
    },
    { text: "", style: "" },
  ],
  yield: [
    { text: "", style: "" },
    { text: "yield", style: "text-accent font-bold" },
    { text: "", style: "" },
    {
      text: "idle USDC in the pool is automatically deployed to a",
      style: "text-white",
    },
    {
      text: "yield vault (ERC-4626 compatible). this happens inside",
      style: "text-white",
    },
    { text: "the transact() function:", style: "text-white" },
    { text: "", style: "" },
    {
      text: "  on deposit:    USDC enters pool -> auto-swept to vault",
      style: "text-green-500",
    },
    {
      text: "  on withdraw:   vault redeems -> USDC sent to recipient",
      style: "text-green-500",
    },
    {
      text: "  on merge:      no yield operation (internal only)",
      style: "text-muted",
    },
    { text: "", style: "" },
    {
      text: "yield accrues to the pool collectively. when you withdraw,",
      style: "text-white",
    },
    {
      text: "you get your deposited amount — yield distribution is a",
      style: "text-white",
    },
    {
      text: "future feature (requires protocol-level accounting).",
      style: "text-white",
    },
    { text: "", style: "" },
  ],
  fees: [
    { text: "", style: "" },
    { text: "fees", style: "text-accent font-bold" },
    { text: "", style: "" },
    { text: "currently: zero fees.", style: "text-green-500" },
    { text: "", style: "" },
    {
      text: "the fee field exists in the protocol (it's part of the",
      style: "text-white",
    },
    {
      text: "circuit's extDataHash) but is set to 0. this means:",
      style: "text-white",
    },
    { text: "", style: "" },
    { text: "  - no protocol fee on deposit/withdraw", style: "text-white" },
    {
      text: "  - no relayer fee (you pay gas directly for now)",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "fees will be enabled when the relayer is added (phase 6).",
      style: "text-muted",
    },
    {
      text: "the relayer will charge a small fee to submit your",
      style: "text-muted",
    },
    {
      text: "withdrawal tx, which provides IP-level privacy.",
      style: "text-muted",
    },
    { text: "", style: "" },
  ],
  trust: [
    { text: "", style: "" },
    { text: "trust assumptions", style: "text-accent font-bold" },
    { text: "", style: "" },
    { text: "what you trust:", style: "text-yellow-500" },
    {
      text: "  - the circom circuit is correct (auditable, open source)",
      style: "text-white",
    },
    {
      text: "  - the trusted setup was not compromised (groth16 req.)",
      style: "text-white",
    },
    {
      text: "  - the smart contract is correct (auditable, immutable)",
      style: "text-white",
    },
    {
      text: "  - your browser environment is not compromised",
      style: "text-white",
    },
    { text: "", style: "" },
    { text: "what you DON'T trust:", style: "text-green-500" },
    { text: "  - the pool operator (permissionless)", style: "text-white" },
    {
      text: "  - other users (ZK proofs enforce all rules)",
      style: "text-white",
    },
    {
      text: "  - any relayer or indexer (client rebuilds tree from events)",
      style: "text-white",
    },
    {
      text: "  - MegaETH validators (standard EVM security assumptions)",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "the protocol is non-custodial. your notes are encrypted",
      style: "text-muted",
    },
    {
      text: "locally. only you can spend them with your private key.",
      style: "text-muted",
    },
    { text: "", style: "" },
  ],
  contracts: [
    { text: "", style: "" },
    {
      text: "smart contracts (MegaETH testnet, chain 6343)",
      style: "text-accent font-bold",
    },
    { text: "", style: "" },
    {
      text: "  PrivacyPool   0xD1065321bB703203F1EE29Acc073C6d1eA1A28E2",
      style: "text-white",
    },
    {
      text: "  Verifier      0x567B24545cF1739A300cCDbA0E72ec07Ad6971F4",
      style: "text-white",
    },
    {
      text: "  MockUSDC      0x7b70eD83f826cE59e65BF1711D60C6F27a0B2eB1",
      style: "text-white",
    },
    {
      text: "  PoseidonT3    0x4668c470b212fB833d80b85176a52F0fe6684e6D",
      style: "text-white",
    },
    { text: "", style: "" },
    {
      text: "  RPC:          https://carrot.megaeth.com/rpc",
      style: "text-muted",
    },
    { text: "  Chain ID:     6343", style: "text-muted" },
    { text: "  Explorer:     https://megaexplorer.xyz", style: "text-muted" },
    { text: "", style: "" },
  ],
  contact: [
    { text: "", style: "" },
    { text: "contact", style: "text-accent font-bold" },
    { text: "", style: "" },
    { text: "  twitter:      https://x.com/plasmapayapp", style: "text-white" },
    { text: "  website:      https://plasmapay.app", style: "text-white" },
    { text: "", style: "" },
  ],
};

// Fuzzy match topics
function findTopic(input: string): string | null {
  const lower = input.toLowerCase().trim();
  if (!lower) return null;
  // Exact match
  if (TOPICS[lower]) return lower;
  // Prefix match
  const match = Object.keys(TOPICS).find((k) => k.startsWith(lower));
  if (match) return match;
  // Keyword match
  const keywords: Record<string, string[]> = {
    what: ["plasma", "about", "wtf", "explain", "info"],
    how: ["work", "process", "flow", "steps"],
    deposit: ["add", "put", "send", "fund"],
    withdraw: ["take", "remove", "get", "cash", "exit"],
    merge: ["combine", "consolidate", "join"],
    privacy: ["private", "anonymous", "anon", "hidden", "secret"],
    zk: ["zero", "knowledge", "proof", "snark", "groth", "groth16", "zkp"],
    utxo: ["note", "notes", "commitment", "nullifier", "unspent"],
    merkle: ["tree", "root", "leaf", "hash"],
    yield: ["earn", "interest", "apy", "vault", "return"],
    fees: ["fee", "cost", "price", "charge", "gas"],
    trust: ["trust", "security", "safe", "risk", "assumption", "audit"],
    contracts: ["contract", "address", "deployed", "chain", "rpc"],
    contact: ["contact", "twitter", "social", "link", "dm", "reach"],
    help: ["commands", "list", "options", "menu", "?"],
    clear: ["cls", "reset"],
    back: ["exit", "quit", "leave", "return", "home", "pool"],
  };
  for (const [topic, words] of Object.entries(keywords)) {
    if (words.some((w) => lower.includes(w))) return topic;
  }
  return null;
}

const INTRO: HistoryLine[] = [
  { text: "PLASMA protocol documentation", style: "text-accent" },
  {
    text: "interactive terminal — type a question or command",
    style: "text-muted",
  },
  { text: "", style: "" },
  { text: "type 'help' to see available topics", style: "text-muted" },
  { text: "", style: "" },
];

export default function DocsPage() {
  const [history, setHistory] = useState<HistoryLine[]>([...INTRO]);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const val = inputValue.trim();
      if (!val) return;

      const newLines: HistoryLine[] = [
        { text: `> ${val}`, style: "text-white" },
      ];

      if (val.toLowerCase() === "clear" || val.toLowerCase() === "cls") {
        setHistory([...INTRO]);
        setInputValue("");
        return;
      }

      if (
        val.toLowerCase() === "back" ||
        val.toLowerCase() === "exit" ||
        val.toLowerCase() === "quit"
      ) {
        window.location.href = "/pool";
        return;
      }

      const topic = findTopic(val);
      if (topic) {
        newLines.push(...TOPICS[topic]);
      } else {
        newLines.push(
          { text: "", style: "" },
          { text: `unknown command: '${val}'`, style: "text-red-500" },
          { text: "type 'help' for available topics", style: "text-muted" },
          { text: "", style: "" },
        );
      }

      setHistory((h) => [...h, ...newLines]);
      setInputValue("");
    },
    [inputValue],
  );

  return (
    <div className="min-h-screen bg-surface-0 flex flex-col">
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-2xl">
          {/* Terminal window */}
          <div className="border border-border">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface-1">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <span className="ml-3 text-[10px] text-muted tracking-wider">
                plasma@megaeth-testnet ~ /docs
              </span>
            </div>

            {/* Terminal body */}
            <div className="bg-[#080808] p-4 sm:p-6 min-h-[520px] max-h-[80vh] overflow-y-auto overflow-x-hidden font-mono">
              {/* ASCII art */}
              <pre
                className="font-['Courier_New',_Courier,_monospace] font-bold leading-[1em] tracking-normal whitespace-pre overflow-x-auto select-none text-accent/70 mb-4 text-[9px] sm:text-[11px] [font-smooth:never] [-webkit-font-smoothing:none]"
                style={{
                  fontVariantLigatures: 'none',
                  textRendering: 'optimizeSpeed',
                  WebkitTextStroke: '0.3px currentColor',
                }}
              >
                {ASCII_DOCS.join("\n")}
              </pre>

              <div className="text-border text-xs mb-4 select-none overflow-hidden">
                {"─".repeat(60)}
              </div>

              {/* History */}
              <div className="space-y-0.5 mb-2">
                {history.map((line, i) => {
                  if (line.text === "")
                    return <div key={i} className="h-2.5" />;
                  return (
                    <div
                      key={i}
                      className={`text-xs leading-relaxed ${line.style}`}
                    >
                      {line.text}
                    </div>
                  );
                })}
              </div>

              {/* Input */}
              <form
                onSubmit={handleSubmit}
                className="flex items-center gap-2 mt-1"
              >
                <span className="text-xs text-accent shrink-0">{">"}</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  className="flex-1 bg-transparent border-none outline-none text-xs text-white caret-accent"
                  placeholder="type a command..."
                  autoComplete="off"
                  spellCheck={false}
                />
              </form>

              <div ref={bottomRef} />
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-3 text-[10px] text-muted/40 px-1">
            <Link href="/pool" className="hover:text-accent transition-colors">
              {"<-"} back to vault
            </Link>
            <div className="flex items-center gap-3">
              <a
                href="https://x.com/plasmapayapp"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent transition-colors"
              >
                twitter
              </a>
              <span>type &apos;help&apos; for commands</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
