"use client";

import { useEffect, useState } from "react";

type Step = "idle" | "preparing" | "proving" | "signing" | "relaying" | "confirming" | "done" | "error";

interface LogLine {
  text: string;
  style: string;
}

const STEP_ORDER: Step[] = ["preparing", "proving", "signing", "relaying", "confirming", "done"];

function getStepLines(step: Step): LogLine[] {
  switch (step) {
    case "preparing":
      return [{ text: "building UTXOs and circuit inputs...", style: "text-muted" }];
    case "proving":
      return [
        { text: "[OK] inputs prepared", style: "text-green-500" },
        { text: "", style: "" },
        { text: "generating groth16 proof (this may take 5-15s)...", style: "text-muted" },
      ];
    case "signing":
      return [
        { text: "[OK] proof generated", style: "text-green-500" },
        { text: "", style: "" },
        { text: "waiting for wallet signature...", style: "text-yellow-500" },
        { text: "please approve the transaction in your wallet", style: "text-muted" },
      ];
    case "relaying":
      return [
        { text: "[OK] transaction signed", style: "text-green-500" },
        { text: "", style: "" },
        { text: "queued for batch submission...", style: "text-muted" },
      ];
    case "confirming":
      return [
        { text: "[OK] transaction signed", style: "text-green-500" },
        { text: "", style: "" },
        { text: "confirming on solana...", style: "text-muted" },
      ];
    case "done":
      return [
        { text: "[OK] transaction confirmed", style: "text-green-500" },
        { text: "", style: "" },
      ];
    default:
      return [];
  }
}

export function ProofStatus({
  step,
  error,
  txSignature,
  onClose,
}: {
  step: Step;
  error: string | null;
  txSignature: string | null;
  onClose: () => void;
}) {
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [lastStep, setLastStep] = useState<Step>("idle");

  // Accumulate log lines as steps progress
  useEffect(() => {
    if (step === "idle") {
      setLogLines([]);
      setLastStep("idle");
      return;
    }

    if (step === lastStep) return;

    // Find all steps between lastStep and current step
    const lastIdx = STEP_ORDER.indexOf(lastStep);
    const currIdx = STEP_ORDER.indexOf(step);

    if (currIdx > lastIdx) {
      const newLines: LogLine[] = [];
      for (let i = Math.max(0, lastIdx + 1); i <= currIdx; i++) {
        newLines.push(...getStepLines(STEP_ORDER[i]));
      }
      setLogLines((prev) => [...prev, ...newLines]);
    }

    // Handle error step
    if (step === "error") {
      setLogLines((prev) => [
        ...prev,
        { text: "", style: "" },
        { text: "[ERR] transaction failed", style: "text-red-500" },
      ]);
    }

    setLastStep(step);
  }, [step, lastStep]);

  if (step === "idle") return null;

  const isActive = !["idle", "done", "error"].includes(step);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="w-full max-w-lg mx-4">
        {/* Terminal window */}
        <div className="border border-border">
          {/* Title bar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface-1">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            <span className="ml-3 text-[10px] text-muted tracking-wider">
              plasma — transaction
            </span>
          </div>

          {/* Terminal body */}
          <div className="bg-[#080808] p-5 min-h-[200px] max-h-[400px] overflow-y-auto font-mono">
            {/* Header */}
            <div className="text-xs text-accent mb-3">initiating private transaction</div>
            <div className="text-border text-xs mb-3 select-none overflow-hidden">
              {"─".repeat(50)}
            </div>

            {/* Log lines */}
            <div className="space-y-0.5">
              {logLines.map((line, i) => {
                if (line.text === "") return <div key={i} className="h-2.5" />;
                return (
                  <div key={i} className={`text-xs ${line.style}`}>
                    {line.text}
                  </div>
                );
              })}
            </div>

            {/* Blinking cursor for active state */}
            {isActive && (
              <span className="inline-block text-xs text-accent animate-pulse mt-1">
                _
              </span>
            )}

            {/* Error detail */}
            {error && (
              <div className="text-xs text-red-400 mt-1 break-all">
                {error.length > 200 ? error.slice(0, 200) + "..." : error}
              </div>
            )}

            {/* Tx link */}
            {txSignature && (
              <div className="mt-1">
                <a
                  href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  {">"} view on explorer: {txSignature.slice(0, 10)}...{txSignature.slice(-6)}
                </a>
              </div>
            )}

            {/* Close prompt */}
            {(step === "done" || step === "error") && (
              <div className="mt-3">
                <button
                  onClick={onClose}
                  className="text-xs text-muted hover:text-accent transition-colors cursor-pointer"
                >
                  {">"} press to close_
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
