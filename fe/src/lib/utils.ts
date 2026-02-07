import BN from "bn.js";
import { utils } from "ffjavascript";
import * as borsh from "borsh";
import { sha256 } from "@ethersproject/sha2";
import { PublicKey } from "@solana/web3.js";

export function bnToBytes(bn: BN): number[] {
  return Array.from(
    (utils as any).leInt2Buff((utils as any).unstringifyBigInts(bn.toString()), 32)
  ).reverse() as number[];
}

export function getExtDataHash(extData: {
  recipient: string | PublicKey;
  extAmount: string | number | BN;
  encryptedOutput1?: string | Uint8Array;
  encryptedOutput2?: string | Uint8Array;
  fee: string | number | BN;
  feeRecipient: string | PublicKey;
  mintAddress: string | PublicKey;
}): Uint8Array {
  const recipient =
    extData.recipient instanceof PublicKey
      ? extData.recipient
      : new PublicKey(extData.recipient);

  const feeRecipient =
    extData.feeRecipient instanceof PublicKey
      ? extData.feeRecipient
      : new PublicKey(extData.feeRecipient);

  const mintAddress =
    extData.mintAddress instanceof PublicKey
      ? extData.mintAddress
      : new PublicKey(extData.mintAddress);

  const extAmount = new BN(extData.extAmount.toString());
  const fee = new BN(extData.fee.toString());

  const encryptedOutput1 = extData.encryptedOutput1
    ? new Uint8Array(
        typeof extData.encryptedOutput1 === "string"
          ? new TextEncoder().encode(extData.encryptedOutput1)
          : extData.encryptedOutput1
      )
    : new Uint8Array(0);

  const encryptedOutput2 = extData.encryptedOutput2
    ? new Uint8Array(
        typeof extData.encryptedOutput2 === "string"
          ? new TextEncoder().encode(extData.encryptedOutput2)
          : extData.encryptedOutput2
      )
    : new Uint8Array(0);

  const schema = {
    struct: {
      recipient: { array: { type: "u8" as const, len: 32 } },
      extAmount: "i64" as const,
      encryptedOutput1: { array: { type: "u8" as const } },
      encryptedOutput2: { array: { type: "u8" as const } },
      fee: "u64" as const,
      feeRecipient: { array: { type: "u8" as const, len: 32 } },
      mintAddress: { array: { type: "u8" as const, len: 32 } },
    },
  };

  const value = {
    recipient: recipient.toBytes(),
    extAmount,
    encryptedOutput1,
    encryptedOutput2,
    fee,
    feeRecipient: feeRecipient.toBytes(),
    mintAddress: mintAddress.toBytes(),
  };

  const serializedData = borsh.serialize(schema, value);
  const hashHex = sha256(serializedData);
  const hexStr = hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex;

  // Convert hex string to Uint8Array
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < hexStr.length; i += 2) {
    bytes[i / 2] = parseInt(hexStr.substring(i, i + 2), 16);
  }
  return bytes;
}

export function getMintAddressField(mint: PublicKey): string {
  const mintBytes = mint.toBytes();
  return new BN(mintBytes.slice(0, 31), 16, "be").toString();
}

export function findNullifierPDAs(
  programId: PublicKey,
  proof: { inputNullifiers: number[][] }
) {
  const [nullifier0PDA] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("nullifier0"),
      new Uint8Array(proof.inputNullifiers[0]),
    ],
    programId
  );
  const [nullifier1PDA] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("nullifier1"),
      new Uint8Array(proof.inputNullifiers[1]),
    ],
    programId
  );
  return { nullifier0PDA, nullifier1PDA };
}

export function findCrossCheckNullifierPDAs(
  programId: PublicKey,
  proof: { inputNullifiers: number[][] }
) {
  const [nullifier2PDA] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("nullifier0"),
      new Uint8Array(proof.inputNullifiers[1]),
    ],
    programId
  );
  const [nullifier3PDA] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("nullifier1"),
      new Uint8Array(proof.inputNullifiers[0]),
    ],
    programId
  );
  return { nullifier2PDA, nullifier3PDA };
}

export function formatUSDC(lamports: number | BN): string {
  const val = typeof lamports === "number" ? lamports : lamports.toNumber();
  return (val / 1_000_000).toFixed(2);
}

export function parseUSDC(usdcString: string): number {
  return Math.round(parseFloat(usdcString) * 1_000_000);
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function shortenSignature(sig: string, chars = 8): string {
  return `${sig.slice(0, chars)}...${sig.slice(-chars)}`;
}
