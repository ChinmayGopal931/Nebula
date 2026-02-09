import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balanceBefore = await ethers.provider.getBalance(deployerAddress);

  console.log("=== MegaETH Testnet Deployment ===");
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Balance:  ${ethers.formatEther(balanceBefore)} ETH`);
  console.log();

  // 1. Deploy PoseidonT3 library
  console.log("1/5 Deploying PoseidonT3...");
  const PoseidonT3Factory = await ethers.getContractFactory("PoseidonT3");
  const poseidonT3 = await PoseidonT3Factory.deploy();
  await poseidonT3.waitForDeployment();
  const poseidonT3Address = await poseidonT3.getAddress();
  console.log(`     PoseidonT3: ${poseidonT3Address}`);

  // 2. Deploy Groth16Verifier
  console.log("2/5 Deploying Groth16Verifier...");
  const VerifierFactory = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await VerifierFactory.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log(`     Verifier:   ${verifierAddress}`);

  // 3. Deploy MockUSDC and mint
  console.log("3/5 Deploying MockUSDC...");
  const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDCFactory.deploy();
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log(`     MockUSDC:   ${usdcAddress}`);

  const mintAmount = 1_000_000n * 10n ** 6n; // 1M USDC
  console.log("     Minting 1,000,000 USDC to deployer...");
  const mintTx = await usdc.mint(deployerAddress, mintAmount);
  await mintTx.wait();

  // 4. Deploy PrivacyPool
  console.log("4/5 Deploying PrivacyPool...");
  const PrivacyPoolFactory = await ethers.getContractFactory("PrivacyPool", {
    libraries: {
      PoseidonT3: poseidonT3Address,
    },
  });
  const maxDeposit = 1_000_000n * 10n ** 6n; // 1M USDC
  const pool = await PrivacyPoolFactory.deploy(
    verifierAddress,
    usdcAddress,
    maxDeposit
  );
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`     PrivacyPool: ${poolAddress}`);

  // 5. Approve pool for USDC spending
  console.log("5/5 Approving PrivacyPool for USDC...");
  const approveTx = await usdc.approve(poolAddress, ethers.MaxUint256);
  await approveTx.wait();
  console.log("     Approved MaxUint256");

  // Save deployment info
  const deploymentsDir = path.resolve(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deployment = {
    network: "megaeth-testnet",
    deployer: deployerAddress,
    timestamp: new Date().toISOString(),
    contracts: {
      poseidonT3: poseidonT3Address,
      verifier: verifierAddress,
      usdc: usdcAddress,
      pool: poolAddress,
    },
  };

  const deploymentPath = path.resolve(deploymentsDir, "megaeth-testnet.json");
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to ${deploymentPath}`);

  const balanceAfter = await ethers.provider.getBalance(deployerAddress);
  const spent = balanceBefore - balanceAfter;
  console.log(`\nBalance after: ${ethers.formatEther(balanceAfter)} ETH`);
  console.log(`ETH spent:     ${ethers.formatEther(spent)} ETH`);
  console.log("\n=== Deployment complete ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
