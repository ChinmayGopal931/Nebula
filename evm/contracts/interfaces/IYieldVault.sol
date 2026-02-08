// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IYieldVault {
    function deposit(uint256 amount) external;
    function redeem(uint256 shares) external;
    function balanceOf(address account) external view returns (uint256);
}
