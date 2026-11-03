/* eslint-disable @typescript-eslint/no-unused-expressions */
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ShadowBidFactory, ShadowBidVault } from "../typechain-types";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Compute the bid commit hash exactly as the Solidity contract does */
function computeCommitHash(price: bigint, salt: string, bidder: string): string {
  return ethers.solidityPackedKeccak256(
    ["uint256", "bytes32", "address"],
    [price, ethers.encodeBytes32String(salt).slice(0, 66), bidder],
  );
}

/**
 * Build and sign an EIP-712 ConflictAttestation for the given vault.
 * The "statement" field is hashed as bytes inside the contract.
 */
async function signConflictAttestation(
  signer: HardhatEthersSigner,
  vaultAddress: string,
  timestamp: number,
  chainId: bigint,
): Promise<string> {
  const domain = {
    name: "DarkPool",
    version: "1",
    chainId,
    verifyingContract: vaultAddress,
  };

  const types = {
    ConflictAttestation: [
      { name: "bidder", type: "address" },
      { name: "vault", type: "address" },
      { name: "statement", type: "string" },
      { name: "timestamp", type: "uint256" },
    ],
  };

  const value = {
    bidder: signer.address,
    vault: vaultAddress,
    statement: "I confirm I am not affiliated with the auction creator and have no conflict of interest.",
    timestamp,
  };

  return signer.signTypedData(domain, types, value);
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────

interface FixtureResult {
  factory: ShadowBidFactory;
  admin: HardhatEthersSigner;
  buyer: HardhatEthersSigner;
  supplier1: HardhatEthersSigner;
  supplier2: HardhatEthersSigner;
  oracle: HardhatEthersSigner;
  stranger: HardhatEthersSigner;
  chainId: bigint;
}

async function deployFactoryFixture(): Promise<FixtureResult> {
  const [admin, buyer, supplier1, supplier2, oracle, stranger] = await ethers.getSigners();

  // Deploy vault implementation once — factory clones it (EIP-1167) per auction
  const VaultImpl = await ethers.getContractFactory("ShadowBidVault");
  const vaultImpl = await VaultImpl.deploy();
  await vaultImpl.waitForDeployment();

  const Factory = await ethers.getContractFactory("ShadowBidFactory");
  const factory = (await Factory.deploy(await vaultImpl.getAddress())) as ShadowBidFactory;
  await factory.waitForDeployment();

  const { chainId } = await ethers.provider.getNetwork();
  return { factory, admin, buyer, supplier1, supplier2, oracle, stranger, chainId };
}

/** Deploy a factory + create a vault with reasonable defaults */
async function deployVaultFixture() {
  const base = await deployFactoryFixture();
  const { factory, admin, buyer, supplier1, supplier2, oracle } = base;

  // Deploy MockERC20 (DDSC stand-in) — mint enough to suppliers for payment tests
  const MockToken = await ethers.getContractFactory("MockERC20");
  const mockToken = (await MockToken.deploy()) as any;
  await mockToken.waitForDeployment();
  await mockToken.mint(supplier1.address, ethers.parseEther("10000"));
  await mockToken.mint(supplier2.address, ethers.parseEther("10000"));

  // Grant buyer role + KYB
  await factory.connect(admin).grantBuyerRole(buyer.address);
  await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");
  await factory.connect(admin).verifyInstitution(supplier1.address, true, "UAE", "0x");
  await factory.connect(admin).verifyInstitution(supplier2.address, true, "UAE", "0x");

  const closeTime = (await time.latest()) + 2 * 3600; // 2 hours
  const revealWindow = 3600; // 1 hour
  const depositRequired = ethers.parseEther("0.01");
  const declaredAssetValue = ethers.parseEther("2"); // 0.5% bond = 0.01 ETH
  const bond = (declaredAssetValue * 5n) / 1000n; // == 0.01 ETH

  const tx = await factory.connect(buyer).createVault(
    "Test Auction",
    "A unit-test auction",
    closeTime,
    revealWindow,
    depositRequired,
    [supplier1.address, supplier2.address],
    "0xECIES_PUB_KEY",
    oracle.address,
    ethers.ZeroHash,
    48 * 3600, // settlementWindow
    30 * 24 * 3600, // oracleTimeout
    false, // requiresAccreditation
    ["UAE"],
    await mockToken.getAddress(), // DDSC settlement token
    declaredAssetValue,
    0, // no review window
    { value: bond },
  );

  const receipt = await tx.wait();
  const event = receipt!.logs
    .map(log => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(e => e?.name === "VaultCreated");

  const vaultAddress = event!.args.vault as string;
  const vault = (await ethers.getContractAt("ShadowBidVault", vaultAddress)) as ShadowBidVault;

  return { ...base, vault, vaultAddress, closeTime, revealWindow, depositRequired, bond, mockToken };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("ShadowBidFactory", function () {
  // ── Deployment ────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("deploys and grants default roles to deployer", async function () {
      const { factory, admin } = await deployFactoryFixture();
      const ADMIN_ROLE = await factory.ADMIN_ROLE();
      const BUYER_ROLE = await factory.BUYER_ROLE();
      expect(await factory.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await factory.hasRole(BUYER_ROLE, admin.address)).to.be.true;
    });
  });

  // ── KYB ───────────────────────────────────────────────────────────────────

  describe("KYB Management", function () {
    it("admin can verify an institution", async function () {
      const { factory, admin, buyer } = await deployFactoryFixture();
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");
      expect(await factory.verified(buyer.address)).to.be.true;
      expect(await factory.isAccredited(buyer.address)).to.be.true;
      expect(await factory.institutionJurisdiction(buyer.address)).to.equal("UAE");
    });

    it("emits InstitutionVerified event", async function () {
      const { factory, admin, buyer } = await deployFactoryFixture();
      await expect(factory.connect(admin).verifyInstitution(buyer.address, false, "SG", "0x"))
        .to.emit(factory, "InstitutionVerified")
        .withArgs(buyer.address, false);
    });

    it("non-admin cannot verify an institution", async function () {
      const { factory, stranger, buyer } = await deployFactoryFixture();
      await expect(
        factory.connect(stranger).verifyInstitution(buyer.address, true, "UAE", "0x"),
      ).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount");
    });

    it("admin can revoke an institution", async function () {
      const { factory, admin, buyer } = await deployFactoryFixture();
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");
      await factory.connect(admin).revokeInstitution(buyer.address);
      expect(await factory.verified(buyer.address)).to.be.false;
      expect(await factory.isAccredited(buyer.address)).to.be.false;
    });

    it("emits InstitutionRevoked event", async function () {
      const { factory, admin, buyer } = await deployFactoryFixture();
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");
      await expect(factory.connect(admin).revokeInstitution(buyer.address))
        .to.emit(factory, "InstitutionRevoked")
        .withArgs(buyer.address);
    });
  });

  // ── Vault Creation ────────────────────────────────────────────────────────

  describe("createVault", function () {
    it("creates a vault and registers it", async function () {
      const { factory, admin, buyer, supplier1, oracle } = await deployFactoryFixture();
      await factory.connect(admin).grantBuyerRole(buyer.address);
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");

      const closeTime = (await time.latest()) + 7200;
      const bond = ethers.parseEther("0.01");

      await factory.connect(buyer).createVault(
        "Vault A",
        "desc",
        closeTime,
        3600,
        ethers.parseEther("0.01"),
        [supplier1.address],
        "0xPUBKEY",
        oracle.address,
        ethers.ZeroHash,
        48 * 3600,
        30 * 24 * 3600,
        false,
        [],
        oracle.address, // non-zero settlement token (DDSC stand-in for test)
        ethers.parseEther("2"),
        0,
        { value: bond },
      );

      const vaults = await factory.getAllVaults();
      expect(vaults.length).to.equal(1);
      expect(await factory.isVault(vaults[0])).to.be.true;
    });

    it("emits VaultCreated event", async function () {
      const { factory, admin, buyer, supplier1, oracle } = await deployFactoryFixture();
      await factory.connect(admin).grantBuyerRole(buyer.address);
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");

      const closeTime = (await time.latest()) + 7200;
      await expect(
        factory.connect(buyer).createVault(
          "My Auction",
          "desc",
          closeTime,
          3600,
          ethers.parseEther("0.01"),
          [supplier1.address],
          "0xPUBKEY",
          oracle.address,
          ethers.ZeroHash,
          48 * 3600,
          30 * 24 * 3600,
          false,
          [],
          oracle.address, // non-zero settlement token
          ethers.parseEther("2"),
          0,
          { value: ethers.parseEther("0.01") },
        ),
      ).to.emit(factory, "VaultCreated");
    });

    it("reverts if closeTime is not > now + 5min", async function () {
      const { factory, admin, buyer, supplier1, oracle } = await deployFactoryFixture();
      await factory.connect(admin).grantBuyerRole(buyer.address);
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");

      const badCloseTime = (await time.latest()) + 100; // < 5 minutes
      await expect(
        factory
          .connect(buyer)
          .createVault(
            "Bad Vault",
            "desc",
            badCloseTime,
            3600,
            ethers.parseEther("0.01"),
            [supplier1.address],
            "0x",
            oracle.address,
            ethers.ZeroHash,
            0,
            0,
            false,
            [],
            ethers.ZeroAddress,
            0,
            0,
            { value: 0 },
          ),
      ).to.be.revertedWith("closeTime must be > now + 5min");
    });

    it("reverts if revealWindow < 1 hour", async function () {
      const { factory, admin, buyer, supplier1, oracle } = await deployFactoryFixture();
      await factory.connect(admin).grantBuyerRole(buyer.address);
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");

      const closeTime = (await time.latest()) + 7200;
      await expect(
        factory.connect(buyer).createVault(
          "Bad Vault",
          "desc",
          closeTime,
          1800, // < 1 hour
          ethers.parseEther("0.01"),
          [supplier1.address],
          "0x",
          oracle.address,
          ethers.ZeroHash,
          0,
          0,
          false,
          [],
          ethers.ZeroAddress,
          0,
          0,
          { value: 0 },
        ),
      ).to.be.revertedWith("revealWindow must be >= 1h");
    });

    it("reverts if no suppliers provided", async function () {
      const { factory, admin, buyer, oracle } = await deployFactoryFixture();
      await factory.connect(admin).grantBuyerRole(buyer.address);
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");

      const closeTime = (await time.latest()) + 7200;
      await expect(
        factory.connect(buyer).createVault(
          "Bad Vault",
          "desc",
          closeTime,
          3600,
          ethers.parseEther("0.01"),
          [], // no suppliers
          "0x",
          oracle.address,
          ethers.ZeroHash,
          0,
          0,
          false,
          [],
          ethers.ZeroAddress,
          0,
          0,
          { value: 0 },
        ),
      ).to.be.revertedWith("At least 1 supplier required");
    });

    it("reverts if creator bond is insufficient", async function () {
      const { factory, admin, buyer, supplier1, oracle } = await deployFactoryFixture();
      await factory.connect(admin).grantBuyerRole(buyer.address);
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");

      const closeTime = (await time.latest()) + 7200;
      await expect(
        factory.connect(buyer).createVault(
          "Underbonded Vault",
          "desc",
          closeTime,
          3600,
          ethers.parseEther("0.01"),
          [supplier1.address],
          "0x",
          oracle.address,
          ethers.ZeroHash,
          0,
          0,
          false,
          [],
          oracle.address, // non-zero settlement token
          ethers.parseEther("2"), // requires 0.01 ETH bond
          0,
          { value: ethers.parseEther("0.001") }, // too low
        ),
      ).to.be.revertedWith("Insufficient creator bond");
    });

    it("non-buyer-role cannot create a vault", async function () {
      const { factory, admin, buyer, supplier1, oracle } = await deployFactoryFixture();
      // buyer does NOT have BUYER_ROLE
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");

      const closeTime = (await time.latest()) + 7200;
      await expect(
        factory
          .connect(buyer)
          .createVault(
            "Unauthorized",
            "desc",
            closeTime,
            3600,
            ethers.parseEther("0.01"),
            [supplier1.address],
            "0x",
            oracle.address,
            ethers.ZeroHash,
            0,
            0,
            false,
            [],
            ethers.ZeroAddress,
            0,
            0,
          ),
      ).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShadowBidVault — Bidding Lifecycle", function () {
  // ── Commit Phase ──────────────────────────────────────────────────────────

  describe("commitBid", function () {
    it("supplier can commit a bid after submitting conflict attestation", async function () {
      const { vault, vaultAddress, supplier1, depositRequired, chainId } = await deployVaultFixture();

      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);

      const price = ethers.parseEther("1");
      const salt = "secret1";
      const commitHash = computeCommitHash(price, salt, supplier1.address);

      await expect(vault.connect(supplier1).commitBid(commitHash, "ipfs://QmTest", { value: depositRequired }))
        .to.emit(vault, "BidCommitted")
        .withArgs(supplier1.address, commitHash, "ipfs://QmTest");

      const bid = await vault.bids(supplier1.address);
      expect(bid.commitHash).to.equal(commitHash);
      expect(bid.depositPaid).to.be.true;
    });

    it("reverts if conflict attestation not submitted", async function () {
      const { vault, depositRequired, supplier1 } = await deployVaultFixture();
      const commitHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        vault.connect(supplier1).commitBid(commitHash, "ipfs://QmTest", { value: depositRequired }),
      ).to.be.revertedWith("Conflict attestation required");
    });

    it("reverts if supplier is not KYB-verified", async function () {
      const { vault, vaultAddress, stranger, depositRequired, chainId } = await deployVaultFixture();
      const ts = await time.latest();
      const sig = await signConflictAttestation(stranger, vaultAddress, ts, chainId);
      await vault.connect(stranger).submitConflictAttestation(ts, sig);

      const commitHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        vault.connect(stranger).commitBid(commitHash, "ipfs://QmTest", { value: depositRequired }),
      ).to.be.revertedWith("Institution not KYB-verified");
    });

    it("reverts if supplier is not whitelisted", async function () {
      const { factory, vault, vaultAddress, stranger, admin, depositRequired, chainId } = await deployVaultFixture();
      // KYB-verify stranger but don't add to whitelist
      await factory.connect(admin).verifyInstitution(stranger.address, true, "UAE", "0x");
      const ts = await time.latest();
      const sig = await signConflictAttestation(stranger, vaultAddress, ts, chainId);
      await vault.connect(stranger).submitConflictAttestation(ts, sig);

      const commitHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        vault.connect(stranger).commitBid(commitHash, "ipfs://QmTest", { value: depositRequired }),
      ).to.be.revertedWith("Not a whitelisted supplier");
    });

    it("reverts if wrong deposit amount", async function () {
      const { vault, vaultAddress, supplier1, chainId } = await deployVaultFixture();
      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);

      const commitHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        vault.connect(supplier1).commitBid(commitHash, "ipfs://QmTest", {
          value: ethers.parseEther("0.001"), // wrong amount
        }),
      ).to.be.revertedWith("Incorrect deposit amount");
    });

    it("reverts if supplier tries to commit twice", async function () {
      const { vault, vaultAddress, supplier1, depositRequired, chainId } = await deployVaultFixture();
      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);

      const price = ethers.parseEther("1");
      const commitHash = computeCommitHash(price, "salt1", supplier1.address);
      await vault.connect(supplier1).commitBid(commitHash, "ipfs://QmA", { value: depositRequired });

      const commitHash2 = computeCommitHash(price, "salt2", supplier1.address);
      await expect(
        vault.connect(supplier1).commitBid(commitHash2, "ipfs://QmB", { value: depositRequired }),
      ).to.be.revertedWith("Already committed");
    });

    it("buyer cannot bid on own auction", async function () {
      // Need a vault where buyer IS whitelisted as supplier so the whitelist check
      // passes and the "Auction creator cannot bid" guard fires.
      const { factory, admin, buyer, supplier1, oracle, chainId } = await deployFactoryFixture();

      await factory.connect(admin).grantBuyerRole(buyer.address);
      await factory.connect(admin).verifyInstitution(buyer.address, true, "UAE", "0x");

      const closeTime = (await time.latest()) + 2 * 3600;
      const depositRequired = ethers.parseEther("0.01");
      const declaredAssetValue = ethers.parseEther("2");
      const bond = (declaredAssetValue * 5n) / 1000n;

      const tx = await factory.connect(buyer).createVault(
        "Buyer-as-supplier Auction",
        "Test buyer guard",
        closeTime,
        3600,
        depositRequired,
        [buyer.address, supplier1.address], // buyer explicitly whitelisted as supplier
        "0xECIES_PUB_KEY",
        oracle.address,
        ethers.ZeroHash,
        48 * 3600,
        30 * 24 * 3600,
        false,
        ["UAE"],
        oracle.address, // non-zero settlement token
        declaredAssetValue,
        0,
        { value: bond },
      );
      const receipt = await tx.wait();
      const event = receipt!.logs
        .map(log => {
          try {
            return factory.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find(e => e?.name === "VaultCreated");
      const vaultAddress = event!.args.vault as string;
      const vault = (await ethers.getContractAt("ShadowBidVault", vaultAddress)) as ShadowBidVault;

      const ts = await time.latest();
      const sig = await signConflictAttestation(buyer, vaultAddress, ts, chainId);
      await vault.connect(buyer).submitConflictAttestation(ts, sig);

      const commitHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        vault.connect(buyer).commitBid(commitHash, "ipfs://QmTest", { value: depositRequired }),
      ).to.be.revertedWith("Auction creator cannot bid");
    });
  });

  // ── Phase Transition ──────────────────────────────────────────────────────

  describe("triggerRevealPhase", function () {
    it("anyone can trigger reveal phase after closeTime", async function () {
      const { vault, closeTime, stranger } = await deployVaultFixture();
      await time.increaseTo(closeTime + 1);
      await expect(vault.connect(stranger).triggerRevealPhase()).to.emit(vault, "PhaseChanged");
      expect(await vault.phase()).to.equal(1); // Phase.REVEAL
    });

    it("reverts if auction is still open", async function () {
      const { vault } = await deployVaultFixture();
      await expect(vault.triggerRevealPhase()).to.be.revertedWith("Auction still open");
    });
  });

  // ── Reveal Phase ──────────────────────────────────────────────────────────

  describe("revealBid", function () {
    it("supplier can reveal a valid bid", async function () {
      const { vault, vaultAddress, supplier1, depositRequired, closeTime, chainId } = await deployVaultFixture();

      const price = ethers.parseEther("1.5");
      const saltStr = "supersecret";
      const salt = ethers.encodeBytes32String(saltStr).slice(0, 66) as `0x${string}`;
      const commitHash = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32", "address"],
        [price, salt, supplier1.address],
      );

      // Commit
      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);
      await vault.connect(supplier1).commitBid(commitHash, "ipfs://QmTest", { value: depositRequired });

      // Advance to reveal phase
      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();

      // Reveal
      await expect(vault.connect(supplier1).revealBid(price, salt))
        .to.emit(vault, "BidRevealed")
        .withArgs(supplier1.address, price);

      const bid = await vault.bids(supplier1.address);
      expect(bid.revealed).to.be.true;
      expect(bid.revealedPrice).to.equal(price);
    });

    it("reverts with wrong price or salt", async function () {
      const { vault, vaultAddress, supplier1, depositRequired, closeTime, chainId } = await deployVaultFixture();

      const price = ethers.parseEther("1.5");
      const salt = ethers.encodeBytes32String("real-salt").slice(0, 66) as `0x${string}`;
      const commitHash = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32", "address"],
        [price, salt, supplier1.address],
      );

      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);
      await vault.connect(supplier1).commitBid(commitHash, "ipfs://QmTest", { value: depositRequired });

      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();

      const wrongSalt = ethers.encodeBytes32String("wrong-salt").slice(0, 66) as `0x${string}`;
      await expect(vault.connect(supplier1).revealBid(price, wrongSalt)).to.be.revertedWith(
        "Hash mismatch: invalid reveal",
      );
    });

    it("reverts if tried in OPEN phase", async function () {
      const { vault, supplier1 } = await deployVaultFixture();
      const salt = ethers.encodeBytes32String("s").slice(0, 66) as `0x${string}`;
      await expect(vault.connect(supplier1).revealBid(1n, salt)).to.be.revertedWith("Not in REVEAL phase");
    });
  });

  // ── Settlement ────────────────────────────────────────────────────────────

  describe("settle", function () {
    /** Helper: run a full 2-bidder auction up to settle(), returns winner */
    async function fullAuctionToSettle() {
      const fix = await deployVaultFixture();
      const { vault, vaultAddress, supplier1, supplier2, buyer, depositRequired, closeTime, chainId } = fix;

      const price1 = ethers.parseEther("1.0"); // supplier1 bids lower → should win
      const price2 = ethers.parseEther("1.8");
      const salt1 = ethers.encodeBytes32String("salt1").slice(0, 66) as `0x${string}`;
      const salt2 = ethers.encodeBytes32String("salt2").slice(0, 66) as `0x${string}`;

      const hash1 = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32", "address"],
        [price1, salt1, supplier1.address],
      );
      const hash2 = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32", "address"],
        [price2, salt2, supplier2.address],
      );

      // Commit both
      for (const [supplier, hash] of [
        [supplier1, hash1],
        [supplier2, hash2],
      ] as const) {
        const ts = await time.latest();
        const sig = await signConflictAttestation(supplier, vaultAddress, ts, chainId);
        await vault.connect(supplier).submitConflictAttestation(ts, sig);
        await vault.connect(supplier).commitBid(hash, "ipfs://Qm", { value: depositRequired });
      }

      // Reveal phase
      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();

      await vault.connect(supplier1).revealBid(price1, salt1);
      await vault.connect(supplier2).revealBid(price2, salt2);

      // Settle (after revealDeadline)
      const revealDeadline = await vault.revealDeadline();
      await time.increaseTo(Number(revealDeadline) + 1);

      await expect(vault.connect(buyer).settle()).to.emit(vault, "WinnerSelected");
      return { ...fix, price1, price2 };
    }

    it("selects the lowest-price bidder as winner", async function () {
      const { vault, supplier1, price1 } = await fullAuctionToSettle();
      expect(await vault.winner()).to.equal(supplier1.address);
      expect(await vault.winningPrice()).to.equal(price1);
    });

    it("tracks second bidder for fallback", async function () {
      const { vault, supplier2, price2 } = await fullAuctionToSettle();
      expect(await vault.secondBidder()).to.equal(supplier2.address);
      expect(await vault.secondBidAmount()).to.equal(price2);
    });

    it("returns deposits to all non-winners", async function () {
      const { vault, supplier2 } = await fullAuctionToSettle();
      const bid = await vault.bids(supplier2.address);
      expect(bid.depositReturned).to.be.true;
      // winner deposit is held
    });

    it("reverts if called before reveal deadline", async function () {
      const fix = await deployVaultFixture();
      const { vault, vaultAddress, supplier1, depositRequired, closeTime, chainId, buyer } = fix;

      const price = ethers.parseEther("1");
      const salt = ethers.encodeBytes32String("s").slice(0, 66) as `0x${string}`;
      const hash = ethers.solidityPackedKeccak256(["uint256", "bytes32", "address"], [price, salt, supplier1.address]);

      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);
      await vault.connect(supplier1).commitBid(hash, "ipfs://Qm", { value: depositRequired });

      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();
      await vault.connect(supplier1).revealBid(price, salt);

      // Settle immediately — reveal window not yet expired
      await expect(vault.connect(buyer).settle()).to.be.revertedWith("Reveal window not closed");
    });

    it("reverts if called by non-buyer", async function () {
      const fix = await deployVaultFixture();
      const { vault, vaultAddress, supplier1, depositRequired, closeTime, chainId, stranger } = fix;

      const price = ethers.parseEther("1");
      const salt = ethers.encodeBytes32String("s").slice(0, 66) as `0x${string}`;
      const hash = ethers.solidityPackedKeccak256(["uint256", "bytes32", "address"], [price, salt, supplier1.address]);

      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);
      await vault.connect(supplier1).commitBid(hash, "ipfs://Qm", { value: depositRequired });

      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();
      await vault.connect(supplier1).revealBid(price, salt);

      const revealDeadline = await vault.revealDeadline();
      await time.increaseTo(Number(revealDeadline) + 1);

      await expect(vault.connect(stranger).settle()).to.be.revertedWith("Not the auction creator");
    });
  });

  // ── Liveness fixes (v2) ───────────────────────────────────────────────────

  describe("settle — liveness", function () {
    /** supplier1 commits a bid; moves to the REVEAL phase without revealing */
    async function commitThenClose() {
      const fix = await deployVaultFixture();
      const { vault, vaultAddress, supplier1, depositRequired, closeTime, chainId } = fix;
      const price = ethers.parseEther("1");
      const salt = ethers.encodeBytes32String("s").slice(0, 66) as `0x${string}`;
      const hash = ethers.solidityPackedKeccak256(["uint256", "bytes32", "address"], [price, salt, supplier1.address]);
      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);
      await vault.connect(supplier1).commitBid(hash, "ipfs://Qm", { value: depositRequired });
      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();
      return { ...fix, price, salt };
    }

    it("lets anyone settle once the grace period has passed", async function () {
      const { vault, supplier1, stranger, price, salt } = await commitThenClose();
      await vault.connect(supplier1).revealBid(price, salt);
      const deadline = Number(await vault.revealDeadline());
      const grace = Number(await vault.SETTLE_GRACE_PERIOD());

      await time.increaseTo(deadline + 1);
      await expect(vault.connect(stranger).settle()).to.be.revertedWith("Not the auction creator");

      await time.increaseTo(deadline + grace + 1);
      await expect(vault.connect(stranger).settle()).to.emit(vault, "WinnerSelected");
      expect(await vault.winner()).to.equal(supplier1.address);
    });

    it("closes the auction when nobody revealed instead of locking funds", async function () {
      const { vault, vaultAddress, buyer, depositRequired, bond } = await commitThenClose();
      await time.increaseTo(Number(await vault.revealDeadline()) + 1);

      // Non-revealer's deposit is slashed to the creator and the creator's bond comes back
      await expect(vault.connect(buyer).settle()).to.changeEtherBalances(
        [buyer, vaultAddress],
        [depositRequired + bond, -(depositRequired + bond)],
      );
      expect(await vault.phase()).to.equal(3); // CANCELLED
      expect(await vault.creatorBond()).to.equal(0);
    });

    it("closes an auction that received no bids", async function () {
      const { vault, buyer, closeTime, bond, vaultAddress } = await deployVaultFixture();
      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();
      await time.increaseTo(Number(await vault.revealDeadline()) + 1);
      await expect(vault.connect(buyer).settle()).to.changeEtherBalances([buyer, vaultAddress], [bond, -bond]);
      expect(await vault.phase()).to.equal(3); // CANCELLED
    });
  });

  describe("revokeInstitution", function () {
    it("also removes BUYER_ROLE", async function () {
      const { factory, admin, buyer } = await deployVaultFixture();
      const BUYER_ROLE = await factory.BUYER_ROLE();
      expect(await factory.hasRole(BUYER_ROLE, buyer.address)).to.be.true;
      await factory.connect(admin).revokeInstitution(buyer.address);
      expect(await factory.hasRole(BUYER_ROLE, buyer.address)).to.be.false;
    });
  });

  // ── Payment & Delivery ────────────────────────────────────────────────────

  describe("submitPayment + confirmDelivery", function () {
    it("winner can submit payment and oracle confirms delivery", async function () {
      const fix = await deployVaultFixture();
      const { vault, vaultAddress, supplier1, buyer, oracle, depositRequired, closeTime, chainId, mockToken } = fix;

      const price = ethers.parseEther("1");
      const salt = ethers.encodeBytes32String("s").slice(0, 66) as `0x${string}`;
      const hash = ethers.solidityPackedKeccak256(["uint256", "bytes32", "address"], [price, salt, supplier1.address]);

      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);
      await vault.connect(supplier1).commitBid(hash, "ipfs://Qm", { value: depositRequired });

      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();
      await vault.connect(supplier1).revealBid(price, salt);

      const revealDeadline = await vault.revealDeadline();
      await time.increaseTo(Number(revealDeadline) + 1);
      await vault.connect(buyer).settle();

      // Approve DDSC settlement token before submitting payment
      const vaultAddr = await vault.getAddress();
      await mockToken.connect(supplier1).approve(vaultAddr, price);

      // Submit payment (ERC-20 — no msg.value)
      await expect(vault.connect(supplier1).submitPayment())
        .to.emit(vault, "PaymentSubmitted")
        .withArgs(supplier1.address, price);

      // Oracle confirms
      await expect(vault.connect(oracle).confirmDelivery()).to.emit(vault, "DeliveryConfirmed");

      expect(await vault.delivered()).to.be.true;
    });

    it("non-winner cannot submit payment", async function () {
      const fix = await deployVaultFixture();
      const { vault, vaultAddress, supplier1, supplier2, buyer, depositRequired, closeTime, chainId } = fix;

      const price1 = ethers.parseEther("1");
      const price2 = ethers.parseEther("2");
      const salt1 = ethers.encodeBytes32String("s1").slice(0, 66) as `0x${string}`;
      const salt2 = ethers.encodeBytes32String("s2").slice(0, 66) as `0x${string}`;
      const hash1 = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32", "address"],
        [price1, salt1, supplier1.address],
      );
      const hash2 = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32", "address"],
        [price2, salt2, supplier2.address],
      );

      for (const [s, h] of [
        [supplier1, hash1],
        [supplier2, hash2],
      ] as const) {
        const ts2 = await time.latest();
        const sig2 = await signConflictAttestation(s, vaultAddress, ts2, chainId);
        await vault.connect(s).submitConflictAttestation(ts2, sig2);
        await vault.connect(s).commitBid(h, "ipfs://Qm", { value: depositRequired });
      }

      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();
      await vault.connect(supplier1).revealBid(price1, salt1);
      await vault.connect(supplier2).revealBid(price2, salt2);
      const revealDeadline = await vault.revealDeadline();
      await time.increaseTo(Number(revealDeadline) + 1);
      await vault.connect(buyer).settle();

      await expect(vault.connect(supplier2).submitPayment()).to.be.revertedWith("Not the winner");
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────────

  describe("cancel", function () {
    it("buyer can cancel and all deposits are refunded", async function () {
      const { vault, vaultAddress, supplier1, supplier2, buyer, depositRequired, chainId } = await deployVaultFixture();

      // Commit from both suppliers
      for (const s of [supplier1, supplier2]) {
        const ts = await time.latest();
        const sig = await signConflictAttestation(s, vaultAddress, ts, chainId);
        await vault.connect(s).submitConflictAttestation(ts, sig);
        const hash = ethers.keccak256(ethers.toUtf8Bytes(s.address));
        await vault.connect(s).commitBid(hash, "ipfs://Qm", { value: depositRequired });
      }

      const balBefore1 = await ethers.provider.getBalance(supplier1.address);
      const balBefore2 = await ethers.provider.getBalance(supplier2.address);

      const cancelTx = await vault.connect(buyer).cancel();
      await cancelTx.wait();

      await expect(Promise.resolve(cancelTx)).to.emit(vault, "AuctionCancelled");
      expect(await vault.phase()).to.equal(3); // Phase.CANCELLED

      // Deposits returned (account for gas)
      const balAfter1 = await ethers.provider.getBalance(supplier1.address);
      const balAfter2 = await ethers.provider.getBalance(supplier2.address);
      expect(balAfter1).to.be.greaterThan(balBefore1);
      expect(balAfter2).to.be.greaterThan(balBefore2);
    });

    it("non-buyer cannot cancel", async function () {
      const { vault, stranger } = await deployVaultFixture();
      await expect(vault.connect(stranger).cancel()).to.be.revertedWith("Not the auction creator");
    });

    it("cannot cancel after reveal phase starts", async function () {
      const { vault, buyer, closeTime } = await deployVaultFixture();
      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();
      await expect(vault.connect(buyer).cancel()).to.be.revertedWith("Can only cancel in OPEN phase");
    });
  });

  // ── Slash / Bond ──────────────────────────────────────────────────────────

  describe("slashCreatorBond", function () {
    it("platformAdmin can slash the creator bond", async function () {
      const { vault, buyer, admin } = await deployVaultFixture();
      // platformAdmin == buyer in this fixture (passed as _platformAdmin in createVault)
      await expect(vault.connect(buyer).slashCreatorBond(admin.address)).to.emit(vault, "CreatorBondSlashed");
      expect(await vault.bondSlashed()).to.be.true;
    });

    it("stranger cannot slash the bond", async function () {
      const { vault, stranger } = await deployVaultFixture();
      await expect(vault.connect(stranger).slashCreatorBond(stranger.address)).to.be.revertedWith(
        "Not authorized to slash bond",
      );
    });
  });

  // ── Admin / Pause ─────────────────────────────────────────────────────────

  describe("pause / unpause", function () {
    it("admin can pause and unpause", async function () {
      const { vault, buyer } = await deployVaultFixture();
      await vault.connect(buyer).pause();
      expect(await vault.paused()).to.be.true;
      await vault.connect(buyer).unpause();
      expect(await vault.paused()).to.be.false;
    });

    it("commitBid reverts when paused", async function () {
      const { vault, vaultAddress, buyer, supplier1, depositRequired, chainId } = await deployVaultFixture();
      await vault.connect(buyer).pause();

      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);

      const hash = ethers.keccak256(ethers.toUtf8Bytes("h"));
      await expect(
        vault.connect(supplier1).commitBid(hash, "ipfs://Qm", { value: depositRequired }),
      ).to.be.revertedWith("Contract paused");
    });
  });

  // ── View Helpers ──────────────────────────────────────────────────────────

  describe("view helpers", function () {
    it("getBidCount returns correct count after commits", async function () {
      const { vault, vaultAddress, supplier1, supplier2, depositRequired, chainId } = await deployVaultFixture();

      for (const s of [supplier1, supplier2]) {
        const ts = await time.latest();
        const sig = await signConflictAttestation(s, vaultAddress, ts, chainId);
        await vault.connect(s).submitConflictAttestation(ts, sig);
        const hash = ethers.keccak256(ethers.toUtf8Bytes(s.address));
        await vault.connect(s).commitBid(hash, "ipfs://Qm", { value: depositRequired });
      }

      expect(await vault.getBidCount()).to.equal(2);
    });

    it("getAuditData returns correct data after reveals", async function () {
      const { vault, vaultAddress, supplier1, depositRequired, closeTime, chainId } = await deployVaultFixture();

      const price = ethers.parseEther("1");
      const salt = ethers.encodeBytes32String("s").slice(0, 66) as `0x${string}`;
      const hash = ethers.solidityPackedKeccak256(["uint256", "bytes32", "address"], [price, salt, supplier1.address]);

      const ts = await time.latest();
      const sig = await signConflictAttestation(supplier1, vaultAddress, ts, chainId);
      await vault.connect(supplier1).submitConflictAttestation(ts, sig);
      await vault.connect(supplier1).commitBid(hash, "ipfs://QmAudit", { value: depositRequired });

      await time.increaseTo(closeTime + 1);
      await vault.triggerRevealPhase();
      await vault.connect(supplier1).revealBid(price, salt);

      const [suppliers, hashes, storageRoots, prices, revealed] = await vault.getAuditData();
      expect(suppliers[0]).to.equal(supplier1.address);
      expect(hashes[0]).to.equal(hash);
      expect(storageRoots[0]).to.equal("ipfs://QmAudit");
      expect(prices[0]).to.equal(price);
      expect(revealed[0]).to.be.true;
    });
  });
});
