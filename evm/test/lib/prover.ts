/// <reference types="node" />

import { groth16 } from "snarkjs";
import { utils } from "ffjavascript";

type Groth16Module = {
  fullProve: (
    input: any,
    wasmFile: string,
    zkeyFile: string
  ) => Promise<{ proof: Proof; publicSignals: string[] }>;
  verify: (
    vkeyData: any,
    publicSignals: any,
    proof: Proof
  ) => Promise<boolean>;
};

type UtilsModule = {
  stringifyBigInts: (obj: any) => any;
  unstringifyBigInts: (obj: any) => any;
};

const groth16Typed = groth16 as unknown as Groth16Module;
const utilsTyped = utils as unknown as UtilsModule;

interface Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

async function prove(
  input: any,
  keyBasePath: string
): Promise<{
  proof: Proof;
  publicSignals: string[];
}> {
  return await groth16Typed.fullProve(
    utilsTyped.stringifyBigInts(input),
    `${keyBasePath}.wasm`,
    `${keyBasePath}.zkey`
  );
}

/**
 * Parse snarkjs proof into Solidity-compatible format.
 * IMPORTANT: snarkjs Solidity verifier expects G2 point (B) coordinates
 * in REVERSED order compared to the JSON output.
 */
function parseProofForSolidity(proof: Proof): {
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

export { prove, parseProofForSolidity, Proof };
