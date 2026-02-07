"use client";

type Step = "idle" | "preparing" | "proving" | "signing" | "confirming" | "done" | "error";

const stepLabels: Record<Step, string> = {
  idle: "",
  preparing: "Preparing transaction...",
  proving: "Generating ZK proof...",
  signing: "Waiting for wallet signature...",
  confirming: "Confirming on Solana...",
  done: "Transaction confirmed",
  error: "Transaction failed",
};

const stepDescriptions: Record<Step, string> = {
  idle: "",
  preparing: "Building UTXOs and circuit inputs",
  proving: "This may take 5-15 seconds",
  signing: "Please approve in your wallet",
  confirming: "Waiting for block confirmation",
  done: "",
  error: "",
};

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-1 border border-border p-8 w-full max-w-md">
        <div className="flex flex-col items-center text-center">
          {isActive && (
            <div className="mb-6">
              <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {step === "done" && (
            <div className="mb-6 w-10 h-10 flex items-center justify-center border-2 border-accent rounded-full">
              <svg
                className="w-5 h-5 text-accent"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
          )}

          {step === "error" && (
            <div className="mb-6 w-10 h-10 flex items-center justify-center border-2 border-red-500 rounded-full">
              <svg
                className="w-5 h-5 text-red-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
          )}

          <h3 className="text-lg font-medium mb-1">
            {stepLabels[step]}
          </h3>

          {stepDescriptions[step] && (
            <p className="text-sm text-muted mb-4">
              {stepDescriptions[step]}
            </p>
          )}

          {error && (
            <p className="text-sm text-red-400 mb-4 break-all">
              {error}
            </p>
          )}

          {txSignature && (
            <a
              href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent hover:underline mb-4 font-mono"
            >
              View on Explorer
            </a>
          )}

          {(step === "done" || step === "error") && (
            <button
              onClick={onClose}
              className="mt-2 px-6 py-2 text-sm bg-surface-2 border border-border hover:border-border-hover transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
