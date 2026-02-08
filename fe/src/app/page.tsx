"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { WalletButton } from "@/components/WalletButton";
import { DecipherText } from "@/components/DecipherText";

const ASCII_ART = `
        ▄▄██████████▄▄
      ▄██▀▀        ▀▀██▄
     ██    ╔══════╗    ██
     ██    ║ ┌──┐ ║    ██
     ██    ║ │▓▓│ ║    ██
     ██    ║ └─┬┘ ║    ██
     ██    ╠═══╧══╣    ██
     ██    ║ ░░░░ ║    ██
     ██    ║ ░░░░ ║    ██
     ██    ╚══════╝    ██
      ▀██▄          ▄██▀
        ▀▀██████████▀▀`;

export default function Home() {
  const { connected } = useWallet();
  const router = useRouter();

  useEffect(() => {
    if (connected) {
      router.push("/pool");
    }
  }, [connected, router]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-4 border-b border-border">
        <span className="text-sm text-accent tracking-wider">
          NEBULA
        </span>
        <div className="flex items-center gap-6">
          <span className="text-xs text-muted hidden sm:inline">
            [devnet]
          </span>
          <WalletButton />
        </div>
      </nav>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="max-w-3xl w-full flex flex-col md:flex-row items-center gap-10 md:gap-16">
          {/* ASCII Art */}
          <div className="hidden md:block shrink-0">
            <pre className="text-[11px] leading-[1.3] text-muted select-none">
              {ASCII_ART}
            </pre>
          </div>

          {/* Text */}
          <div className="text-center md:text-left">
            <h1 className="text-2xl md:text-3xl text-white mb-4 leading-tight">
              <DecipherText text="Private yield on Solana." delay={300} speed={25} />
            </h1>
            <p className="text-sm text-muted mb-8 leading-relaxed max-w-md">
              <DecipherText
                text="Deposit USDC privately. Earn yield via Kamino. Withdraw to any address. All proofs generated in your browser."
                delay={1200}
                speed={12}
              />
            </p>

            {!connected && (
              <div className="inline-block">
                <WalletButton />
              </div>
            )}
          </div>
        </div>

        {/* How it works */}
        <div className="mt-20 max-w-3xl w-full">
          <div className="text-xs text-muted mb-4 uppercase tracking-widest">
            {"// how it works"}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border">
            {[
              {
                num: "01",
                title: "DEPOSIT",
                desc: "Generate a ZK proof in your browser. Your deposit is shielded from observers.",
              },
              {
                num: "02",
                title: "EARN",
                desc: "Pool funds deploy to Kamino lending. Your share earns yield while private.",
              },
              {
                num: "03",
                title: "WITHDRAW",
                desc: "Withdraw to any Solana address. No link between deposit and withdrawal.",
              },
            ].map((item) => (
              <div
                key={item.num}
                className="bg-surface-0 p-6"
              >
                <div className="text-accent text-xs mb-3">
                  [{item.num}]
                </div>
                <div className="text-white text-sm mb-2">
                  {item.title}
                </div>
                <p className="text-xs text-muted leading-relaxed">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-8 py-4 border-t border-border text-xs text-muted">
        <span>{process.env.NEXT_PUBLIC_COMMIT_HASH || "dev"}</span>
      </footer>
    </div>
  );
}
