import { groth16 } from "snarkjs";
import { utils } from "ffjavascript";

interface Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

// Cache fetched artifacts in memory
let cachedWasm: ArrayBuffer | null = null;
let cachedZkey: ArrayBuffer | null = null;
let loadingPromise: Promise<void> | null = null;

export async function preloadArtifacts(): Promise<void> {
  if (cachedWasm && cachedZkey) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const [wasmResp, zkeyResp] = await Promise.all([
      fetch("/artifacts/transaction2.wasm"),
      fetch("/artifacts/transaction2.zkey"),
    ]);
    cachedWasm = await wasmResp.arrayBuffer();
    cachedZkey = await zkeyResp.arrayBuffer();
  })();

  return loadingPromise;
}

export function getArtifactLoadStatus(): {
  loaded: boolean;
  wasmSize: number;
  zkeySize: number;
} {
  return {
    loaded: !!cachedWasm && !!cachedZkey,
    wasmSize: cachedWasm?.byteLength ?? 0,
    zkeySize: cachedZkey?.byteLength ?? 0,
  };
}

export async function prove(input: any): Promise<{
  proof: Proof;
  publicSignals: string[];
}> {
  await preloadArtifacts();
  if (!cachedWasm || !cachedZkey)
    throw new Error("Artifacts not loaded");

  const stringified = (utils as any).stringifyBigInts(input);
  const { proof, publicSignals } = await (groth16 as any).fullProve(
    stringified,
    new Uint8Array(cachedWasm),
    new Uint8Array(cachedZkey)
  );
  return { proof, publicSignals };
}

/**
 * Parse snarkjs proof into Solidity-compatible format.
 * IMPORTANT: snarkjs Solidity verifier expects G2 point (B) coordinates
 * in REVERSED order compared to the JSON output.
 */
export function parseProofForSolidity(proof: Proof): {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
} {
  return {
    a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    // B point: coordinates are REVERSED for Solidity verifier
    b: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  };
}

export type { Proof };
