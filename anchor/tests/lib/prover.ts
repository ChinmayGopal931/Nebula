/// <reference types="node" />

import * as anchor from "@coral-xyz/anchor";
import { groth16 } from 'snarkjs'
import { utils } from 'ffjavascript'
import { FIELD_SIZE } from './constants'

type Groth16Module = {
  fullProve: (input: any, wasmFile: string, zkeyFile: string) => Promise<{ proof: Proof; publicSignals: string[] }>
  verify: (vkeyData: any, publicSignals: any, proof: Proof) => Promise<boolean>
}

type UtilsModule = {
  stringifyBigInts: (obj: any) => any
  unstringifyBigInts: (obj: any) => any
}

const groth16Typed = groth16 as unknown as Groth16Module
const utilsTyped = utils as unknown as UtilsModule

interface Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

async function prove(input: any, keyBasePath: string): Promise<{
  proof: Proof
  publicSignals: string[];
}> {
  return await groth16Typed.fullProve(
    utilsTyped.stringifyBigInts(input),
    `${keyBasePath}.wasm`,
    `${keyBasePath}.zkey`,
  )
}

export function parseProofToBytesArray(
  proof: Proof,
): {
  proofA: number[];
  proofB: number[][];
  proofC: number[];
} {
  const proofJson = JSON.stringify(proof, null, 1);
  const mydata = JSON.parse(proofJson.toString());
  try {
    for (const i in mydata) {
      if (i == "pi_a" || i == "pi_c") {
        for (const j in mydata[i]) {
          mydata[i][j] = Array.from(
            utils.leInt2Buff(utils.unstringifyBigInts(mydata[i][j]), 32),
          ).reverse();
        }
      } else if (i == "pi_b") {
        for (const j in mydata[i]) {
          for (const z in mydata[i][j]) {
            mydata[i][j][z] = Array.from(
              utils.leInt2Buff(utils.unstringifyBigInts(mydata[i][j][z]), 32),
            );
          }
        }
      }
    }

    return {
      proofA: [mydata.pi_a[0], mydata.pi_a[1]].flat(),
      proofB: [
        mydata.pi_b[0].flat().reverse(),
        mydata.pi_b[1].flat().reverse(),
      ].flat(),
      proofC: [mydata.pi_c[0], mydata.pi_c[1]].flat(),
    };
  } catch (error: any) {
    console.error("Error while parsing the proof.", error.message);
    throw error;
  }
}

export function parseToBytesArray(publicSignals: string[]): number[][] {
  const publicInputsJson = JSON.stringify(publicSignals, null, 1);
  const publicInputsBytesJson = JSON.parse(publicInputsJson.toString());
  try {
    const publicInputsBytes = new Array<Array<number>>();
    for (const i in publicInputsBytesJson) {
      const ref: Array<number> = Array.from([
        ...utils.leInt2Buff(utils.unstringifyBigInts(publicInputsBytesJson[i]), 32),
      ]).reverse();
      publicInputsBytes.push(ref);
    }

    return publicInputsBytes;
  } catch (error: any) {
    console.error("Error while parsing public inputs.", error.message);
    throw error;
  }
}

export { prove, Proof }
