"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAccount, useSignMessage } from "wagmi";
import { type KYBStatus, KYB_STATUS_COLOR, KYB_STATUS_LABEL } from "~~/lib/types";
import { type KybAction, buildKybMessage } from "~~/lib/wallet-auth";

type StepId = "connect" | "register" | "verify" | "status";

interface KybStatusResponse {
  kybStatus: KYBStatus;
  isAccredited: boolean;
  onChainVerified: boolean;
  legalName?: string;
  lastScreenedAt?: string;
  sanctionHit?: boolean;
}

export default function KybPage() {
  const { address: walletAddress, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [step, setStep] = useState<StepId>("connect");
  const [kybStatus, setKybStatus] = useState<KybStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Form state
  const [legalName, setLegalName] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [sdkToken, setSdkToken] = useState<string | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!walletAddress) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/kyb/status?wallet=${walletAddress}`);
      const data = (await res.json()) as KybStatusResponse;
      setKybStatus(data);
    } catch {
      setKybStatus({ kybStatus: "not_found", isAccredited: false, onChainVerified: false });
    } finally {
      setIsLoading(false);
    }
  }, [walletAddress]);

  // When wallet connects or address changes, reset status and re-fetch
  useEffect(() => {
    if (!isConnected || !walletAddress) {
      setStep("connect");
      setKybStatus(null);
      return;
    }
    // Address is now available — always fetch fresh status
    setKybStatus(null);
    fetchStatus();
  }, [isConnected, walletAddress, fetchStatus]);

  // Derive the step whenever kybStatus changes
  useEffect(() => {
    if (!isConnected || !walletAddress) return;
    if (!kybStatus) return;
    const s = kybStatus.kybStatus;
    if (s === "not_found") setStep("register");
    else if (s === "pending" || s === "under_review") setStep("verify");
    else setStep("status");
  }, [kybStatus, isConnected, walletAddress]);

  // Proves wallet ownership to the API (see lib/wallet-auth.ts)
  async function signKyb(action: KybAction, wallet: string) {
    const timestamp = Date.now();
    const signature = await signMessageAsync({ message: buildKybMessage(action, wallet, timestamp) });
    return { timestamp, signature };
  }

  async function handleSubmit() {
    if (!walletAddress) return;
    setIsLoading(true);
    setSubmitError(null);
    try {
      let auth: { timestamp: number; signature: string };
      try {
        auth = await signKyb("submit", walletAddress);
      } catch {
        setSubmitError("Signature rejected. Signing proves you own this wallet.");
        return;
      }
      const res = await fetch("/api/kyb/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, legalName, jurisdiction, contactEmail, ...auth }),
      });
      const data = (await res.json()) as { token?: string; demo?: boolean; error?: string };
      if (!res.ok || data.error) {
        setSubmitError(data.error ?? "Submission failed");
        return;
      }
      setSdkToken(data.token ?? null);
      setIsDemo(data.demo ?? false);
      setStep("verify");
    } catch {
      setSubmitError("Network error. Try again.");
    } finally {
      setIsLoading(false);
    }
  }

  const inputClass =
    "w-full px-4 py-3 bg-black border border-white/50 font-mono text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-white transition-all duration-100";

  const statusColor = kybStatus ? (KYB_STATUS_COLOR[kybStatus.kybStatus] ?? "text-white") : "text-white";
  const statusLabel = kybStatus ? (KYB_STATUS_LABEL[kybStatus.kybStatus] ?? kybStatus.kybStatus) : "";

  return (
    <div className="min-h-screen bg-black pt-14">
      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* Back link */}
        <div className="mb-8">
          <Link
            href="/auctions"
            className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 hover:opacity-100 transition-opacity"
          >
            ← BACK TO AUCTIONS
          </Link>
        </div>

        {/* Title */}
        <div className="mb-10 border-b border-white pb-6">
          <h1 className="font-mono text-xl font-bold tracking-[0.08em] uppercase mb-2">KYB VERIFICATION</h1>
          <p className="font-mono text-[11px] uppercase opacity-100 leading-relaxed">
            INSTITUTIONAL KNOW-YOUR-BUSINESS VERIFICATION REQUIRED TO PARTICIPATE IN SEALED-BID AUCTIONS.
          </p>
        </div>

        {/* Step: connect */}
        {step === "connect" && (
          <div className="border border-white p-8 text-center space-y-4">
            <p className="font-mono text-xs uppercase opacity-100">CONNECT YOUR WALLET TO BEGIN</p>
            <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed">
              KYB IS TIED TO YOUR WALLET ADDRESS. ENSURE YOU ARE USING THE WALLET YOU INTEND TO BID WITH.
            </p>
          </div>
        )}

        {/* Step: register */}
        {step === "register" && isConnected && (
          <div className="space-y-6">
            <div className="border border-white p-4">
              <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed">
                WALLET: <span className="opacity-100 text-white">{walletAddress}</span>
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  LEGAL ENTITY NAME *
                </label>
                <input
                  type="text"
                  value={legalName}
                  onChange={e => setLegalName(e.target.value)}
                  placeholder="Acme Capital Partners LLC"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  JURISDICTION (ISO-3166 CODE)
                </label>
                <input
                  type="text"
                  value={jurisdiction}
                  onChange={e => setJurisdiction(e.target.value.toUpperCase())}
                  placeholder="US / GB / DE / SG"
                  maxLength={2}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-[0.15em] uppercase opacity-100 block mb-2">
                  COMPLIANCE CONTACT EMAIL
                </label>
                <input
                  type="email"
                  value={contactEmail}
                  onChange={e => setContactEmail(e.target.value)}
                  placeholder="compliance@firm.com"
                  className={inputClass}
                />
              </div>
            </div>

            {submitError && (
              <div className="border border-red-400/50 p-3">
                <p className="font-mono text-[10px] text-red-400 uppercase">{submitError}</p>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={isLoading || !legalName}
              className="w-full py-4 border border-white bg-white text-black font-mono text-xs tracking-[0.15em] uppercase font-bold hover:opacity-80 disabled:opacity-20 transition-all duration-100"
            >
              {isLoading ? "SUBMITTING..." : "START KYB VERIFICATION"}
            </button>

            <p className="font-mono text-[10px] uppercase opacity-100 text-center leading-relaxed">
              YOU WILL COMPLETE DOCUMENT VERIFICATION VIA THE SUMSUB SDK. REVIEW TYPICALLY TAKES 1-3 BUSINESS DAYS.
            </p>
          </div>
        )}

        {/* Step: verify (Sumsub SDK) */}
        {step === "verify" && (
          <div className="space-y-6">
            {sdkToken ? (
              <>
                {isDemo ? (
                  <div className="border border-yellow-400/60 p-6 space-y-4">
                    <p className="font-mono text-[10px] uppercase text-yellow-400 font-bold">⚠ DEMO MODE</p>
                    <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed">
                      SUMSUB INTEGRATION IS ON THE ROADMAP. IN PRODUCTION, REAL DOCUMENT VERIFICATION RUNS HERE.
                    </p>
                    <button
                      onClick={async () => {
                        if (!walletAddress) return;
                        setIsLoading(true);
                        setSubmitError(null);
                        try {
                          const auth = await signKyb("demo-approve", walletAddress);
                          const res = await fetch(`/api/kyb/demo-approve?wallet=${walletAddress}`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(auth),
                          });
                          if (!res.ok) {
                            const data = (await res.json().catch(() => ({}))) as { error?: string };
                            setSubmitError(data.error ?? "Approval failed");
                          }
                          await fetchStatus();
                        } catch {
                          setSubmitError("Signature rejected. Signing proves you own this wallet.");
                        } finally {
                          setIsLoading(false);
                        }
                      }}
                      disabled={isLoading}
                      className="w-full py-3 border border-yellow-400 text-yellow-400 font-mono text-xs tracking-[0.15em] uppercase font-bold hover:bg-yellow-400 hover:text-black disabled:opacity-20 transition-all duration-100"
                    >
                      {isLoading ? "PROCESSING..." : "[ SIMULATE KYB APPROVAL ]"}
                    </button>
                    {submitError && <p className="font-mono text-[10px] text-red-400 uppercase">{submitError}</p>}
                  </div>
                ) : (
                  <>
                    <div className="border border-yellow-400/40 p-4">
                      <p className="font-mono text-[10px] uppercase text-yellow-400 mb-1">SUMSUB SDK TOKEN READY</p>
                      <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed">
                        IN PRODUCTION, THE SUMSUB WEBSDK IFRAME RENDERS HERE.
                        <br />
                        TOKEN: {sdkToken.slice(0, 20)}...
                      </p>
                    </div>
                    {/* In production, integrate @sumsub/websdk-react here:
                        <SumsubWebSdk accessToken={sdkToken} expirationHandler={...} config={...} /> */}
                    <div className="border border-white p-6 text-center space-y-3">
                      <p className="font-mono text-xs uppercase opacity-100">VERIFICATION IN PROGRESS</p>
                      <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed">
                        COMPLETE THE DOCUMENT UPLOAD FLOW IN THE SUMSUB WIDGET ABOVE. YOU WILL RECEIVE AN EMAIL WHEN
                        REVIEW IS COMPLETE.
                      </p>
                      <button
                        onClick={fetchStatus}
                        className="font-mono text-[10px] uppercase opacity-100 hover:opacity-100 underline"
                      >
                        [REFRESH STATUS]
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="border border-white p-6 text-center space-y-3">
                <p className="font-mono text-xs uppercase">REVIEW PENDING</p>
                <p className="font-mono text-[10px] uppercase opacity-100 leading-relaxed">
                  YOUR SUBMISSION IS UNDER REVIEW. THIS TYPICALLY TAKES 1-3 BUSINESS DAYS.
                </p>
                <button
                  onClick={fetchStatus}
                  disabled={isLoading}
                  className="font-mono text-[10px] uppercase opacity-100 hover:opacity-100 underline"
                >
                  {isLoading ? "CHECKING..." : "[REFRESH STATUS]"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step: status (final states) */}
        {step === "status" && kybStatus && (
          <div className="space-y-6">
            {/* Status badge */}
            <div className="border border-white p-6">
              <div className="flex items-center justify-between mb-4">
                <span className="font-mono text-[10px] uppercase opacity-100">KYB STATUS</span>
                <span className={`font-mono text-sm font-bold uppercase ${statusColor}`}>{statusLabel}</span>
              </div>

              <div className="space-y-2">
                {kybStatus.legalName && (
                  <div className="flex justify-between">
                    <span className="font-mono text-[10px] uppercase opacity-100">ENTITY</span>
                    <span className="font-mono text-[10px]">{kybStatus.legalName}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="font-mono text-[10px] uppercase opacity-100">ON-CHAIN</span>
                  <span
                    className={`font-mono text-[10px] uppercase ${kybStatus.onChainVerified ? "text-green-400" : "opacity-100"}`}
                  >
                    {kybStatus.onChainVerified ? "VERIFIED ✓" : "PENDING"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-mono text-[10px] uppercase opacity-100">ACCREDITED</span>
                  <span
                    className={`font-mono text-[10px] uppercase ${kybStatus.isAccredited ? "text-green-400" : "opacity-100"}`}
                  >
                    {kybStatus.isAccredited ? "YES" : "NO"}
                  </span>
                </div>
                {kybStatus.lastScreenedAt && (
                  <div className="flex justify-between">
                    <span className="font-mono text-[10px] uppercase opacity-100">LAST SCREENED</span>
                    <span className="font-mono text-[10px] opacity-100">
                      {new Date(kybStatus.lastScreenedAt).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Verified state */}
            {kybStatus.kybStatus === "verified" && (
              <div className="border border-green-400/40 p-4 text-center space-y-2">
                <p className="font-mono text-xs uppercase text-green-400">
                  ✓ VERIFIED — YOU MAY PARTICIPATE IN AUCTIONS
                </p>
                <Link
                  href="/auctions"
                  className="block font-mono text-[10px] uppercase opacity-100 hover:opacity-100 underline"
                >
                  VIEW AUCTIONS →
                </Link>
              </div>
            )}

            {/* Suspended / rejected state */}
            {(kybStatus.kybStatus === "suspended" || kybStatus.kybStatus === "rejected") && (
              <div className="border border-red-400/40 p-4 space-y-2">
                <p className="font-mono text-[10px] uppercase text-red-400">
                  {kybStatus.kybStatus === "suspended"
                    ? "YOUR ACCOUNT HAS BEEN SUSPENDED. CONTACT COMPLIANCE."
                    : "YOUR APPLICATION WAS REJECTED. CONTACT SUPPORT TO APPEAL."}
                </p>
                {kybStatus.sanctionHit && (
                  <p className="font-mono text-[10px] uppercase text-orange-400">⚠ SANCTIONS MATCH DETECTED</p>
                )}
              </div>
            )}

            <button
              onClick={fetchStatus}
              disabled={isLoading}
              className="w-full py-3 border border-white font-mono text-xs tracking-[0.15em] uppercase opacity-100 hover:opacity-100 disabled:opacity-20 transition-all"
            >
              {isLoading ? "REFRESHING..." : "[REFRESH STATUS]"}
            </button>
          </div>
        )}

        {/* Loading state */}
        {isLoading && !kybStatus && (
          <div className="text-center py-12">
            <p className="font-mono text-xs uppercase opacity-100">LOADING...</p>
          </div>
        )}
      </div>
    </div>
  );
}
