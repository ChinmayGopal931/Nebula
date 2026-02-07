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

export function parseProofToBytesArray(proof: Proof): {
  proofA: number[];
  proofB: number[];
  proofC: number[];
} {
  const data = JSON.parse(JSON.stringify(proof));

  for (const key in data) {
    if (key === "pi_a" || key === "pi_c") {
      for (const j in data[key]) {
        data[key][j] = Array.from(
          (utils as any).leInt2Buff(
            (utils as any).unstringifyBigInts(data[key][j]),
            32
          )
        ).reverse();
      }
    } else if (key === "pi_b") {
      for (const j in data[key]) {
        for (const z in data[key][j]) {
          data[key][j][z] = Array.from(
            (utils as any).leInt2Buff(
              (utils as any).unstringifyBigInts(data[key][j][z]),
              32
            )
          );
        }
      }
    }
  }

  return {
    proofA: [data.pi_a[0], data.pi_a[1]].flat(),
    proofB: [
      data.pi_b[0].flat().reverse(),
      data.pi_b[1].flat().reverse(),
    ].flat(),
    proofC: [data.pi_c[0], data.pi_c[1]].flat(),
  };
}

export function parseToBytesArray(publicSignals: string[]): number[][] {
  return publicSignals.map((signal) => {
    return Array.from(
      (utils as any).leInt2Buff(
        (utils as any).unstringifyBigInts(signal),
        32
      )
    ).reverse() as number[];
  });
}

export type { Proof };
