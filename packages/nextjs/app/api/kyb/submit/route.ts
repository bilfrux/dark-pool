/**
 * POST /api/kyb/submit
 * Body: { walletAddress, legalName?, jurisdiction?, contactEmail?, timestamp, signature }
 * The signature (see lib/wallet-auth.ts) proves the caller owns walletAddress.
 * Returns: { token: string, demo: true } — demo token (Sumsub integration on roadmap)
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "~~/lib/prisma";
import { clientIp, enforceLimits } from "~~/lib/rate-limit";
import { verifyKybSignature } from "~~/lib/wallet-auth";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      walletAddress?: string;
      legalName?: string;
      jurisdiction?: string;
      contactEmail?: string;
      timestamp?: number;
      signature?: string;
    };

    const walletAddress = body.walletAddress?.toLowerCase();
    if (!walletAddress || !/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const limited = await enforceLimits([{ key: `kyb-submit:ip:${clientIp(req)}`, max: 10, windowSeconds: 3600 }]);
    if (limited) return limited;

    const sigError = await verifyKybSignature("submit", walletAddress, body.timestamp, body.signature);
    if (sigError) {
      return NextResponse.json({ error: sigError }, { status: 401 });
    }

    // Create or upsert institution record
    let institution = await prisma.institution.findUnique({ where: { walletAddress } });

    if (!institution) {
      institution = await prisma.institution.create({
        data: {
          walletAddress,
          legalName: body.legalName,
          jurisdiction: body.jurisdiction,
          contactEmail: body.contactEmail,
          kybStatus: "pending",
        },
      });
    } else if (institution.kybStatus === "not_found") {
      institution = await prisma.institution.update({
        where: { walletAddress },
        data: { kybStatus: "pending", legalName: body.legalName, jurisdiction: body.jurisdiction },
      });
    }

    // Demo: real KYB document verification is on the roadmap
    const applicantId = `demo-${walletAddress.slice(2, 10)}`;
    const token = `demo-token-${walletAddress.slice(2, 10)}`;

    // Store applicant ID
    if (!institution.sumsubApplicantId) {
      await prisma.institution.update({
        where: { walletAddress },
        data: { sumsubApplicantId: applicantId, kybStatus: "pending" },
      });
    }

    // Audit log
    await prisma.kybAuditLog.create({
      data: {
        walletAddress,
        action: "submit",
        fromStatus: institution.kybStatus,
        toStatus: "pending",
        meta: JSON.stringify({ applicantId }),
      },
    });

    return NextResponse.json({ token, demo: true });
  } catch (e: unknown) {
    console.error("[kyb/submit]", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
