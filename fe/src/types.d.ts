declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: any,
      wasmFileOrBuffer: string | ArrayBuffer | Uint8Array,
      zkeyFileOrBuffer: string | ArrayBuffer | Uint8Array
    ): Promise<{ proof: any; publicSignals: string[] }>;
    verify(
      vkeyData: any,
      publicSignals: any,
      proof: any
    ): Promise<boolean>;
  };
}

declare module "ffjavascript" {
  export const utils: {
    stringifyBigInts(obj: any): any;
    unstringifyBigInts(obj: any): any;
    leInt2Buff(n: any, len: number): Uint8Array;
    leBuff2int(buf: Uint8Array): bigint;
  };
}
