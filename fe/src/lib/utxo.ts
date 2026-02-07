import BN from "bn.js";
import { Keypair } from "./keypair";
import { LightWasm } from "@lightprotocol/hasher.rs";
import { PublicKey } from "@solana/web3.js";
import { getMintAddressField } from "./utils";

export class Utxo {
  lightWasm: LightWasm;
  amount: BN;
  blinding: BN;
  keypair: Keypair;
  index: number;
  mintAddress: string;

  constructor({
    lightWasm,
    amount = new BN(0),
    keypair,
    blinding,
    index = 0,
    mintAddress,
  }: {
    lightWasm: LightWasm;
    amount?: BN | number | string;
    keypair?: Keypair;
    blinding?: BN | number | string;
    index?: number;
    mintAddress?: string;
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
    this.mintAddress = mintAddress || "11111111111111111111111111111112";
  }

  async getCommitment(): Promise<string> {
    const mintAddressField = getMintAddressField(
      new PublicKey(this.mintAddress)
    );
    return this.lightWasm.poseidonHashString([
      this.amount.toString(),
      this.keypair.pubkey.toString(),
      this.blinding.toString(),
      mintAddressField,
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
