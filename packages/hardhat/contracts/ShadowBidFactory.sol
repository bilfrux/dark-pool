// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

// ─── Vault Initializer Interface ──────────────────────────────────────────────
// Matches ShadowBidVault.initialize() — allows factory to call it after cloning
// without embedding the full vault bytecode in the factory's runtime code.
interface IShadowBidVaultInit {
    function initialize(
        address _factory,
        address _platformAdmin,
        address _oracle,
        bytes32 _assetProofHash,
        uint256 _declaredAssetValue,
        address _assetTokenContract,
        uint256 _assetTokenId,
        bool _requiresAccreditation,
        string[] calldata _allowedJurisdictions,
        address _settlementToken,
        uint256 _settlementWindow,
        uint256 _oracleTimeout,
        address _buyer,
        string calldata _title,
        string calldata _description,
        uint256 _closeTime,
        uint256 _revealWindow,
        uint256 _depositRequired,
        address[] calldata _allowedSuppliers,
        string calldata _buyerECIESPubKey,
        uint256 _reviewWindowSeconds
    ) external payable;
}

/**
 * @title ShadowBidFactory
 * @notice Deployed on ADI Chain — manages global KYB registry and creates ShadowBidVault instances
 *
 * GLOBAL KYB STATE:
 * - verified: institutions that have passed KYB/AML checks via Sumsub
 * - isAccredited: institutions certified as accredited investors
 * - affiliatedWith: conflict-of-interest tracking (bidder => creator)
 *
 * ACCESS CONTROL:
 * - ADMIN_ROLE: platform compliance team — can verify/revoke institutions
 * - BUYER_ROLE: verified institutions that can create auctions
 */
contract ShadowBidFactory is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant BUYER_ROLE = keccak256("BUYER_ROLE");

    /// @dev Vault implementation deployed once; factory clones it (EIP-1167) per auction.
    address public immutable vaultImpl;

    // ─── Global KYB State ─────────────────────────────────────────────────────
    mapping(address => bool) public verified;
    mapping(address => bool) public isAccredited;
    mapping(address => address) public affiliatedWith;
    mapping(address => string) public institutionJurisdiction;

    // ─── Vault Registry ───────────────────────────────────────────────────────
    address[] public allVaults;
    mapping(address => bool) public isVault;
    mapping(address => address[]) public vaultsByBuyer;

    // ─── Events ───────────────────────────────────────────────────────────────
    event VaultCreated(
        address indexed vault,
        address indexed buyer,
        string title,
        uint256 closeTime,
        uint256 depositRequired
    );
    event InstitutionVerified(address indexed inst, bool accredited);
    event InstitutionRevoked(address indexed inst);

    constructor(address _vaultImpl) {
        vaultImpl = _vaultImpl;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(BUYER_ROLE, msg.sender);
    }

    // ─── KYB Identity Management ──────────────────────────────────────────────

    /**
     * @notice Mark an institution as KYB-verified after off-chain Sumsub review.
     *         Called by the platform compliance team after review approval.
     * @param inst         Institution wallet address
     * @param accredited   Whether the institution qualifies as an accredited investor
     * @param _jurisdiction ISO-3166 jurisdiction code (e.g. "UAE", "GB", "SG")
     */
    function verifyInstitution(
        address inst,
        bool accredited,
        string calldata _jurisdiction,
        bytes calldata /* sig — stored off-chain for audit; on-chain authority is ADMIN_ROLE */
    ) external onlyRole(ADMIN_ROLE) {
        verified[inst] = true;
        isAccredited[inst] = accredited;
        institutionJurisdiction[inst] = _jurisdiction;
        emit InstitutionVerified(inst, accredited);
    }

    /**
     * @notice Revoke an institution's verification (e.g., sanctions hit on re-screening).
     */
    function revokeInstitution(address inst) external onlyRole(ADMIN_ROLE) {
        verified[inst] = false;
        isAccredited[inst] = false;
        _revokeRole(BUYER_ROLE, inst); // a revoked institution must not keep creating auctions
        emit InstitutionRevoked(inst);
    }

    /**
     * @notice Record conflict-of-interest relationship for compliance enforcement.
     */
    function setAffiliated(address bidder, address withCreator) external onlyRole(ADMIN_ROLE) {
        affiliatedWith[bidder] = withCreator;
    }

    // ─── Vault Creation ───────────────────────────────────────────────────────

    /**
     * @notice Create a new sealed-bid auction vault.
     *         Creator must post a bond proportional to the declared asset value.
     *
     * @param _title               Auction title
     * @param _description         Full description
     * @param _closeTime           Unix timestamp for bidding close (must be > now + 5min)
     * @param _revealWindow        Reveal window duration in seconds (min: 3600)
     * @param _depositRequired     Deposit amount in wei that each bidder must post
     * @param _allowedSuppliers    Whitelisted supplier/bidder addresses
     * @param _buyerECIESPubKey    ECIES public key hex for encrypted off-chain bid data
     * @param _oracle              Oracle address that confirms real-world delivery
     * @param _assetProofHash      keccak256 of legal document / title deed
     * @param _settlementWindow    Seconds for winner to submit payment (default: 48h)
     * @param _oracleTimeout       Seconds for oracle to confirm delivery (default: 30d)
     * @param _requiresAccreditation  Whether bidders must be accredited investors
     * @param _allowedJurisdictions   Allowed jurisdiction codes (e.g. ["UAE", "KSA"])
     * @param _settlementToken     DDSC token address for settlement (must not be address(0))
     * @param _declaredAssetValue  Declared value of the asset in wei (used for bond calc)
     * @param _reviewWindowSeconds Seconds bidders must wait to review docs before bidding
     */
    function createVault(
        string calldata _title,
        string calldata _description,
        uint256 _closeTime,
        uint256 _revealWindow,
        uint256 _depositRequired,
        address[] calldata _allowedSuppliers,
        string calldata _buyerECIESPubKey,
        address _oracle,
        bytes32 _assetProofHash,
        uint256 _settlementWindow,
        uint256 _oracleTimeout,
        bool _requiresAccreditation,
        string[] calldata _allowedJurisdictions,
        address _settlementToken,
        uint256 _declaredAssetValue,
        uint256 _reviewWindowSeconds
    ) external payable onlyRole(BUYER_ROLE) returns (address vaultAddr) {
        require(_closeTime > block.timestamp + 300, "closeTime must be > now + 5min");
        require(_revealWindow >= 3600, "revealWindow must be >= 1h");
        require(_allowedSuppliers.length >= 1, "At least 1 supplier required");
        require(_settlementToken != address(0), "Settlement token required");

        // Clone the implementation (EIP-1167 minimal proxy, ~55 bytes, ~500 gas)
        address clone = Clones.clone(vaultImpl);
        IShadowBidVaultInit(clone).initialize{ value: msg.value }(
            address(this), // factory (KYB oracle)
            msg.sender, // platformAdmin
            _oracle,
            _assetProofHash,
            _declaredAssetValue,
            address(0), // no tokenized asset (can add later)
            0,
            _requiresAccreditation,
            _allowedJurisdictions,
            _settlementToken,
            _settlementWindow,
            _oracleTimeout,
            msg.sender, // buyer = vault creator
            _title,
            _description,
            _closeTime,
            _revealWindow,
            _depositRequired,
            _allowedSuppliers,
            _buyerECIESPubKey,
            _reviewWindowSeconds
        );

        vaultAddr = clone;
        allVaults.push(vaultAddr);
        isVault[vaultAddr] = true;
        vaultsByBuyer[msg.sender].push(vaultAddr);

        emit VaultCreated(vaultAddr, msg.sender, _title, _closeTime, _depositRequired);
    }

    // ─── View Helpers ─────────────────────────────────────────────────────────

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }

    function getVaultsByBuyer(address b) external view returns (address[] memory) {
        return vaultsByBuyer[b];
    }

    // ─── Role Management ──────────────────────────────────────────────────────

    function grantBuyerRole(address account) external onlyRole(ADMIN_ROLE) {
        _grantRole(BUYER_ROLE, account);
    }

    function revokeBuyerRole(address account) external onlyRole(ADMIN_ROLE) {
        _revokeRole(BUYER_ROLE, account);
    }

    function grantAdminRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(ADMIN_ROLE, account);
    }
}
