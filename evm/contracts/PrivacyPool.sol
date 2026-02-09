// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./MerkleTree.sol";
import "./interfaces/IVerifier.sol";
import "./interfaces/IYieldVault.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract PrivacyPool is MerkleTree {
    using SafeERC20 for IERC20;

    IVerifier public immutable verifier;
    IERC20 public immutable token;
    uint256 public immutable maxDepositAmount;

    address public owner;
    address public yieldVault;

    mapping(bytes32 => bool) public nullifiers;

    struct ExtData {
        address recipient;
        int256 extAmount;
        bytes encryptedOutput1;
        bytes encryptedOutput2;
        uint256 fee;
        address feeRecipient;
        address tokenAddress;
    }

    struct TransactParams {
        uint256[2] proofA;
        uint256[2][2] proofB;
        uint256[2] proofC;
        uint256 root;
        uint256 publicAmount;
        uint256 extDataHash;
        bytes32[2] inputNullifiers;
        uint256[2] outputCommitments;
        ExtData extData;
    }

    event NewCommitment(uint256 indexed commitment, uint256 index, bytes encryptedOutput);
    event NewNullifier(bytes32 indexed nullifier);

    error AlreadySpent();
    error UnknownRoot();
    error InvalidProof();
    error InvalidExtAmount();
    error ExtDataHashMismatch();
    error InvalidPublicAmount();
    error DepositLimitExceeded();
    error InsufficientPoolBalance();

    constructor(
        address _verifier,
        address _token,
        uint256 _maxDepositAmount
    ) {
        verifier = IVerifier(_verifier);
        token = IERC20(_token);
        maxDepositAmount = _maxDepositAmount;
        owner = msg.sender;
        _initMerkleTree();
    }

    function transact(
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        uint256 root,
        uint256 publicAmount,
        uint256 extDataHash,
        bytes32[2] calldata inputNullifiers,
        uint256[2] calldata outputCommitments,
        ExtData calldata extData
    ) external {
        // Auto-yield: redeem before withdrawal
        if (yieldVault != address(0) && extData.extAmount < 0) {
            _redeemAllFromVault();
        }

        _transactCore(proofA, proofB, proofC, root, publicAmount, extDataHash,
                      inputNullifiers, outputCommitments, extData);

        // Auto-yield: sweep after deposit (skip merge — extAmount == 0)
        if (yieldVault != address(0) && extData.extAmount != 0) {
            _sweepToVault();
        }
    }

    function batchTransact(TransactParams[] calldata paramsList) external {
        require(paramsList.length > 0, "Empty batch");
        require(paramsList.length <= 50, "Batch too large");

        // Redeem all from vault once at start
        if (yieldVault != address(0)) {
            _redeemAllFromVault();
        }

        for (uint256 i = 0; i < paramsList.length; i++) {
            _transactCore(
                paramsList[i].proofA,
                paramsList[i].proofB,
                paramsList[i].proofC,
                paramsList[i].root,
                paramsList[i].publicAmount,
                paramsList[i].extDataHash,
                paramsList[i].inputNullifiers,
                paramsList[i].outputCommitments,
                paramsList[i].extData
            );
        }

        // Sweep all remaining USDC to vault at end
        if (yieldVault != address(0)) {
            _sweepToVault();
        }
    }

    // ==================== Yield Vault Functions ====================

    function configureYield(address _vault) external {
        require(msg.sender == owner, "Not owner");
        yieldVault = _vault;
        // Approve vault to pull tokens
        token.approve(_vault, type(uint256).max);
    }

    function yieldDeposit() external {
        require(yieldVault != address(0), "Vault not configured");
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) return;
        IYieldVault(yieldVault).deposit(balance);
    }

    function yieldRedeem() external {
        require(yieldVault != address(0), "Vault not configured");
        uint256 shares = IYieldVault(yieldVault).balanceOf(address(this));
        if (shares == 0) return;
        IYieldVault(yieldVault).redeem(shares);
    }

    // ==================== Internal ====================

    function _transactCore(
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        uint256 root,
        uint256 publicAmount,
        uint256 extDataHash,
        bytes32[2] calldata inputNullifiers,
        uint256[2] calldata outputCommitments,
        ExtData calldata extData
    ) internal {
        // 1. Check root is known
        if (!isKnownRoot(root)) revert UnknownRoot();

        // 2. Check nullifiers haven't been spent
        if (nullifiers[inputNullifiers[0]]) revert AlreadySpent();
        if (nullifiers[inputNullifiers[1]]) revert AlreadySpent();

        // 3. Compute extDataHash from extData
        uint256 calculatedExtDataHash = uint256(keccak256(abi.encodePacked(
            extData.recipient,
            extData.extAmount,
            extData.encryptedOutput1,
            extData.encryptedOutput2,
            extData.fee,
            extData.feeRecipient,
            extData.tokenAddress
        ))) % FIELD_SIZE;

        if (calculatedExtDataHash != extDataHash) revert ExtDataHashMismatch();

        // 4. Check publicAmount matches extAmount - fee
        if (!_checkPublicAmount(extData.extAmount, extData.fee, publicAmount)) {
            revert InvalidPublicAmount();
        }

        // 5. Verify the Groth16 proof
        //    Public signals order: [root, publicAmount, extDataHash, nullifier0, nullifier1, commitment0, commitment1]
        bool proofValid = verifier.verifyProof(
            proofA,
            proofB,
            proofC,
            [
                root,
                publicAmount,
                extDataHash,
                uint256(inputNullifiers[0]),
                uint256(inputNullifiers[1]),
                outputCommitments[0],
                outputCommitments[1]
            ]
        );
        if (!proofValid) revert InvalidProof();

        // 6. Mark nullifiers as spent
        nullifiers[inputNullifiers[0]] = true;
        nullifiers[inputNullifiers[1]] = true;
        emit NewNullifier(inputNullifiers[0]);
        emit NewNullifier(inputNullifiers[1]);

        // 7. Token transfers
        if (extData.extAmount > 0) {
            // Deposit
            uint256 depositAmount = uint256(extData.extAmount);
            if (depositAmount > maxDepositAmount) revert DepositLimitExceeded();
            token.safeTransferFrom(msg.sender, address(this), depositAmount);
        } else if (extData.extAmount < 0) {
            // Withdrawal
            uint256 withdrawAmount = uint256(-extData.extAmount);
            if (token.balanceOf(address(this)) < withdrawAmount) revert InsufficientPoolBalance();
            token.safeTransfer(extData.recipient, withdrawAmount);
        }
        // extAmount == 0 → merge, no transfer

        // 8. Insert both commitments into the Merkle tree
        uint256 index0 = _insert(outputCommitments[0]);
        uint256 index1 = _insert(outputCommitments[1]);

        // 9. Emit events
        emit NewCommitment(outputCommitments[0], index0, extData.encryptedOutput1);
        emit NewCommitment(outputCommitments[1], index1, extData.encryptedOutput2);
    }

    function _redeemAllFromVault() internal {
        uint256 shares = IYieldVault(yieldVault).balanceOf(address(this));
        if (shares > 0) IYieldVault(yieldVault).redeem(shares);
    }

    function _sweepToVault() internal {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) IYieldVault(yieldVault).deposit(balance);
    }

    function _checkPublicAmount(
        int256 extAmount,
        uint256 fee,
        uint256 publicAmount
    ) internal pure returns (bool) {
        if (extAmount == type(int256).min) return false;

        // For deposits or merge (extAmount >= 0): publicAmount = extAmount - fee
        // For withdrawals (extAmount < 0): publicAmount = FIELD_SIZE - (|extAmount| + fee)
        uint256 expectedPublicAmount;

        if (extAmount >= 0) {
            uint256 absExtAmount = uint256(extAmount);
            // Allow ext_amount == 0 (merge) regardless of fee
            if (extAmount > 0 && absExtAmount <= fee) return false;
            expectedPublicAmount = absExtAmount - fee;
        } else {
            uint256 absExtAmount = uint256(-extAmount);
            // Negative: FIELD_SIZE - (absExtAmount + fee)
            expectedPublicAmount = FIELD_SIZE - (absExtAmount + fee);
        }

        return expectedPublicAmount == publicAmount;
    }
}
