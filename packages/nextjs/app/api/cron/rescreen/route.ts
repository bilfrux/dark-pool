/**
 * GET /api/cron/rescreen
 * Cron job: re-screen all verified institutions against sanctions.
 * Should be triggered by a cron service (e.g. Vercel Cron, daily).
 * Protected by CRON_SECRET: Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>`.
 */
import { NextRequest, NextResponse } from "next/server";
import { onChainRevokeInstitution } from "~~/lib/onchain-credentials";
import { prisma } from "~~/lib/prisma";
import { hasSanctionHit, screenEntity } from "~~/lib/sanctions";

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!expected || (auth !== `Bearer ${expected}` && req.headers.get("x-cron-secret") !== expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch all on-chain verified institutions
  const institutions = await prisma.institution.findMany({
    where: { onChainVerified: true, kybStatus: "verified" },
  });

  let revoked = 0;
  const errors: string[] = [];

  for (const inst of institutions) {
    if (!inst.legalName) continue;
    try {
      const result = await screenEntity(inst.legalName, inst.jurisdiction ?? undefined);
      const hit = hasSanctionHit(result);

      if (hit) {
        // Revoke on-chain
        await onChainRevokeInstitution(inst.walletAddress as `0x${string}`);

        await prisma.institution.update({
          where: { walletAddress: inst.walletAddress },
          data: {
            kybStatus: "suspended",
            sanctionHit: true,
            sanctionHitDetails: JSON.stringify(result.hits.slice(0, 3)),
            onChainVerified: false,
            lastScreenedAt: new Date(),
          },
        });

        await prisma.kybAuditLog.create({
          data: {
            walletAddress: inst.walletAddress,
            action: "sanction_hit",
            fromStatus: "verified",
            toStatus: "suspended",
            meta: JSON.stringify({ searchId: result.searchId }),
          },
        });

        revoked++;
      } else {
        await prisma.institution.update({
          where: { walletAddress: inst.walletAddress },
          data: { lastScreenedAt: new Date(), sanctionHit: false },
        });
      }
    } catch (e: unknown) {
      errors.push(`${inst.walletAddress}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({
    screened: institutions.length,
    revoked,
    errors: errors.length > 0 ? errors : undefined,
  });
}
