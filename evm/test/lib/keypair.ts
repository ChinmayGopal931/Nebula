import { ethers } from "ethers";
import BN from "bn.js";
import { LightWasm } from "@lightprotocol/hasher.rs";
import { FIELD_SIZE } from "./constants";

export class Keypair {
  privkey: string;
  pubkey: string;
  lightWasm: LightWasm;

  constructor(lightWasm: LightWasm, privkey?: string) {
    this.lightWasm = lightWasm;
    if (privkey) {
      this.privkey = new BN(privkey).mod(FIELD_SIZE).toString();
    } else {
      const wallet = ethers.Wallet.createRandom();
      const rawKey = wallet.privateKey.slice(2); // remove 0x
      this.privkey = new BN(rawKey, 16).mod(FIELD_SIZE).toString();
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
}
