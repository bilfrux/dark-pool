import { NextRequest, NextResponse } from "next/server";
import { prisma } from "~~/lib/prisma";

/**
 * Fixed-window rate limiter backed by Postgres, so the limit holds across
 * serverless instances. Returns the request count in the current window.
 */
async function hit(key: string, windowSeconds: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count")
    VALUES (${key}, now(), 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimit"."windowStart" < now() - make_interval(secs => ${windowSeconds}) THEN 1
        ELSE "RateLimit"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "RateLimit"."windowStart" < now() - make_interval(secs => ${windowSeconds}) THEN now()
        ELSE "RateLimit"."windowStart"
      END
    RETURNING "count"`;
  return Number(rows[0]?.count ?? 0);
}

export function clientIp(req: NextRequest): string {
  // On Vercel, x-forwarded-for is set by the platform and cannot be spoofed by the client.
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

type Limit = { key: string; max: number; windowSeconds: number };

/**
 * Checks every limit; returns a 429 response if any is exceeded, otherwise null.
 * Fails open if the database is unreachable so the app keeps working.
 */
export async function enforceLimits(limits: Limit[]): Promise<NextResponse | null> {
  try {
    for (const { key, max, windowSeconds } of limits) {
      const count = await hit(key, windowSeconds);
      if (count > max) {
        return NextResponse.json(
          { error: "Too many requests, please try again later." },
          { status: 429, headers: { "Retry-After": String(windowSeconds) } },
        );
      }
    }
  } catch (e) {
    console.error("[rate-limit] check failed, allowing request:", e instanceof Error ? e.message : e);
  }
  return null;
}

/** AI endpoints: 20 req/min per IP, and a global daily cap to bound provider costs. */
export function aiRateLimit(req: NextRequest) {
  return enforceLimits([
    { key: `ai:ip:${clientIp(req)}`, max: 20, windowSeconds: 60 },
    { key: "ai:global", max: 1000, windowSeconds: 86_400 },
  ]);
}
