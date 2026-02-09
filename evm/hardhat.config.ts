import "dotenv/config";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "paris",
    },
  },
  networks: {
    "megaeth-testnet": {
      url: process.env.MEGAETH_RPC_URL || "https://carrot.megaeth.com/rpc",
      chainId: 6343,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      gasPrice: 1000000, // 0.001 gwei
    },
  },
  mocha: {
    timeout: 120000,
  },
};

export default config;
