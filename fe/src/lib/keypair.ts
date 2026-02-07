import BN from "bn.js";
import { LightWasm } from "@lightprotocol/hasher.rs";
import { FIELD_SIZE } from "./constants";

export class Keypair {
  public privkey: BN;
  public pubkey: BN;
  private lightWasm: LightWasm;

  constructor(privkeyHex: string, lightWasm: LightWasm) {
    const rawDecimal = BigInt(privkeyHex);
    this.privkey = new BN(
      (rawDecimal % BigInt(FIELD_SIZE.toString())).toString()
    );
    this.lightWasm = lightWasm;
    this.pubkey = new BN(
      this.lightWasm.poseidonHashString([this.privkey.toString()])
    );
  }

  sign(commitment: string, merklePath: string): string {
    return this.lightWasm.poseidonHashString([
      this.privkey.toString(),
      commitment,
      merklePath,
    ]);
  }

  static generateNew(lightWasm: LightWasm): Keypair {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const hex =
      "0x" +
      Array.from(randomBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return new Keypair(hex, lightWasm);
  }

  static fromPrivkey(privkeyHex: string, lightWasm: LightWasm): Keypair {
    return new Keypair(privkeyHex, lightWasm);
  }

  toHex(): string {
    return "0x" + this.privkey.toString(16).padStart(64, "0");
  }
}
