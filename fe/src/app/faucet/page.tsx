"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { USDC_ADDRESS, ERC20_ABI } from "@/lib/config";
import Link from "next/link";

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

export default function FaucetPage() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [step, setStep] = useState<Step>("address");
  const [inputValue, setInputValue] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState("");
  const [history, setHistory] = useState<HistoryLine[]>([
    { text: "PLASMA testnet USDC faucet", style: "text-accent" },
    { text: "mint test tokens for the privacy pool", style: "text-muted" },
    { text: "", style: "" },
  ]);

  // Track if we're waiting for wallet to connect before minting
  const pendingMint = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, step]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  // Pre-fill address if wallet connected
  useEffect(() => {
    if (isConnected && address && step === "address" && !recipientAddress) {
      setInputValue(address);
    }
  }, [isConnected, address, step, recipientAddress]);

  const addLine = useCallback((text: string, style: string) => {
    setHistory((h) => [...h, { text, style }]);
  }, []);

  // Execute the mint transaction
  const executeMint = useCallback(
    async (client: NonNullable<typeof walletClient>) => {
      setStep("minting");
      addLine("", "");
      addLine("submitting transaction...", "text-muted");

      try {
        const amountRaw = BigInt(Math.floor(parseFloat(amount) * 1_000_000));

        const hash = await client.writeContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "mint",
          args: [recipientAddress as `0x${string}`, amountRaw],
        });

        addLine(
          `[OK] tx submitted: ${hash.slice(0, 10)}...${hash.slice(-8)}`,
          "text-green-500",
        );
        addLine("waiting for confirmation...", "text-muted");

        await publicClient!.waitForTransactionReceipt({ hash });

        setTxHash(hash);
        addLine("[OK] confirmed", "text-green-500");
        addLine("", "");
        addLine(
          `${parseFloat(amount).toLocaleString()} USDC minted to ${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}`,
          "text-accent font-bold",
        );
        addLine("", "");
        setStep("done");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Clean up common viem error prefixes
        const clean = msg.replace(/^.*Details:\s*/, "").slice(0, 120);
        addLine(`[ERR] ${clean}`, "text-red-500");
        addLine("", "");
        addLine("type 'y' to retry or 'n' to abort", "text-muted");
        setInputValue("y");
        setStep("confirm");
      }
    },
    [amount, recipientAddress, publicClient, addLine],
  );

  // Auto-execute mint when wallet connects after pending
  useEffect(() => {
    if (pendingMint.current && walletClient && isConnected) {
      pendingMint.current = false;
      addLine("[OK] wallet connected", "text-green-500");
      executeMint(walletClient);
    }
  }, [walletClient, isConnected, executeMint, addLine]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const val = inputValue.trim();

      if (step === "address") {
        if (!val.match(/^0x[a-fA-F0-9]{40}$/)) {
          addLine(`> ${val}`, "text-white");
          addLine(
            "[ERR] invalid address — must be 0x... (40 hex chars)",
            "text-red-500",
          );
          setInputValue("");
          return;
        }
        addLine(`> ${val}`, "text-white");
        setRecipientAddress(val);
        addLine(
          `[OK] recipient: ${val.slice(0, 6)}...${val.slice(-4)}`,
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
        addLine(`[OK] amount: ${num.toLocaleString()} USDC`, "text-green-500");
        addLine("", "");
        addLine(
          `mint ${num.toLocaleString()} USDC to ${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}?`,
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

        // If wallet not ready, open modal and queue the mint
        if (!walletClient) {
          addLine("connecting wallet...", "text-muted");
          pendingMint.current = true;
          openConnectModal?.();
          setInputValue("");
          return;
        }

        await executeMint(walletClient);
        return;
      }

      if (step === "done") {
        addLine(`> ${val}`, "text-white");
        addLine("", "");
        setInputValue("");
        setRecipientAddress("");
        setAmount("");
        setTxHash("");
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
    [
      step,
      inputValue,
      recipientAddress,
      walletClient,
      openConnectModal,
      executeMint,
      addLine,
    ],
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
                plasma@megaeth-testnet ~ /faucet
              </span>
            </div>

            {/* Terminal body */}
            <div className="bg-[#080808] p-6 min-h-[520px] max-h-[600px] overflow-y-auto font-mono">
              {/* ASCII art */}
              <pre
                className="font-['Courier_New',_Courier,_monospace] font-bold leading-[1em] tracking-normal whitespace-pre overflow-x-auto select-none text-accent/70 mb-4 text-[9px] sm:text-[11px] [font-smooth:never] [-webkit-font-smoothing:none]"
                style={{
                  fontVariantLigatures: 'none',
                  textRendering: 'optimizeSpeed',
                  WebkitTextStroke: '0.3px currentColor',
                }}
              >
                {ASCII_FAUCET.join("\n")}
              </pre>

              <div className="text-border text-xs mb-4 select-none">
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
            <Link href="/pool" className="hover:text-accent transition-colors">
              {"<-"} back to vault
            </Link>
            {txHash && (
              <a
                href={`https://megaexplorer.xyz/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent transition-colors"
              >
                view tx
              </a>
            )}
            {!txHash && <span>testnet only</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
