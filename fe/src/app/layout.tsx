import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/Providers";
import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const siteUrl = "https://plasmapay.app";
const siteName = "Plasma";
const siteDescription = "Encrypted Yield on MegaETH. Private USDC pool powered by zero-knowledge proofs.";

export const metadata: Metadata = {
  title: {
    default: "Plasma — Encrypted Yield on MegaETH",
    template: "%s | Plasma",
  },
  description: siteDescription,
  metadataBase: new URL(siteUrl),
  openGraph: {
    title: "Plasma — Encrypted Yield on MegaETH",
    description: siteDescription,
    url: siteUrl,
    siteName,
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Plasma — Encrypted Yield Protocol",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Plasma — Encrypted Yield on MegaETH",
    description: siteDescription,
    site: "@plasmapayapp",
    creator: "@plasmapayapp",
    images: ["/og-image.png"],
  },
  keywords: ["privacy", "USDC", "yield", "MegaETH", "ZK", "zero-knowledge", "shielded", "encrypted", "DeFi", "pool"],
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
