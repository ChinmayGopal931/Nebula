import BN from "bn.js";
import { Keypair } from "./keypair";
import { LightWasm } from "@lightprotocol/hasher.rs";
import { getMintAddressField } from "./utils";

export class Utxo {
  lightWasm: LightWasm;
  amount: BN;
  blinding: BN;
  keypair: Keypair;
  index: number;
  tokenAddress: string;

  constructor({
    lightWasm,
    amount = new BN(0),
    keypair,
    blinding,
    index = 0,
    tokenAddress,
  }: {
    lightWasm: LightWasm;
    amount?: BN | number | string;
    keypair?: Keypair;
    blinding?: BN | number | string;
    index?: number;
    tokenAddress?: string;
  }) {
    this.lightWasm = lightWasm;
    this.amount = new BN(amount.toString());

    if (blinding !== undefined) {
      this.blinding = new BN(blinding.toString());
    } else {
      // Browser-compatible random bytes (248 bits)
      const randomBytes = new Uint8Array(31);
      crypto.getRandomValues(randomBytes);
      this.blinding = new BN(randomBytes);
    }

    this.keypair = keypair || Keypair.generateNew(this.lightWasm);
    this.index = index;
    // Default token address for EVM (matches EVM test lib)
    this.tokenAddress =
      tokenAddress || "0x0000000000000000000000000000000000000001";
  }

  async getCommitment(): Promise<string> {
    const mintField = getMintAddressField(this.tokenAddress);
    return this.lightWasm.poseidonHashString([
      this.amount.toString(),
      this.keypair.pubkey.toString(),
      this.blinding.toString(),
      mintField,
    ]);
  }

  async getNullifier(): Promise<string> {
    const commitmentValue = await this.getCommitment();
    const signature = this.keypair.sign(
      commitmentValue,
      new BN(this.index).toString()
    );
    return this.lightWasm.poseidonHashString([
      commitmentValue,
      new BN(this.index).toString(),
      signature,
    ]);
  }
}
