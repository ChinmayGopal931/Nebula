// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "poseidon-solidity/PoseidonT3.sol";

contract MerkleTree {
    uint256 public constant MERKLE_TREE_HEIGHT = 26;
    uint256 public constant ROOT_HISTORY_SIZE = 100;
    uint256 public constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256[MERKLE_TREE_HEIGHT] public subtrees;
    uint256 public currentRoot;
    uint256[ROOT_HISTORY_SIZE] public rootHistory;
    uint256 public rootIndex;
    uint256 public nextIndex;

    // Pre-computed zero values: zeros[0] = 0, zeros[i] = poseidon(zeros[i-1], zeros[i-1])
    uint256[MERKLE_TREE_HEIGHT + 1] internal _zeros;

    function _initMerkleTree() internal {
        _zeros[0] = 0;
        for (uint256 i = 1; i <= MERKLE_TREE_HEIGHT; i++) {
            _zeros[i] = PoseidonT3.hash([_zeros[i - 1], _zeros[i - 1]]);
        }

        // Initialize subtrees with zero values
        for (uint256 i = 0; i < MERKLE_TREE_HEIGHT; i++) {
            subtrees[i] = _zeros[i];
        }

        // Set initial root
        currentRoot = _zeros[MERKLE_TREE_HEIGHT];
        rootHistory[0] = currentRoot;
    }

    function _insert(uint256 leaf) internal returns (uint256 index) {
        uint256 _nextIndex = nextIndex;
        require(_nextIndex < (1 << MERKLE_TREE_HEIGHT), "Merkle tree is full");

        uint256 currentIdx = _nextIndex;
        uint256 currentLevelHash = leaf;

        for (uint256 i = 0; i < MERKLE_TREE_HEIGHT; i++) {
            uint256 left;
            uint256 right;

            if (currentIdx % 2 == 0) {
                left = currentLevelHash;
                right = _zeros[i];
                subtrees[i] = currentLevelHash;
            } else {
                left = subtrees[i];
                right = currentLevelHash;
            }

            currentLevelHash = PoseidonT3.hash([left, right]);
            currentIdx /= 2;
        }

        currentRoot = currentLevelHash;
        nextIndex = _nextIndex + 1;

        uint256 newRootIndex = (rootIndex + 1) % ROOT_HISTORY_SIZE;
        rootIndex = newRootIndex;
        rootHistory[newRootIndex] = currentLevelHash;

        return _nextIndex;
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) {
            return false;
        }

        uint256 currentRootIndex = rootIndex;
        uint256 i = currentRootIndex;

        do {
            if (root == rootHistory[i]) {
                return true;
            }

            if (i == 0) {
                i = ROOT_HISTORY_SIZE - 1;
            } else {
                i--;
            }
        } while (i != currentRootIndex);

        return false;
    }

    function zeros(uint256 index) public view returns (uint256) {
        return _zeros[index];
    }
}
