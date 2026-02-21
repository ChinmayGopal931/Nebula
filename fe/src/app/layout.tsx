import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/Providers";
import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const siteName = "Plasma";
const siteDescription = "Private yield on Solana. Shielded USDC pool powered by zero-knowledge proofs and Kamino lending.";

export const metadata: Metadata = {
  title: {
    default: "Plasma — Private Yield on Solana",
    template: "%s | Plasma",
  },
  description: siteDescription,
  keywords: ["privacy", "USDC", "yield", "Solana", "ZK", "zero-knowledge", "shielded", "Kamino", "DeFi", "pool"],
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={mono.variable}>
      <body className="font-mono antialiased min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
