import { defineChain } from "viem";
import { http, createConfig } from "wagmi";

// MegaETH testnet chain definition
export const megaethTestnet = defineChain({
  id: 6343,
  name: "MegaETH Testnet",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://carrot.megaeth.com/rpc"],
    },
  },
  blockExplorers: {
    default: {
      name: "MegaETH Explorer",
      url: "https://megaexplorer.xyz",
    },
  },
  testnet: true,
});

// Contract addresses (MegaETH testnet)
export const POOL_ADDRESS = "0xD1065321bB703203F1EE29Acc073C6d1eA1A28E2" as const;
export const USDC_ADDRESS = "0x7b70eD83f826cE59e65BF1711D60C6F27a0B2eB1" as const;
export const VERIFIER_ADDRESS = "0x567B24545cF1739A300cCDbA0E72ec07Ad6971F4" as const;

// Minimal ERC-20 ABI
export const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// PrivacyPool ABI (relevant functions + events)
export const POOL_ABI = [
  {
    name: "transact",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proofA", type: "uint256[2]" },
      { name: "proofB", type: "uint256[2][2]" },
      { name: "proofC", type: "uint256[2]" },
      { name: "root", type: "uint256" },
      { name: "publicAmount", type: "uint256" },
      { name: "extDataHash", type: "uint256" },
      { name: "inputNullifiers", type: "bytes32[2]" },
      { name: "outputCommitments", type: "uint256[2]" },
      {
        name: "extData",
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "extAmount", type: "int256" },
          { name: "encryptedOutput1", type: "bytes" },
          { name: "encryptedOutput2", type: "bytes" },
          { name: "fee", type: "uint256" },
          { name: "feeRecipient", type: "address" },
          { name: "tokenAddress", type: "address" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "NewCommitment",
    type: "event",
    inputs: [
      { name: "commitment", type: "uint256", indexed: true },
      { name: "index", type: "uint256", indexed: false },
      { name: "encryptedOutput", type: "bytes", indexed: false },
    ],
  },
  {
    name: "NewNullifier",
    type: "event",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
    ],
  },
] as const;

// wagmi config
export const wagmiConfig = createConfig({
  chains: [megaethTestnet],
  transports: {
    [megaethTestnet.id]: http(),
  },
  ssr: true,
});
