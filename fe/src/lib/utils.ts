import BN from "bn.js";
import { keccak256 } from "viem";
import { FIELD_SIZE } from "./constants";

/**
 * Compute extDataHash matching the Solidity contract:
 *   uint256(keccak256(abi.encodePacked(recipient, extAmount, enc1, enc2, fee, feeRecipient, tokenAddress))) % FIELD_SIZE
 */
export function getExtDataHash(extData: {
  recipient: string;
  extAmount: BN | number | string;
  encryptedOutput1?: Uint8Array;
  encryptedOutput2?: Uint8Array;
  fee: BN | number | string;
  feeRecipient: string;
  tokenAddress: string;
}): string {
  const extAmount = new BN(extData.extAmount.toString());
  const fee = new BN(extData.fee.toString());

  const encryptedOutput1 = extData.encryptedOutput1
    ? extData.encryptedOutput1
    : new Uint8Array(0);
  const encryptedOutput2 = extData.encryptedOutput2
    ? extData.encryptedOutput2
    : new Uint8Array(0);

  // Convert extAmount (i64 equivalent) to int256 (32 bytes, two's complement)
  const extAmountBytes = toInt256Bytes(extAmount);
  // Convert fee (u64 equivalent) to uint256 (32 bytes)
  const feeBytes = toUint256Bytes(fee);

  // abi.encodePacked: address(20) + int256(32) + bytes + bytes + uint256(32) + address(20) + address(20)
  const recipientBytes = hexToBytes(extData.recipient);
  const feeRecipientBytes = hexToBytes(extData.feeRecipient);
  const tokenAddressBytes = hexToBytes(extData.tokenAddress);

  const totalLen =
    20 + 32 + encryptedOutput1.length + encryptedOutput2.length + 32 + 20 + 20;
  const packed = new Uint8Array(totalLen);
  let offset = 0;

  packed.set(recipientBytes, offset);
  offset += 20;
  packed.set(extAmountBytes, offset);
  offset += 32;
  packed.set(encryptedOutput1, offset);
  offset += encryptedOutput1.length;
  packed.set(encryptedOutput2, offset);
  offset += encryptedOutput2.length;
  packed.set(feeBytes, offset);
  offset += 32;
  packed.set(feeRecipientBytes, offset);
  offset += 20;
  packed.set(tokenAddressBytes, offset);

  const hashHex = keccak256(packed);
  const hashBN = new BN(hashHex.slice(2), 16);
  const reduced = hashBN.mod(FIELD_SIZE);

  return reduced.toString();
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return bytes;
}

function toInt256Bytes(value: BN): Uint8Array {
  const buf = new Uint8Array(32);
  if (value.isNeg()) {
    // Two's complement: 2^256 + value
    const twosComp = new BN(2).pow(new BN(256)).add(value);
    const hex = twosComp.toString(16).padStart(64, "0");
    const bytes = hexToBytes(hex);
    buf.set(bytes);
  } else {
    const hex = value.toString(16).padStart(64, "0");
    const bytes = hexToBytes(hex);
    buf.set(bytes);
  }
  return buf;
}

function toUint256Bytes(value: BN): Uint8Array {
  const buf = new Uint8Array(32);
  const hex = value.toString(16).padStart(64, "0");
  const bytes = hexToBytes(hex);
  buf.set(bytes);
  return buf;
}

/**
 * Get the mint/token address field for Poseidon commitment.
 * For EVM: use address as a BN (20 bytes / 160 bits — fits in BN254 field).
 */
export function getMintAddressField(tokenAddress: string): string {
  const cleaned = tokenAddress.startsWith("0x")
    ? tokenAddress.slice(2)
    : tokenAddress;
  const addrBN = new BN(cleaned, 16);
  return addrBN.toString();
}

/**
 * Convert public amount for circuit input.
 * For withdrawals (negative), compute FIELD_SIZE - abs(amount).
 */
export function toPublicAmount(extAmount: BN): string {
  if (extAmount.isNeg()) {
    return FIELD_SIZE.sub(extAmount.neg()).toString();
  }
  return extAmount.toString();
}

export function formatUSDC(lamports: number | BN): string {
  const val = typeof lamports === "number" ? lamports : lamports.toNumber();
  return (val / 1_000_000).toFixed(2);
}

export function parseUSDC(usdcString: string): number {
  return Math.round(parseFloat(usdcString) * 1_000_000);
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function shortenSignature(sig: string, chars = 8): string {
  return `${sig.slice(0, chars)}...${sig.slice(-chars)}`;
}
