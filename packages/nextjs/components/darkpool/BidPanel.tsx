"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import { encodePacked, keccak256, parseEther, toHex } from "viem";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSignTypedData,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { CompetitivenessWidget } from "~~/components/ai/CompetitivenessWidget";
import { Countdown } from "~~/components/darkpool/Countdown";
import { useMarketHistoricalData } from "~~/hooks/useMarketHistoricalData";
import { FACTORY_ABI, VAULT_ABI } from "~~/lib/contracts";
import { FACTORY_ADDRESS, ZERO_ADDRESS } from "~~/lib/darkpool-config";
import { VaultPhase } from "~~/lib/types";
import { formatWei } from "~~/lib/utils";

interface BidPanelProps {
  vaultAddress: `0x${string}`;
  phase: VaultPhase;
  closeTime: bigint;
  revealDeadline: bigint;
  depositRequired: bigint;
  bidCount: bigint;
  buyer: `0x${string}`;
  requiresAccreditation: boolean;
  onBidSuccess?: () => void;
}

// MUST match the EIP-712 domain name in ShadowBidVault constructor: EIP712("DarkPool", "1")
const EIP712_DOMAIN_NAME = "DarkPool";

// MUST match the exact bytes hashed inside ShadowBidVault.submitConflictAttestation()
// keccak256(bytes("I confirm I am not affiliated with the auction creator and have no conflict of interest."))
const CONFLICT_STATEMENT = "I confirm I am not affiliated with the auction creator and have no conflict of interest.";

function randomBytes32(): `0x${string}` {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return toHex(arr) as `0x${string}`;
}

// ─── Local bid data persistence ────────────────────────────────────────────────
type StoredBidData = { priceEth: string; salt: string; updatedAt: number };

function bidStorageKey(vault: string, user: string): string {
  return `darkpool:bid:${vault.toLowerCase()}:${user.toLowerCase()}`;
}

function saveBidData(vault: string, user: string, data: StoredBidData) {
  try {
    localStorage.setItem(bidStorageKey(vault, user), JSON.stringify(data));
  } catch {
    /* noop */
  }
}

function loadBidData(vault: string, user: string): StoredBidData | null {
  try {
    const raw = localStorage.getItem(bidStorageKey(vault, user));
    return raw ? (JSON.parse(raw) as StoredBidData) : null;
  } catch {
    return null;
  }
}

export function BidPanel({
  vaultAddress,
  phase,
  closeTime,
  revealDeadline,
  depositRequired,
  bidCount,
  buyer,
  requiresAccreditation,
  onBidSuccess,
}: BidPanelProps) {
  const { address: userAddress, isConnected } = useAccount();
  const chainId = useChainId();

  // ─── Contract reads ──────────────────────────────────────────────────────────
  const { data: isVerified } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "verified",
    args: [userAddress ?? ZERO_ADDRESS],
    query: { enabled: !!userAddress },
  });

  const { data: isAccredited } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "isAccredited",
    args: [userAddress ?? ZERO_ADDRESS],
    query: { enabled: !!userAddress && requiresAccreditation },
  });

  const { data: hasAttestation, refetch: refetchAttestation } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "conflictAttestationSubmitted",
    args: [userAddress ?? ZERO_ADDRESS],
    query: { enabled: !!userAddress },
  });

  const { data: userBid, refetch: refetchUserBid } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "bids",
    args: [userAddress ?? ZERO_ADDRESS],
    query: { enabled: !!userAddress },
  });

  // ─── Local state ─────────────────────────────────────────────────────────────
  const [priceEth, setPriceEth] = useState("");
  const [storageRoot, setStorageRoot] = useState("");
  const [salt, setSalt] = useState<`0x${string}`>(() => randomBytes32());
  const [revealPrice, setRevealPrice] = useState("");
  const [revealSalt, setRevealSalt] = useState("");
  const [showAttestModal, setShowAttestModal] = useState(false);
  const [isModifying, setIsModifying] = useState(false);
  const [savedBidData, setSavedBidData] = useState<StoredBidData | null>(null);

  // Load saved bid data from localStorage on mount / when user changes
  useEffect(() => {
    if (userAddress && vaultAddress) {
      setSavedBidData(loadBidData(vaultAddress, userAddress));
    }
  }, [userAddress, vaultAddress]);

  // Market data for AI competitiveness analysis
  const { marketData, isLoading: loadingMarket } = useMarketHistoricalData();

  // ─── Derived ─────────────────────────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  const secsToClose = Math.max(0, Number(closeTime) - nowSec);
  const secsToRevealEnd = Math.max(0, Number(revealDeadline) - nowSec);
  const isOpen = phase === VaultPhase.OPEN && secsToClose > 0;
  const isReveal = phase === VaultPhase.REVEAL && secsToRevealEnd > 0;

  const userHasCommitted =
    userBid && userBid[0] !== "0x0000000000000000000000000000000000000000000000000000000000000000";
  const userHasRevealed = userBid && userBid[3] === true;
  const isBuyer = userAddress?.toLowerCase() === buyer.toLowerCase();

  // Compliance gates
  const kybBlocked = isConnected && !isVerified;
  const accreditBlocked = isConnected && requiresAccreditation && !isAccredited;
  const attestBlocked = isConnected && !!isVerified && !kybBlocked && !hasAttestation && (isOpen || isReveal);
  const canBid = isConnected && !!isVerified && !accreditBlocked && !!hasAttestation;

  // ─── Wagmi hooks ─────────────────────────────────────────────────────────────
  const { signTypedDataAsync, isPending: isSignPending } = useSignTypedData();
  const { writeContractAsync: doAttest, isPending: isAttestPending } = useWriteContract();
  const [attestTxHash, setAttestTxHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: isAttestSuccess } = useWaitForTransactionReceipt({ hash: attestTxHash });
  if (isAttestSuccess) void refetchAttestation();

  const { writeContractAsync: doCommit, isPending: isCommitPending } = useWriteContract();
  const [commitTxHash, setCommitTxHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: isCommitSuccess } = useWaitForTransactionReceipt({ hash: commitTxHash });

  const { writeContractAsync: doReveal, isPending: isRevealPending } = useWriteContract();
  const [revealTxHash, setRevealTxHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: isRevealSuccess } = useWaitForTransactionReceipt({ hash: revealTxHash });

  const { writeContractAsync: doUpdate, isPending: isUpdatePending } = useWriteContract();
  const [updateTxHash, setUpdateTxHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: isUpdateSuccess } = useWaitForTransactionReceipt({ hash: updateTxHash });

  // Refetch on-chain data after any successful bid action
  useEffect(() => {
    if (isCommitSuccess || isUpdateSuccess || isRevealSuccess) {
      void refetchUserBid();
      onBidSuccess?.();
    }
  }, [isCommitSuccess, isUpdateSuccess, isRevealSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Handlers ────────────────────────────────────────────────────────────────
  async function handleSignAndAttest() {
    if (!userAddress) return;
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    try {
      const sig = await signTypedDataAsync({
        domain: {
          name: EIP712_DOMAIN_NAME,
          version: "1",
          chainId,
          verifyingContract: vaultAddress,
        },
        types: {
          ConflictAttestation: [
            { name: "bidder", type: "address" },
            { name: "vault", type: "address" },
            { name: "statement", type: "string" },
            { name: "timestamp", type: "uint256" },
          ],
        },
        primaryType: "ConflictAttestation",
        message: {
          bidder: userAddress,
          vault: vaultAddress,
          statement: CONFLICT_STATEMENT,
          timestamp,
        },
      });
      const txHash = await doAttest({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "submitConflictAttestation",
        args: [timestamp, sig as `0x${string}`],
      });
      setAttestTxHash(txHash);
      setShowAttestModal(false);
      toast.success("Attestation submitted on-chain.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message.slice(0, 80) : "Sign failed");
    }
  }

  // Must match ShadowBidVault.revealBid: keccak256(abi.encodePacked(price, salt, msg.sender))
  function computeCommitHash(price: bigint, s: `0x${string}`, sender: `0x${string}`): `0x${string}` {
    return keccak256(encodePacked(["uint256", "bytes32", "address"], [price, s, sender]));
  }

  async function handleCommit() {
    if (!isConnected || !userAddress) return toast.error("Connect wallet");
    const priceWei = parseEther(priceEth || "0");
    if (priceWei <= 0n) return toast.error("Enter valid price");
    if (!storageRoot) return toast.error("Enter storage root hash");
    const hash = computeCommitHash(priceWei, salt, userAddress as `0x${string}`);
    try {
      const txHash = await doCommit({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "commitBid",
        args: [hash, storageRoot], // storageRoot is string calldata in the contract
        value: depositRequired,
      });
      setCommitTxHash(txHash);
      // Save bid price & salt locally so the user can see them later
      const bidData: StoredBidData = { priceEth, salt, updatedAt: Date.now() };
      saveBidData(vaultAddress, userAddress, bidData);
      setSavedBidData(bidData);
      toast.success("Bid committed. Save your salt.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message.slice(0, 80) : "Failed");
    }
  }

  async function handleUpdateBid() {
    if (!isConnected || !userAddress) return toast.error("Connect wallet");
    const priceWei = parseEther(priceEth || "0");
    if (priceWei <= 0n) return toast.error("Enter valid price");
    if (!storageRoot) return toast.error("Enter storage root hash");
    const hash = computeCommitHash(priceWei, salt, userAddress as `0x${string}`);
    try {
      const txHash = await doUpdate({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "updateBid",
        args: [hash, storageRoot],
      });
      setUpdateTxHash(txHash);
      setIsModifying(false);
      // Update locally saved bid data
      const bidData: StoredBidData = { priceEth, salt, updatedAt: Date.now() };
      saveBidData(vaultAddress, userAddress, bidData);
      setSavedBidData(bidData);
      toast.success("Bid updated. Save your new salt.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message.slice(0, 80) : "Failed");
    }
  }

  async function handleReveal() {
    if (!isConnected || !userAddress) return toast.error("Connect wallet");
    const priceWei = parseEther(revealPrice || "0");
    if (priceWei <= 0n) return toast.error("Enter committed price");
    if (!revealSalt || revealSalt.length !== 66) return toast.error("Enter 32-byte salt (0x...)");
    try {
      const txHash = await doReveal({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "revealBid",
        args: [priceWei, revealSalt as `0x${string}`],
      });
      setRevealTxHash(txHash);
      toast.success("Bid revealed.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message.slice(0, 80) : "Failed");
    }
  }

  // ─── Styles ──────────────────────────────────────────────────────────────────
  const inputClass =
    "w-full px-4 py-3 bg-black border border-white/50 font-mono text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-white transition-all duration-100";

  return (
    <>
      {/* ── Conflict Attestation Modal ────────────────────────────────────── */}
      {showAttestModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6">
          <div className="border border-white max-w-lg w-full bg-black">
            <div className="border-b border-white px-6 py-4 flex items-center justify-between">
              <span className="font-mono text-xs font-bold tracking-[0.1em] uppercase">CONFLICT ATTESTATION</span>
              <button
                onClick={() => setShowAttestModal(false)}
                className="font-mono text-[10px] uppercase opacity-100 hover:opacity-100"
              >
                [CLOSE]
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed">
                REGULATORY REQUIREMENT — YOU MUST ATTEST NO CONFLICT OF INTEREST BEFORE BIDDING
              </p>
              <div className="border border-white/20 p-4 bg-white/5">
                <p className="font-mono text-[11px] leading-relaxed text-white italic">
                  &ldquo;{CONFLICT_STATEMENT}&rdquo;
                </p>
              </div>
              <p className="font-mono text-[10px] uppercase opacity-100">
                SIGNING THIS CREATES A CRYPTOGRAPHIC RECORD ON-CHAIN. THIS ATTESTATION IS LEGALLY BINDING.
              </p>
              <button
                onClick={handleSignAndAttest}
                disabled={isSignPending || isAttestPending}
                className="w-full py-3 border border-white bg-white text-black font-mono text-xs tracking-[0.15em] uppercase font-bold hover:opacity-80 disabled:opacity-20"
              >
                {isSignPending ? "SIGNING..." : isAttestPending ? "SUBMITTING..." : "SIGN & SUBMIT ATTESTATION"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Main Panel ────────────────────────────────────────────────────── */}
      <div className="border border-white">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white">
          <span className="font-mono text-xs font-bold tracking-[0.1em] uppercase">
            {isOpen ? "SUBMIT BID" : isReveal ? "REVEAL BID" : "CLOSED"}
          </span>
          <span className="font-mono text-[10px] tracking-[0.1em] uppercase opacity-100">
            {isOpen ? (
              <Countdown closeTimestamp={Number(closeTime)} />
            ) : isReveal ? (
              <Countdown closeTimestamp={Number(revealDeadline)} />
            ) : (
              "—"
            )}
          </span>
        </div>

        <div className="p-6 space-y-4">
          {/* Stats */}
          <div className="flex border border-white">
            <div className={`flex-1 p-4${isBuyer ? " border-r border-white" : ""}`}>
              <p className="font-mono text-[9px] tracking-[0.2em] uppercase opacity-100 mb-1">DEPOSIT</p>
              <p className="font-mono text-sm font-bold">{formatWei(depositRequired)}</p>
            </div>
            {isBuyer && (
              <div className="flex-1 p-4">
                <p className="font-mono text-[9px] tracking-[0.2em] uppercase opacity-100 mb-1">BIDS</p>
                <p className="font-mono text-sm font-bold">{Number(bidCount)}</p>
              </div>
            )}
          </div>

          {/* User's own bid details */}
          {isConnected && (userHasCommitted || savedBidData !== null) && !isBuyer && (
            <div className="border border-green-400/30">
              {/* Header */}
              <div className="flex items-center justify-between px-4 pt-4 pb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase text-green-400">● YOUR BID</span>
                  <span
                    className={`font-mono text-[9px] uppercase px-1.5 py-0.5 border ${
                      userHasRevealed ? "border-blue-400/40 text-blue-400" : "border-green-400/40 text-green-400/80"
                    }`}
                  >
                    {userHasRevealed ? "REVEALED" : "COMMITTED"}
                  </span>
                </div>
                {isOpen && !userHasRevealed && !isModifying && (
                  <button
                    onClick={() => {
                      setIsModifying(true);
                      setSalt(randomBytes32());
                      setPriceEth("");
                      setStorageRoot("");
                    }}
                    className="font-mono text-[9px] uppercase border border-white/40 px-2 py-1 hover:opacity-60 transition-all"
                  >
                    MODIFY BID
                  </button>
                )}
              </div>

              {/* Full bid details */}
              {userBid && (
                <div className="divide-y divide-white/10">
                  {/* Bid Price — from localStorage (pre-reveal) or on-chain (post-reveal) */}
                  <div className="px-4 py-2.5">
                    <p className="font-mono text-[9px] tracking-[0.15em] uppercase opacity-50 mb-1">BID PRICE</p>
                    {userHasRevealed ? (
                      <p className="font-mono text-sm font-bold text-white">
                        {formatWei(userBid[2] as bigint, "DDSC")}
                      </p>
                    ) : savedBidData?.priceEth ? (
                      <div>
                        <p className="font-mono text-sm font-bold text-white">{savedBidData.priceEth} DDSC</p>
                        <p className="font-mono text-[9px] opacity-40 mt-0.5">
                          STORED LOCALLY — HIDDEN ON-CHAIN UNTIL REVEAL
                        </p>
                      </div>
                    ) : (
                      <p className="font-mono text-[10px] opacity-40 italic">SEALED — REVEAL TO DISPLAY</p>
                    )}
                  </div>

                  {/* Salt — from localStorage (only pre-reveal) */}
                  {!userHasRevealed && savedBidData?.salt && (
                    <div className="px-4 py-2.5">
                      <p className="font-mono text-[9px] tracking-[0.15em] uppercase opacity-50 mb-1">YOUR SALT</p>
                      <p
                        className="font-mono text-[10px] text-white break-all cursor-pointer hover:opacity-70 transition-opacity"
                        onClick={() => {
                          navigator.clipboard.writeText(savedBidData.salt);
                          toast.success("Salt copied");
                        }}
                        title="Click to copy"
                      >
                        {savedBidData.salt}
                      </p>
                      <p className="font-mono text-[9px] opacity-40 mt-0.5">⚠ YOU NEED THIS TO REVEAL YOUR BID</p>
                    </div>
                  )}

                  {/* Commit Hash */}
                  <div className="px-4 py-2.5">
                    <p className="font-mono text-[9px] tracking-[0.15em] uppercase opacity-50 mb-1">COMMIT HASH</p>
                    <p
                      className="font-mono text-[10px] text-white break-all cursor-pointer hover:opacity-70 transition-opacity"
                      onClick={() => {
                        navigator.clipboard.writeText(userBid[0] as string);
                        toast.success("Commit hash copied");
                      }}
                      title="Click to copy"
                    >
                      {userBid[0] as string}
                    </p>
                  </div>

                  {/* Storage Root */}
                  <div className="px-4 py-2.5">
                    <p className="font-mono text-[9px] tracking-[0.15em] uppercase opacity-50 mb-1">STORAGE ROOT</p>
                    <p
                      className="font-mono text-[10px] text-white break-all cursor-pointer hover:opacity-70 transition-opacity"
                      onClick={() => {
                        navigator.clipboard.writeText(userBid[1] as string);
                        toast.success("Storage root copied");
                      }}
                      title="Click to copy"
                    >
                      {userBid[1] as string}
                    </p>
                  </div>

                  {/* Status row */}
                  <div className="px-4 py-2.5 flex items-center gap-4">
                    <div>
                      <p className="font-mono text-[9px] tracking-[0.15em] uppercase opacity-50 mb-1">DEPOSIT</p>
                      <span
                        className={`font-mono text-[10px] ${(userBid[4] as boolean) ? "text-green-400" : "opacity-60"}`}
                      >
                        {(userBid[4] as boolean) ? "PAID ✓" : "NOT PAID"}
                      </span>
                    </div>
                    <div>
                      <p className="font-mono text-[9px] tracking-[0.15em] uppercase opacity-50 mb-1">RETURNED</p>
                      <span
                        className={`font-mono text-[10px] ${(userBid[5] as boolean) ? "text-green-400" : "opacity-60"}`}
                      >
                        {(userBid[5] as boolean) ? "YES ✓" : "NO"}
                      </span>
                    </div>
                    <div>
                      <p className="font-mono text-[9px] tracking-[0.15em] uppercase opacity-50 mb-1">REVEALED</p>
                      <span className={`font-mono text-[10px] ${userHasRevealed ? "text-blue-400" : "opacity-60"}`}>
                        {userHasRevealed ? "YES ✓" : "NO"}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Not connected */}
          {!isConnected && (isOpen || isReveal) && (
            <p className="font-mono text-[11px] uppercase text-center opacity-100 py-4">
              CONNECT WALLET TO PARTICIPATE
            </p>
          )}

          {/* KYB Gate */}
          {isConnected && kybBlocked && (isOpen || isReveal) && (
            <div className="border border-yellow-400/50 p-4 space-y-3">
              <span className="font-mono text-[9px] uppercase text-yellow-400 border border-yellow-400 px-1.5 py-0.5">
                KYB REQUIRED
              </span>
              <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed mt-2">
                THIS AUCTION REQUIRES INSTITUTIONAL KYB VERIFICATION BEFORE BIDDING.
              </p>
              <Link
                href="/kyb"
                className="block text-center py-3 border border-yellow-400 text-yellow-400 font-mono text-xs tracking-[0.15em] uppercase hover:bg-yellow-400 hover:text-black transition-all duration-100"
              >
                COMPLETE KYB VERIFICATION →
              </Link>
            </div>
          )}

          {/* Accreditation Gate */}
          {isConnected && !kybBlocked && accreditBlocked && (isOpen || isReveal) && (
            <div className="border border-orange-400/50 p-4 space-y-2">
              <span className="font-mono text-[9px] uppercase text-orange-400 border border-orange-400 px-1.5 py-0.5">
                ACCREDITED INVESTOR ONLY
              </span>
              <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed mt-2">
                THIS VAULT REQUIRES VERIFIED ACCREDITATION STATUS. CONTACT YOUR COMPLIANCE OFFICER.
              </p>
            </div>
          )}

          {/* Conflict Attestation Gate */}
          {isConnected && attestBlocked && !accreditBlocked && (
            <div className="border border-white/30 p-4 space-y-3">
              <span className="font-mono text-[9px] uppercase opacity-100 border border-white/40 px-1.5 py-0.5">
                STEP REQUIRED
              </span>
              <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed mt-2">
                A SIGNED CONFLICT-OF-INTEREST ATTESTATION IS REQUIRED BEFORE BIDDING.
              </p>
              <button
                onClick={() => setShowAttestModal(true)}
                className="w-full py-3 border border-white font-mono text-xs tracking-[0.15em] uppercase hover:bg-white hover:text-black transition-all duration-100"
              >
                SIGN CONFLICT ATTESTATION
              </button>
            </div>
          )}

          {/* KYB verified badge */}
          {isConnected && !!isVerified && (
            <div className="flex items-center gap-2 px-1">
              <span className="font-mono text-[9px] uppercase text-green-400">● KYB VERIFIED</span>
              {!!isAccredited && <span className="font-mono text-[9px] uppercase text-green-400/60">· ACCREDITED</span>}
            </div>
          )}

          {/* COMMIT */}
          {isOpen && !userHasCommitted && !isCommitSuccess && !commitTxHash && canBid && (
            <div className="space-y-3">
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  BID PRICE (DDSC)
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={priceEth}
                  onChange={e => setPriceEth(e.target.value)}
                  placeholder="0.5"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  STORAGE ROOT
                </label>
                <input
                  type="text"
                  value={storageRoot}
                  onChange={e => setStorageRoot(e.target.value)}
                  placeholder="0x..."
                  className={inputClass}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100">SALT</label>
                  <button
                    onClick={() => setSalt(randomBytes32())}
                    className="font-mono text-[10px] uppercase opacity-100 hover:opacity-100 transition-opacity"
                  >
                    [REGEN]
                  </button>
                </div>
                <div
                  className="border border-white px-4 py-3 font-mono text-[10px] opacity-100 truncate cursor-pointer hover:opacity-100 transition-all duration-100"
                  onClick={() => {
                    navigator.clipboard.writeText(salt);
                    toast.success("Salt copied");
                  }}
                >
                  {salt}
                </div>
                <p className="font-mono text-[10px] uppercase opacity-100 mt-1">
                  ⚠ SAVE THIS SALT — YOU NEED IT TO REVEAL
                </p>
              </div>

              {/* AI Competitiveness Widget */}
              {marketData && (
                <CompetitivenessWidget
                  providerPrice={parseFloat(priceEth) || 0}
                  providerConditions={storageRoot}
                  auctionCategory="RWA"
                />
              )}
              {!marketData && loadingMarket && (
                <div className="border border-white/10 p-3">
                  <p className="font-mono text-[9px] uppercase opacity-100 animate-pulse">
                    LOADING MARKET DATA FOR AI ANALYSIS...
                  </p>
                </div>
              )}

              <button
                onClick={handleCommit}
                disabled={isCommitPending}
                className="w-full py-4 border border-white bg-white text-black font-mono text-xs tracking-[0.15em] uppercase font-bold hover:opacity-80 disabled:opacity-20 transition-all duration-100"
              >
                {isCommitPending ? "COMMITTING..." : `COMMIT BID · ${formatWei(depositRequired)}`}
              </button>
            </div>
          )}

          {/* MODIFY BID FORM */}
          {isOpen && userHasCommitted && isModifying && canBid && (
            <div className="space-y-3">
              <div className="border border-yellow-400/30 p-3">
                <p className="font-mono text-[10px] uppercase text-yellow-400">
                  ⚠ MODIFYING YOUR BID — ENTER NEW PRICE AND STORAGE ROOT
                </p>
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  NEW BID PRICE (DDSC)
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={priceEth}
                  onChange={e => setPriceEth(e.target.value)}
                  placeholder="0.5"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  NEW STORAGE ROOT
                </label>
                <input
                  type="text"
                  value={storageRoot}
                  onChange={e => setStorageRoot(e.target.value)}
                  placeholder="0x..."
                  className={inputClass}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100">NEW SALT</label>
                  <button
                    onClick={() => setSalt(randomBytes32())}
                    className="font-mono text-[10px] uppercase opacity-100 hover:opacity-100 transition-opacity"
                  >
                    [REGEN]
                  </button>
                </div>
                <div
                  className="border border-white px-4 py-3 font-mono text-[10px] opacity-100 truncate cursor-pointer hover:opacity-100 transition-all duration-100"
                  onClick={() => {
                    navigator.clipboard.writeText(salt);
                    toast.success("Salt copied");
                  }}
                >
                  {salt}
                </div>
                <p className="font-mono text-[10px] uppercase opacity-100 mt-1">
                  ⚠ SAVE THIS NEW SALT — YOU NEED IT TO REVEAL
                </p>
              </div>
              <div className="flex gap-0">
                <button
                  onClick={handleUpdateBid}
                  disabled={isUpdatePending}
                  className="flex-1 py-4 border border-white bg-white text-black font-mono text-xs tracking-[0.15em] uppercase font-bold hover:opacity-80 disabled:opacity-20 transition-all duration-100"
                >
                  {isUpdatePending ? "UPDATING..." : "UPDATE BID"}
                </button>
                <button
                  onClick={() => setIsModifying(false)}
                  className="px-6 py-4 border border-white border-l-0 font-mono text-xs tracking-[0.15em] uppercase hover:opacity-60 transition-all duration-100"
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}

          {/* TX CONFIRMING */}
          {commitTxHash && !isCommitSuccess && !userHasCommitted && (
            <div className="border border-white/40 p-5 text-center space-y-2">
              <p className="font-mono text-xs uppercase font-bold animate-pulse">CONFIRMING TRANSACTION...</p>
              <p className="font-mono text-[10px] uppercase opacity-50">WAITING FOR BLOCK INCLUSION</p>
              <a
                href={`https://explorer.ab.testnet.adifoundation.ai/tx/${commitTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[10px] text-white/60 hover:text-white underline block"
              >
                VIEW TX ↗
              </a>
            </div>
          )}

          {/* COMMITTED — waiting for reveal phase */}
          {(isCommitSuccess || isUpdateSuccess || (isOpen && userHasCommitted)) &&
            !isReveal &&
            !isModifying &&
            savedBidData === null && (
              <div className="border border-white p-6 text-center">
                <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] mb-1">BID COMMITTED</p>
                <p className="font-mono text-[10px] uppercase opacity-100">REVEAL AFTER AUCTION CLOSES</p>
              </div>
            )}

          {/* REVEAL */}
          {isReveal && userHasCommitted && !userHasRevealed && !isRevealSuccess && canBid && (
            <div className="space-y-3">
              <div className="border border-white p-4">
                <p className="font-mono text-[10px] uppercase opacity-100">
                  REVEAL PHASE OPEN — ENTER EXACT PRICE AND SALT
                </p>
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  COMMITTED PRICE (DDSC)
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={revealPrice}
                  onChange={e => setRevealPrice(e.target.value)}
                  placeholder="0.5"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  SALT (BYTES32)
                </label>
                <input
                  type="text"
                  value={revealSalt}
                  onChange={e => setRevealSalt(e.target.value as `0x${string}`)}
                  placeholder="0x..."
                  className={inputClass}
                />
              </div>
              <button
                onClick={handleReveal}
                disabled={isRevealPending}
                className="w-full py-4 border border-white bg-white text-black font-mono text-xs tracking-[0.15em] uppercase font-bold hover:opacity-80 disabled:opacity-20 transition-all duration-100"
              >
                {isRevealPending ? "REVEALING..." : "REVEAL BID"}
              </button>
            </div>
          )}

          {/* REVEALED */}
          {(isRevealSuccess || (isReveal && userHasRevealed)) && (
            <div className="border border-white p-6 text-center">
              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] mb-1">BID REVEALED</p>
              <p className="font-mono text-[10px] uppercase opacity-100">AWAITING SETTLEMENT</p>
            </div>
          )}

          {/* Closed / Settled / Cancelled */}
          {!isOpen && !isReveal && (
            <div className="py-4 text-center font-mono text-[11px] uppercase opacity-100">
              {phase === VaultPhase.SETTLED
                ? "AUCTION SETTLED — WINNER SELECTED"
                : phase === VaultPhase.CANCELLED
                  ? "AUCTION CANCELLED"
                  : "AUCTION CLOSED"}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
