import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";

interface RevealedBid {
  price: number;
  conditions: string;
  bidderAddress: string;
}

interface BidScoringRequest {
  auctionTitle: string;
  auctionDescription: string;
  revealedBids: RevealedBid[];
}

function buildFallbackScoring(body: BidScoringRequest) {
  const { revealedBids } = body;
  const prices = revealedBids.map(b => b.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = maxPrice - minPrice || 1;

  const scoredBids = revealedBids.map(b => {
    const priceScore = Math.round(((maxPrice - b.price) / range) * 100);
    const qualityScore = Math.min(100, Math.round(b.conditions.length / 2));
    const overallScore = Math.round(priceScore * 0.6 + qualityScore * 0.4);
    return {
      bidderAddress: b.bidderAddress,
      priceScore,
      qualityScore,
      overallScore,
      reasoning: `Price-based ranking. ${b.price === minPrice ? "Lowest price." : `${(((b.price - minPrice) / minPrice) * 100).toFixed(1)}% above lowest.`}`,
    };
  });

  scoredBids.sort((a, b) => b.overallScore - a.overallScore);
  const bestBid = scoredBids[0];

  return {
    scoredBids,
    bestValueBid: bestBid?.bidderAddress || "",
    recommendation: `Based on price-weighted scoring (60% price, 40% quality), ${bestBid?.bidderAddress.slice(0, 10)}... offers the best value.`,
    isFallback: true,
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as BidScoringRequest;
    const { auctionTitle, auctionDescription, revealedBids } = body;

    if (!revealedBids || revealedBids.length < 2) {
      return NextResponse.json({ error: "Minimum 2 revealed bids required for scoring" }, { status: 400 });
    }

    try {
      const systemPrompt = `You are a procurement evaluation expert for sealed-bid RWA auctions.
You score revealed bids across multiple criteria to help buyers make informed decisions.
All bids have been publicly revealed on-chain. Your analysis must be fair and objective.
You respond ONLY in valid JSON, no markdown, no backticks.`;

      const anonymizedBids = revealedBids.map((b, i) => ({
        id: `Bidder_${i + 1}`,
        address: b.bidderAddress,
        price: b.price,
        conditions: b.conditions,
      }));

      const userPrompt = `
Score these revealed bids for auction "${auctionTitle}":
Description: "${auctionDescription}"

BIDS:
${anonymizedBids.map(b => `- ${b.id} (${b.address.slice(0, 10)}...): Price = ${b.price} ADI | Conditions: "${b.conditions}"`).join("\n")}

Score each bid on: price competitiveness (0-100), quality/conditions (0-100), overall (0-100).

Return ONLY this JSON (no markdown):
{
  "scoredBids": [
    {
      "bidderAddress": "<full address>",
      "priceScore": <0-100>,
      "qualityScore": <0-100>,
      "overallScore": <0-100>,
      "reasoning": "<1-2 sentences>"
    }
  ],
  "bestValueBid": "<address of best overall bid>",
  "recommendation": "<2-3 sentences of buyer recommendation>"
}`.trim();

      const rawResponse = await runInference(systemPrompt, userPrompt, 900);

      let scoring;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");
        scoring = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (parseError: any) {
        console.error("[Parse Error] bid-scoring:", rawResponse);
        const fallbackScoring = buildFallbackScoring(body);
        return NextResponse.json({
          scoring: fallbackScoring,
          source: "parse-error-fallback",
          parseError: parseError.message,
        });
      }

      return NextResponse.json({ scoring, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Bid scoring fallback:", ogError.message);
      const fallbackScoring = buildFallbackScoring(body);
      return NextResponse.json({
        scoring: fallbackScoring,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] bid-scoring:", error);
    return NextResponse.json(
      {
        error: error?.message || "Internal error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
