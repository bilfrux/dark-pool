/**
 * POST /api/kyb/demo-approve?wallet=0x...   Body: { timestamp, signature }
 * DEMO ONLY — instantly approves a KYB application and triggers on-chain credentialing.
 * Only available when SUMSUB_APP_TOKEN is not set (i.e. no real Sumsub integration).
 *
 * Every approval sends two transactions paid by the platform admin wallet, so it is guarded by:
 * a wallet signature (no approving addresses you don't own), idempotency (one approval per wallet),
 * and per-IP / global daily caps (bounds gas spending even with many freshly generated wallets).
 *
 * 📋 ROADMAP: Replace with real Sumsub webhook flow.
 */
import { NextRequest, NextResponse } from "next/server";
import { onChainVerifyInstitution } from "~~/lib/onchain-credentials";
import { prisma } from "~~/lib/prisma";
import { clientIp, enforceLimits } from "~~/lib/rate-limit";
import { verifyKybSignature } from "~~/lib/wallet-auth";

export async function POST(req: NextRequest) {
  // Guard: only available in demo mode (no real Sumsub credentials)
  if (process.env.SUMSUB_APP_TOKEN) {
    return NextResponse.json({ error: "Not available in production mode" }, { status: 403 });
  }

  const wallet = req.nextUrl.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !/^0x[0-9a-f]{40}$/i.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { timestamp?: number; signature?: string };
  const sigError = await verifyKybSignature("demo-approve", wallet, body.timestamp, body.signature);
  if (sigError) {
    return NextResponse.json({ error: sigError }, { status: 401 });
  }

  const institution = await prisma.institution.findUnique({ where: { walletAddress: wallet } });
  if (!institution) {
    return NextResponse.json({ error: "Institution not found" }, { status: 404 });
  }

  // Idempotent: never spend admin gas twice on the same wallet
  if (institution.onChainVerified) {
    return NextResponse.json({
      ok: true,
      kybStatus: institution.kybStatus,
      onChainVerified: true,
      alreadyVerified: true,
    });
  }

  const limited = await enforceLimits([
    { key: `kyb-approve:ip:${clientIp(req)}`, max: 3, windowSeconds: 86_400 },
    { key: "kyb-approve:global", max: 30, windowSeconds: 86_400 },
  ]);
  if (limited) return limited;

  // Mark as verified in DB
  await prisma.institution.update({
    where: { walletAddress: wallet },
    data: {
      kybStatus: "verified",
      lastScreenedAt: new Date(),
      sanctionHit: false,
    },
  });

  // Attempt on-chain credentialing
  let txHash: string | undefined;
  try {
    txHash = await onChainVerifyInstitution(
      wallet as `0x${string}`,
      institution.isAccredited,
      institution.jurisdiction ?? "",
    );
    await prisma.institution.update({
      where: { walletAddress: wallet },
      data: { onChainVerified: true, onChainTxHash: txHash },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[demo-approve] On-chain verify FAILED:", msg);
    return NextResponse.json({ error: "On-chain verification failed", details: msg }, { status: 502 });
  }

  await prisma.kybAuditLog.create({
    data: {
      walletAddress: wallet,
      action: "demo_approve",
      fromStatus: institution.kybStatus,
      toStatus: "verified",
      meta: JSON.stringify({ txHash }),
    },
  });

  return NextResponse.json({ ok: true, kybStatus: "verified", onChainVerified: !!txHash, txHash });
}
