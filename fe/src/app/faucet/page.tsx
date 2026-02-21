"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { USDC_MINT } from "@/lib/config";
import Link from "next/link";
import { WalletButton } from "@/components/WalletButton";

const ASCII_FAUCET = [
  "    ██╗   ██╗███████╗██████╗   ██████╗",
  "    ██║   ██║██╔════╝██╔══██╗ ██╔════╝",
  "    ██║   ██║███████╗██║   ██║ ██║     ",
  "    ██║   ██║╚════██║██║   ██║ ██║     ",
  "     ╚█████╔╝███████║██████╝  ██████╗",
  "     ╚═════╝ ╚══════╝╚═════╝   ╚═════╝",
];

type Step = "address" | "amount" | "confirm" | "minting" | "done";

interface HistoryLine {
  text: string;
  style: string;
}

function isValidSolanaAddress(addr: string): boolean {
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

export default function FaucetPage() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const [step, setStep] = useState<Step>("address");
  const [inputValue, setInputValue] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [txSignature, setTxSignature] = useState("");
  const [history, setHistory] = useState<HistoryLine[]>([
    { text: "PLASMA testnet USDC faucet", style: "text-accent" },
    { text: "mint test tokens for the privacy pool", style: "text-muted" },
    { text: "", style: "" },
  ]);

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, step]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  // Pre-fill address if wallet connected
  useEffect(() => {
    if (connected && publicKey && step === "address" && !recipientAddress) {
      setInputValue(publicKey.toBase58());
    }
  }, [connected, publicKey, step, recipientAddress]);

  const addLine = useCallback((text: string, style: string) => {
    setHistory((h) => [...h, { text, style }]);
  }, []);

  const executeMint = useCallback(async () => {
    if (!publicKey || !connected) return;

    setStep("minting");
    addLine("", "");
    addLine("building transaction...", "text-muted");

    try {
      const recipient = new PublicKey(recipientAddress);
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * 1_000_000));

      // Get or create associated token account
      const ata = getAssociatedTokenAddressSync(USDC_MINT, recipient);

      const tx = new Transaction();

      // Check if ATA exists, create if not
      try {
        await getAccount(connection, ata);
      } catch {
        addLine("creating token account for recipient...", "text-muted");
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey,
            ata,
            recipient,
            USDC_MINT,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }

      // Add mint instruction (connected wallet must be mint authority)
      tx.add(
        createMintToInstruction(USDC_MINT, ata, publicKey, amountRaw),
      );

      addLine("waiting for wallet signature...", "text-yellow-500");
      addLine("your wallet must be the mint authority", "text-muted");

      const sig = await sendTransaction(tx, connection);

      addLine(
        `[OK] tx submitted: ${sig.slice(0, 10)}...${sig.slice(-8)}`,
        "text-green-500",
      );
      addLine("confirming on solana...", "text-muted");

      await connection.confirmTransaction(sig, "confirmed");

      setTxSignature(sig);
      addLine("[OK] confirmed", "text-green-500");
      addLine("", "");
      addLine(
        `${parseFloat(amount).toLocaleString()} USDC minted to ${recipientAddress.slice(0, 4)}...${recipientAddress.slice(-4)}`,
        "text-accent font-bold",
      );
      addLine("", "");
      setStep("done");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const clean = msg.slice(0, 150);
      addLine(`[ERR] ${clean}`, "text-red-500");
      addLine("", "");
      addLine("type 'y' to retry or 'n' to abort", "text-muted");
      setInputValue("y");
      setStep("confirm");
    }
  }, [
    publicKey,
    connected,
    amount,
    recipientAddress,
    connection,
    sendTransaction,
    addLine,
  ]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const val = inputValue.trim();

      if (step === "address") {
        if (!isValidSolanaAddress(val)) {
          addLine(`> ${val}`, "text-white");
          addLine(
            "[ERR] invalid address — must be a valid solana address",
            "text-red-500",
          );
          setInputValue("");
          return;
        }
        addLine(`> ${val}`, "text-white");
        setRecipientAddress(val);
        addLine(
          `[OK] recipient: ${val.slice(0, 4)}...${val.slice(-4)}`,
          "text-green-500",
        );
        addLine("", "");
        setInputValue("1000");
        setStep("amount");
        return;
      }

      if (step === "amount") {
        const num = parseFloat(val);
        if (isNaN(num) || num <= 0 || num > 100000) {
          addLine(`> ${val}`, "text-white");
          addLine(
            "[ERR] amount must be between 0 and 100,000 USDC",
            "text-red-500",
          );
          setInputValue("");
          return;
        }
        addLine(`> ${val} USDC`, "text-white");
        setAmount(val);
        addLine(
          `[OK] amount: ${num.toLocaleString()} USDC`,
          "text-green-500",
        );
        addLine("", "");
        addLine(
          `mint ${num.toLocaleString()} USDC to ${recipientAddress.slice(0, 4)}...${recipientAddress.slice(-4)}?`,
          "text-muted",
        );
        setInputValue("y");
        setStep("confirm");
        return;
      }

      if (step === "confirm") {
        addLine(`> ${val}`, "text-white");
        if (val.toLowerCase() !== "y" && val.toLowerCase() !== "yes") {
          addLine("aborted.", "text-muted");
          addLine("", "");
          setInputValue("");
          setRecipientAddress("");
          setAmount("");
          setStep("address");
          return;
        }

        if (!connected || !publicKey) {
          addLine(
            "[ERR] wallet not connected — connect wallet and try again",
            "text-red-500",
          );
          addLine("", "");
          addLine("type 'y' to retry or 'n' to abort", "text-muted");
          setInputValue("y");
          return;
        }

        await executeMint();
        return;
      }

      if (step === "done") {
        addLine(`> ${val}`, "text-white");
        addLine("", "");
        setInputValue("");
        setRecipientAddress("");
        setAmount("");
        setTxSignature("");
        setHistory([
          { text: "PLASMA testnet USDC faucet", style: "text-accent" },
          {
            text: "mint test tokens for the privacy pool",
            style: "text-muted",
          },
          { text: "", style: "" },
        ]);
        setStep("address");
      }
    },
    [step, inputValue, recipientAddress, connected, publicKey, executeMint, addLine],
  );

  const getPrompt = () => {
    switch (step) {
      case "address":
        return "enter recipient address:";
      case "amount":
        return "enter amount (USDC):";
      case "confirm":
        return "[y/n]:";
      case "done":
        return "press [ENTER] to mint again";
      default:
        return "";
    }
  };

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
                plasma@solana-devnet ~ /faucet
              </span>
              <div className="ml-auto">
                <WalletButton />
              </div>
            </div>

            {/* Terminal body */}
            <div className="bg-[#080808] p-4 sm:p-6 min-h-[520px] max-h-[80vh] overflow-y-auto overflow-x-hidden font-mono">
              {/* ASCII art */}
              <pre
                className="font-['Courier_New',_Courier,_monospace] font-bold leading-[1em] tracking-normal whitespace-pre overflow-x-auto select-none text-accent/70 mb-4 text-[9px] sm:text-[11px] [font-smooth:never] [-webkit-font-smoothing:none]"
                style={{
                  fontVariantLigatures: "none",
                  textRendering: "optimizeSpeed",
                  WebkitTextStroke: "0.3px currentColor",
                }}
              >
                {ASCII_FAUCET.join("\n")}
              </pre>

              <div className="text-border text-xs mb-4 select-none overflow-hidden">
                {"─".repeat(60)}
              </div>

              {/* History */}
              <div className="space-y-1 mb-2">
                {history.map((line, i) => {
                  if (line.text === "") return <div key={i} className="h-3" />;
                  return (
                    <div key={i} className={`text-xs ${line.style}`}>
                      {line.text}
                    </div>
                  );
                })}
              </div>

              {/* Active input */}
              {step !== "minting" && (
                <form
                  onSubmit={handleSubmit}
                  className="flex items-center gap-2"
                >
                  <span className="text-xs text-muted shrink-0">
                    {getPrompt()}
                  </span>
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    className="flex-1 bg-transparent border-none outline-none text-xs text-white caret-accent"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </form>
              )}

              {step === "minting" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted animate-pulse">
                    processing...
                  </span>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-3 text-[10px] text-muted/40 px-1">
            <Link
              href="/pool"
              className="hover:text-accent transition-colors"
            >
              {"<-"} back to vault
            </Link>
            {txSignature && (
              <a
                href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent transition-colors"
              >
                view tx
              </a>
            )}
            {!txSignature && <span>devnet only</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
