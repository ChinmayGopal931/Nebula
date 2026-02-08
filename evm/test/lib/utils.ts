import { ethers } from "ethers";
import BN from "bn.js";
import { FIELD_SIZE } from "./constants";

/**
 * Compute extDataHash matching the Solidity contract:
 *   uint256(keccak256(abi.encodePacked(recipient, extAmount, enc1, enc2, fee, feeRecipient, tokenAddress))) % FIELD_SIZE
 */
export function getExtDataHash(extData: {
  recipient: string;
  extAmount: BN | number | string;
  encryptedOutput1?: Buffer | Uint8Array;
  encryptedOutput2?: Buffer | Uint8Array;
  fee: BN | number | string;
  feeRecipient: string;
  tokenAddress: string;
}): string {
  const extAmount = new BN(extData.extAmount.toString());
  const fee = new BN(extData.fee.toString());

  const encryptedOutput1 = extData.encryptedOutput1
    ? Buffer.from(extData.encryptedOutput1 as any)
    : Buffer.alloc(0);
  const encryptedOutput2 = extData.encryptedOutput2
    ? Buffer.from(extData.encryptedOutput2 as any)
    : Buffer.alloc(0);

  // Convert extAmount (i64 equivalent) to int256 (32 bytes, two's complement)
  const extAmountBytes = toInt256Bytes(extAmount);
  // Convert fee (u64 equivalent) to uint256 (32 bytes)
  const feeBytes = toUint256Bytes(fee);

  // abi.encodePacked: address(20) + int256(32) + bytes + bytes + uint256(32) + address(20) + address(20)
  const packed = Buffer.concat([
    Buffer.from(extData.recipient.slice(2), "hex"), // 20 bytes
    extAmountBytes, // 32 bytes
    encryptedOutput1, // variable length
    encryptedOutput2, // variable length
    feeBytes, // 32 bytes
    Buffer.from(extData.feeRecipient.slice(2), "hex"), // 20 bytes
    Buffer.from(extData.tokenAddress.slice(2), "hex"), // 20 bytes
  ]);

  const hashHex = ethers.keccak256(packed);
  const hashBN = new BN(hashHex.slice(2), 16);
  const reduced = hashBN.mod(FIELD_SIZE);

  return reduced.toString();
}

/**
 * Convert a BN to a 32-byte int256 (two's complement, big-endian)
 */
function toInt256Bytes(value: BN): Buffer {
  const buf = Buffer.alloc(32, 0);
  if (value.isNeg()) {
    // Two's complement: 2^256 + value
    const twosComp = new BN(2).pow(new BN(256)).add(value);
    const hex = twosComp.toString(16).padStart(64, "0");
    Buffer.from(hex, "hex").copy(buf);
  } else {
    const hex = value.toString(16).padStart(64, "0");
    Buffer.from(hex, "hex").copy(buf);
  }
  return buf;
}

/**
 * Convert a BN to a 32-byte uint256 (big-endian)
 */
function toUint256Bytes(value: BN): Buffer {
  const buf = Buffer.alloc(32, 0);
  const hex = value.toString(16).padStart(64, "0");
  Buffer.from(hex, "hex").copy(buf);
  return buf;
}

/**
 * Get the mint/token address field for Poseidon commitment.
 * For EVM: use first 20 bytes of address as a BN (fits in BN254 field).
 */
export function getMintAddressField(tokenAddress: string): string {
  // EVM address is 20 bytes, which is 160 bits — fits in BN254 field (254 bits)
  const addrBN = new BN(tokenAddress.slice(2), 16);
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
