"use client";

type Step = "idle" | "preparing" | "proving" | "signing" | "relaying" | "confirming" | "done" | "error";

const stepLabels: Record<Step, string> = {
  idle: "",
  preparing: "preparing transaction...",
  proving: "generating zk proof...",
  signing: "waiting for wallet signature...",
  relaying: "queued for batch submission...",
  confirming: "confirming on solana...",
  done: "transaction confirmed",
  error: "transaction failed",
};

const stepDescriptions: Record<Step, string> = {
  idle: "",
  preparing: "building UTXOs and circuit inputs",
  proving: "this may take 5-15 seconds",
  signing: "please approve in your wallet",
  relaying: "your withdrawal will be submitted with the next batch",
  confirming: "waiting for block confirmation",
  done: "",
  error: "",
};

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

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
  if (step === "idle") return null;

  const isActive = !["idle", "done", "error"].includes(step);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-surface-1 border border-border p-8 w-full max-w-md">
        <div className="flex flex-col items-center text-center">
          {isActive && (
            <div className="mb-4 text-2xl text-accent animate-spin">
              *
            </div>
          )}

          {step === "done" && (
            <div className="mb-4 text-sm text-green-500">
              [OK]
            </div>
          )}

          {step === "error" && (
            <div className="mb-4 text-sm text-red-500">
              [ERR]
            </div>
          )}

          <h3 className="text-sm text-white mb-1">
            {stepLabels[step]}
          </h3>

          {stepDescriptions[step] && (
            <p className="text-xs text-muted mb-4">
              {stepDescriptions[step]}
            </p>
          )}

          {error && (
            <p className="text-xs text-red-400 mb-4 break-all">
              {error}
            </p>
          )}

          {txSignature && (
            <a
              href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent hover:text-accent-hover mb-4 transition-colors"
            >
              {">"} view on explorer
            </a>
          )}

          {(step === "done" || step === "error") && (
            <button
              onClick={onClose}
              className="mt-2 px-4 py-2 text-xs border border-border hover:border-accent hover:text-accent transition-colors"
            >
              [ close ]
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
