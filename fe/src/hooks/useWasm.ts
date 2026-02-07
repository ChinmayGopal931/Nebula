"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";
import React from "react";

const WasmContext = createContext<LightWasm | null>(null);

export function WasmProvider({ children }: { children: ReactNode }) {
  const [wasm, setWasm] = useState<LightWasm | null>(null);

  useEffect(() => {
    WasmFactory.getInstance().then(setWasm);
  }, []);

  return React.createElement(
    WasmContext.Provider,
    { value: wasm },
    children
  );
}

export function useWasm(): LightWasm | null {
  return useContext(WasmContext);
}
