import { randomBytes } from "crypto";
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
    blinding = new BN(randomBytes(31)),
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
    this.blinding = new BN(blinding.toString());
    this.keypair = keypair || Keypair.generateNew(this.lightWasm);
    this.index = index;
    // Default token address (zero address equivalent for EVM)
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
