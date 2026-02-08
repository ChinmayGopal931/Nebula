// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Simple 1:1 yield vault (like mock-klend). Mints yUSDC shares 1:1 for USDC deposits.
contract MockYieldVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlying;

    constructor(address _underlying) ERC20("Yield USDC", "yUSDC") {
        underlying = IERC20(_underlying);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function deposit(uint256 amount) external {
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount); // 1:1
    }

    function redeem(uint256 shares) external {
        _burn(msg.sender, shares);
        underlying.safeTransfer(msg.sender, shares); // 1:1
    }
}
