import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";

interface LowBidDetectRequest {
  revealedBids: Array<{ price: number; conditions: string }>;
  marketContext: { title: string; description: string };
}

function buildFallbackDetection(body: LowBidDetectRequest) {
  const prices = body.revealedBids.map(b => b.price);
  const n = prices.length;
  const avg = prices.reduce((a, b) => a + b, 0) / n;
  const stdDev = Math.sqrt(prices.map(p => Math.pow(p - avg, 2)).reduce((a, b) => a + b, 0) / n);

  const alerts = body.revealedBids
    .map((b, i) => {
      const zScore = stdDev > 0 ? (avg - b.price) / stdDev : 0;
      if (zScore > 1.5) {
        return {
          bidderIndex: i,
          price: b.price,
          reason: `Price is ${zScore.toFixed(1)} standard deviations below the mean (${avg.toFixed(2)} ADI). Z-score threshold: 1.5.`,
          severity: (zScore > 2.5 ? "critical" : zScore > 2 ? "high" : "medium") as "critical" | "high" | "medium",
        };
      }
      return null;
    })
    .filter(Boolean) as Array<{ bidderIndex: number; price: number; reason: string; severity: string }>;

  return {
    alerts,
    overallRisk: alerts.some(a => a.severity === "critical") ? "high" : alerts.length > 0 ? "medium" : "low",
    recommendation:
      alerts.length > 0
        ? "Review flagged bids carefully — abnormally low prices may indicate misunderstanding of scope or predatory pricing."
        : "No abnormally low bids detected. Price distribution appears normal.",
    isFallback: true,
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as LowBidDetectRequest;
    const { revealedBids, marketContext } = body;

    if (!revealedBids || revealedBids.length < 2) {
      return NextResponse.json({ error: "Minimum 2 revealed bids required for detection" }, { status: 400 });
    }

    try {
      const systemPrompt = `You are a procurement risk analyst specializing in detecting abnormally low bids in sealed auctions.
You flag bids that may indicate predatory pricing, scope misunderstanding, or non-viable offers.
All bids are publicly revealed on-chain. Your analysis must be objective and fact-based.
You respond ONLY in valid JSON, no markdown, no backticks.`;

      const prices = revealedBids.map(b => b.price);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

      const userPrompt = `
Detect abnormally low bids in this auction:

CONTEXT: "${marketContext.title}" — "${marketContext.description}"
AVERAGE BID PRICE: ${avg.toFixed(2)} ADI

BIDS:
${revealedBids.map((b, i) => `- Bidder ${i + 1}: ${b.price} ADI | Conditions: "${b.conditions}"`).join("\n")}

Flag any bids that are suspiciously low. Consider price relative to average, conditions offered, and market context.

Return ONLY this JSON (no markdown):
{
  "alerts": [
    {
      "bidderIndex": <0-based index>,
      "price": <number>,
      "reason": "<why this bid is flagged>",
      "severity": "<low|medium|high|critical>"
    }
  ],
  "overallRisk": "<low|medium|high>",
  "recommendation": "<2-3 sentences for the buyer>"
}`.trim();

      const rawResponse = await runInference(systemPrompt, userPrompt, 700);

      let detection;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");
        detection = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (parseError: any) {
        console.error("[Parse Error] low-bid-detect:", rawResponse);
        const fallbackDetection = buildFallbackDetection(body);
        return NextResponse.json({
          detection: fallbackDetection,
          source: "parse-error-fallback",
          parseError: parseError.message,
        });
      }

      return NextResponse.json({ detection, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Low bid detection fallback:", ogError.message);
      const fallbackDetection = buildFallbackDetection(body);
      return NextResponse.json({
        detection: fallbackDetection,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] low-bid-detect:", error);
    return NextResponse.json(
      {
        error: error?.message || "Internal error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
