import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Alliance No.2", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        surface: {
          0: "#0a0a0a",
          1: "#141414",
          2: "#1a1a1a",
          3: "#222222",
        },
        border: {
          DEFAULT: "#262626",
          hover: "#333333",
        },
        muted: "#71717a",
        accent: "#10b981",
        "accent-hover": "#059669",
      },
    },
  },
  plugins: [],
};

export default config;
