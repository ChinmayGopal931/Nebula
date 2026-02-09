import BN from "bn.js";
import { LightWasm } from "@lightprotocol/hasher.rs";
import { FIELD_SIZE } from "./constants";

export class Keypair {
  public privkey: string;
  public pubkey: string;
  private lightWasm: LightWasm;

  constructor(lightWasm: LightWasm, privkey?: string) {
    this.lightWasm = lightWasm;
    if (privkey) {
      this.privkey = new BN(privkey).mod(FIELD_SIZE).toString();
    } else {
      const randomBytes = new Uint8Array(32);
      crypto.getRandomValues(randomBytes);
      const hex = Array.from(randomBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      this.privkey = new BN(hex, 16).mod(FIELD_SIZE).toString();
    }
    this.pubkey = this.lightWasm.poseidonHashString([this.privkey]);
  }

  sign(commitment: string, merklePath: string): string {
    return this.lightWasm.poseidonHashString([
      this.privkey,
      commitment,
      merklePath,
    ]);
  }

  static generateNew(lightWasm: LightWasm): Keypair {
    return new Keypair(lightWasm);
  }

  static fromPrivkey(privkeyHex: string, lightWasm: LightWasm): Keypair {
    // Accept hex strings (0x-prefixed) or decimal strings
    const decimal = BigInt(privkeyHex);
    return new Keypair(lightWasm, decimal.toString());
  }

  toHex(): string {
    return "0x" + new BN(this.privkey).toString(16).padStart(64, "0");
  }
}
