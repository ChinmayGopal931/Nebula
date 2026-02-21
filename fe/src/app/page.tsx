"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback, useRef } from "react";

const CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*!<>{}[]";

const ASCII_LOGO_DESKTOP = [
  "██████╗  ██╗       █████╗  ███████╗ ███╗   ███╗  █████╗",
  "██╔══██╗ ██║      ██╔══██╗ ██╔════╝ ████╗ ████║ ██╔══██╗",
  "██████╔╝ ██║      ███████║ ███████╗ ██╔████╔██║ ███████║",
  "██╔═══╝  ██║      ██╔══██║ ╚════██║ ██║╚██╔╝██║ ██╔══██║",
  "██║      ███████╗ ██║  ██║ ███████║ ██║ ╚═╝ ██║ ██║  ██║",
  "╚═╝      ╚══════╝ ╚═╝  ╚═╝ ╚══════╝ ╚═╝     ╚═╝ ╚═╝  ╚═╝",
];

const ASCII_LOGO_MOBILE = [
  "██████╗ ██╗      ██████╗ ██████╗███╗   ███╗ █████╗ ",
  "██╔══██╗██║     ██╔══██╗██╔════╝████╗ ████║██╔══██╗",
  "██████╔╝██║     ███████║███████╗██╔████╔██║███████║",
  "██╔═══╝ ██║     ██╔══██║╚════██║██║╚██╔╝██║██╔══██║",
  "██║     ███████╗██║  ██║███████║██║ ╚═╝ ██║██║  ██║",
  "╚═╝     ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝",
];

const BOOT_LINES: { text: string; style: string; delay: number }[] = [
  {
    text: "PLASMA v0.1.0 — private yield protocol",
    style: "text-accent",
    delay: 0,
  },
  {
    text: "powered by zero-knowledge proofs on Solana",
    style: "text-muted",
    delay: 400,
  },
  { text: "", style: "", delay: 700 },
  {
    text: "initializing cryptographic subsystem...",
    style: "text-muted",
    delay: 900,
  },
  {
    text: "[OK] poseidon hash module loaded",
    style: "text-green-500",
    delay: 1400,
  },
  {
    text: "[OK] groth16 prover ready (browser wasm)",
    style: "text-green-500",
    delay: 1800,
  },
  {
    text: "[OK] merkle tree engine online (depth=26)",
    style: "text-green-500",
    delay: 2200,
  },
  { text: "", style: "", delay: 2500 },
];

const DECIPHER_LINES: { text: string; style: string; delay: number }[] = [
  {
    text: "> encrypt your money.",
    style: "text-accent text-lg font-bold",
    delay: 2800,
  },
  { text: "", style: "", delay: 3500 },
  {
    text: "deposit USDC. earn yield. withdraw anywhere.",
    style: "text-muted",
    delay: 3700,
  },
];

const ENTER_LINES: { text: string; style: string; delay: number }[] = [
  { text: "", style: "", delay: 0 },
  { text: "loading vault interface...", style: "text-muted", delay: 200 },
  { text: "[OK] pool contract linked", style: "text-green-500", delay: 700 },
  { text: "[OK] merkle state synced", style: "text-green-500", delay: 1100 },
  { text: "", style: "", delay: 1400 },
  { text: "ready.", style: "text-accent", delay: 1600 },
];

function useDecipherText(text: string, startDelay: number, speed = 30) {
  const [display, setDisplay] = useState("");
  const started = useRef(false);

  useEffect(() => {
    const timeout = setTimeout(() => {
      started.current = true;
      let iter = 0;
      const interval = setInterval(() => {
        setDisplay(
          text
            .split("")
            .map((char, i) => {
              if (char === " ") return " ";
              if (i < iter) return text[i];
              return CHARS[Math.floor(Math.random() * CHARS.length)];
            })
            .join(""),
        );
        iter += 1 / 3;
        if (iter >= text.length + 1) {
          clearInterval(interval);
        }
      }, speed);
      return () => clearInterval(interval);
    }, startDelay);
    return () => clearTimeout(timeout);
  }, [text, startDelay, speed]);

  return display;
}

function BootLine({
  text,
  style,
  delay,
}: {
  text: string;
  style: string;
  delay: number;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  if (!visible) return null;
  if (text === "") return <div className="h-3" />;
  return <div className={`text-xs ${style}`}>{text}</div>;
}

function DecipherLine({
  text,
  style,
  delay,
}: {
  text: string;
  style: string;
  delay: number;
}) {
  const display = useDecipherText(text, delay, 20);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  if (!visible) return null;
  if (text === "") return <div className="h-3" />;
  return <div className={`${style}`}>{display || text}</div>;
}

function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    setIsTouch(window.matchMedia("(pointer: coarse)").matches);
  }, []);
  return isTouch;
}

function BlinkingCursor({
  delay,
  isTouch,
}: {
  delay: number;
  isTouch: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [blink, setBlink] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => setBlink((b) => !b), 530);
    return () => clearInterval(interval);
  }, [visible]);

  if (!visible) return null;

  return (
    <span className="text-accent">
      {">"} {isTouch ? "tap to enter" : "press [ENTER]"}
      <span className={blink ? "opacity-100" : "opacity-0"}>_</span>
    </span>
  );
}

function EnterSequence({ onComplete }: { onComplete: () => void }) {
  const [lines, setLines] = useState<number>(0);

  useEffect(() => {
    const timers = ENTER_LINES.map((line, i) =>
      setTimeout(() => setLines(i + 1), line.delay),
    );
    const nav = setTimeout(onComplete, 2200);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(nav);
    };
  }, [onComplete]);

  return (
    <div className="space-y-1 mt-2">
      {ENTER_LINES.slice(0, lines).map((line, i) => {
        if (line.text === "") return <div key={i} className="h-3" />;
        return (
          <div key={i} className={`text-xs ${line.style}`}>
            {line.text}
          </div>
        );
      })}
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const isTouch = useIsTouchDevice();
  const [showAscii, setShowAscii] = useState(false);
  const [promptReady, setPromptReady] = useState(false);
  const [entered, setEntered] = useState(false);

  // Show ASCII logo after boot lines start
  useEffect(() => {
    const t = setTimeout(() => setShowAscii(true), 200);
    return () => clearTimeout(t);
  }, []);

  // Enable prompt after animations
  useEffect(() => {
    const t = setTimeout(() => setPromptReady(true), 4800);
    return () => clearTimeout(t);
  }, []);

  const triggerEnter = useCallback(() => {
    if (!promptReady || entered) return;
    setEntered(true);
  }, [promptReady, entered]);

  const handleComplete = useCallback(() => {
    router.push("/pool");
  }, [router]);

  // Listen for Enter key (desktop only)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        triggerEnter();
      }
    },
    [triggerEnter],
  );

  useEffect(() => {
    if (isTouch) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown, isTouch]);

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
                plasma@solana-devnet ~ /vault
              </span>
            </div>

            {/* Terminal body */}
            <div className="bg-[#080808] p-4 sm:p-6 min-h-[520px] font-mono overflow-hidden">
              {showAscii && (
                <>
                  <pre
                    className="sm:hidden font-['Courier_New',_Courier,_monospace] font-bold leading-[1em] tracking-normal whitespace-pre overflow-x-auto select-none text-accent/70 mb-4 text-[9px] [font-smooth:never] [-webkit-font-smoothing:none]"
                    style={{
                      fontVariantLigatures: "none",
                      textRendering: "optimizeSpeed",
                      WebkitTextStroke: "0.3px currentColor",
                    }}
                  >
                    {ASCII_LOGO_MOBILE.join("\n")}
                  </pre>
                  <pre
                    className="hidden sm:block font-['Courier_New',_Courier,_monospace] font-bold leading-[1em] tracking-normal whitespace-pre overflow-x-auto select-none text-accent/70 mb-4 text-[11px] [font-smooth:never] [-webkit-font-smoothing:none]"
                    style={{
                      fontVariantLigatures: "none",
                      textRendering: "optimizeSpeed",
                      WebkitTextStroke: "0.3px currentColor",
                    }}
                  >
                    {ASCII_LOGO_DESKTOP.join("\n")}
                  </pre>
                </>
              )}

              {showAscii && (
                <div className="text-border text-xs mb-4 select-none overflow-hidden">
                  {"─".repeat(60)}
                </div>
              )}

              <div className="space-y-1 mb-4">
                {BOOT_LINES.map((line, i) => (
                  <BootLine key={i} {...line} />
                ))}
              </div>

              <div className="space-y-1 mb-6">
                {DECIPHER_LINES.map((line, i) => (
                  <DecipherLine key={i} {...line} />
                ))}
              </div>

              {!entered && (
                <div className="text-sm mt-4">
                  <div
                    onClick={triggerEnter}
                    className={`cursor-pointer ${promptReady ? "" : "pointer-events-none"}`}
                  >
                    <BlinkingCursor delay={4600} isTouch={isTouch} />
                  </div>
                </div>
              )}

              {entered && <EnterSequence onComplete={handleComplete} />}
            </div>
          </div>

          <div className="flex items-center justify-between mt-3 text-[10px] text-muted/40 px-1">
            <span>{process.env.NEXT_PUBLIC_COMMIT_HASH || "dev"}</span>
            <div className="flex items-center gap-3">
              <Link
                href="/docs"
                className="hover:text-accent transition-colors"
              >
                how does this work?
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
