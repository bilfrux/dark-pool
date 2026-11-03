import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";

interface AuctionSummary {
  title: string;
  winningPrice: number;
  bidCount: number;
  duration: number; // hours
}

interface BenchmarkRequest {
  category: string;
  recentAuctions: AuctionSummary[];
}

function buildFallbackBenchmark(body: BenchmarkRequest) {
  const { category, recentAuctions } = body;
  if (!recentAuctions || recentAuctions.length === 0) {
    return {
      avgWinningPrice: 0,
      avgBidCount: 0,
      priceRange: { min: 0, max: 0 },
      trendDirection: "insufficient_data" as const,
      sectorInsights: `No auction data available for "${category}". Submit more auctions to generate benchmarks.`,
      recommendations: ["Gather more auction data to establish reliable benchmarks"],
      isFallback: true,
    };
  }

  const prices = recentAuctions.map(a => a.winningPrice);
  const bidCounts = recentAuctions.map(a => a.bidCount);

  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const avgBids = bidCounts.reduce((a, b) => a + b, 0) / bidCounts.length;
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  // Simple trend: compare first half vs second half
  const halfIdx = Math.floor(prices.length / 2);
  const firstHalfAvg = prices.slice(0, halfIdx).reduce((a, b) => a + b, 0) / halfIdx || avgPrice;
  const secondHalfAvg = prices.slice(halfIdx).reduce((a, b) => a + b, 0) / (prices.length - halfIdx) || avgPrice;
  const trendDirection =
    secondHalfAvg > firstHalfAvg * 1.05 ? "rising" : secondHalfAvg < firstHalfAvg * 0.95 ? "falling" : "stable";

  return {
    avgWinningPrice: Math.round(avgPrice * 100) / 100,
    avgBidCount: Math.round(avgBids * 10) / 10,
    priceRange: { min: Math.round(minPrice * 100) / 100, max: Math.round(maxPrice * 100) / 100 },
    trendDirection,
    sectorInsights: `Based on ${recentAuctions.length} auctions in "${category}": average winning price is ${avgPrice.toFixed(2)} ADI with ${avgBids.toFixed(1)} bidders on average.`,
    recommendations: [
      avgBids < 3 ? "Increase bidder recruitment to improve competition" : "Healthy bidder participation",
      trendDirection === "rising" ? "Prices trending upward — consider budget adjustments" : "Price levels stable",
    ],
    isFallback: true,
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as BenchmarkRequest;
    const { category, recentAuctions } = body;

    if (!category) {
      return NextResponse.json({ error: "category is required" }, { status: 400 });
    }

    try {
      const systemPrompt = `You are a market analyst for institutional RWA sealed-bid auctions.
You generate sector-specific benchmarks and insights from historical auction data.
You respond ONLY in valid JSON, no markdown, no backticks.`;

      const auctionsSummary = (recentAuctions || [])
        .map(
          (a, i) =>
            `- Auction ${i + 1}: "${a.title}" — Winner: ${a.winningPrice} ADI, ${a.bidCount} bids, ${a.duration}h duration`,
        )
        .join("\n");

      const userPrompt = `
Generate market benchmarks for sector "${category}":

RECENT AUCTIONS (${recentAuctions?.length || 0}):
${auctionsSummary || "No recent data available"}

Return ONLY this JSON (no markdown):
{
  "avgWinningPrice": <number>,
  "avgBidCount": <number>,
  "priceRange": { "min": <number>, "max": <number> },
  "trendDirection": "<rising|falling|stable|insufficient_data>",
  "sectorInsights": "<2-3 sentences of sector analysis>",
  "recommendations": ["<rec1>", "<rec2>", "<rec3>"]
}`.trim();

      const rawResponse = await runInference(systemPrompt, userPrompt, 600);

      let benchmark;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");
        benchmark = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (parseError: any) {
        console.error("[Parse Error] benchmark:", rawResponse);
        const fallback = buildFallbackBenchmark(body);
        return NextResponse.json({
          benchmark: fallback,
          source: "parse-error-fallback",
          parseError: parseError.message,
        });
      }

      return NextResponse.json({ benchmark, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Benchmark fallback:", ogError.message);
      const fallback = buildFallbackBenchmark(body);
      return NextResponse.json({
        benchmark: fallback,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] benchmark:", error);
    return NextResponse.json(
      {
        error: error?.message || "Internal error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
