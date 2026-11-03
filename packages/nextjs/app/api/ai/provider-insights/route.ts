import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";

interface BidHistoryEntry {
  price: number;
  won: boolean;
  auctionTitle: string;
}

interface ProviderInsightsRequest {
  providerAddress: string;
  bidHistory: BidHistoryEntry[];
}

function buildFallbackInsights(body: ProviderInsightsRequest) {
  const { bidHistory } = body;
  if (!bidHistory || bidHistory.length === 0) {
    return {
      winRate: 0,
      avgPriceVsMedian: 0,
      strengths: ["No bid history available"],
      weaknesses: ["Insufficient data for analysis"],
      recommendations: ["Submit more bids to build a performance profile"],
      trendDirection: "neutral" as const,
      isFallback: true,
    };
  }

  const wins = bidHistory.filter(b => b.won);
  const winRate = Math.round((wins.length / bidHistory.length) * 100);
  const avgPrice = bidHistory.reduce((s, b) => s + b.price, 0) / bidHistory.length;
  const winAvgPrice = wins.length > 0 ? wins.reduce((s, b) => s + b.price, 0) / wins.length : avgPrice;

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const recommendations: string[] = [];

  if (winRate > 50) strengths.push(`High win rate (${winRate}%)`);
  else weaknesses.push(`Below-average win rate (${winRate}%)`);

  if (wins.length > 0 && winAvgPrice < avgPrice) strengths.push("Winning bids tend to be competitively priced");
  else if (wins.length > 0) weaknesses.push("Winning bids are above your average price — consider tighter pricing");

  recommendations.push("Analyze winning patterns to refine optimal pricing strategy");
  if (bidHistory.length < 5) recommendations.push("Build more bid history for better insights");

  // Simple trend: compare last 3 vs first 3
  const recentWinRate =
    bidHistory.length >= 6 ? bidHistory.slice(-3).filter(b => b.won).length / 3 : wins.length / bidHistory.length;
  const earlyWinRate =
    bidHistory.length >= 6 ? bidHistory.slice(0, 3).filter(b => b.won).length / 3 : wins.length / bidHistory.length;

  return {
    winRate,
    avgPriceVsMedian: Math.round(((avgPrice - winAvgPrice) / avgPrice) * 100),
    strengths: strengths.length > 0 ? strengths : ["Consistent participation in auctions"],
    weaknesses: weaknesses.length > 0 ? weaknesses : ["No specific weaknesses detected"],
    recommendations,
    trendDirection: (recentWinRate > earlyWinRate
      ? "improving"
      : recentWinRate < earlyWinRate
        ? "declining"
        : "stable") as "improving" | "declining" | "stable",
    isFallback: true,
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as ProviderInsightsRequest;
    const { providerAddress, bidHistory } = body;

    if (!providerAddress || !bidHistory) {
      return NextResponse.json({ error: "providerAddress and bidHistory are required" }, { status: 400 });
    }

    try {
      const systemPrompt = `You are a performance analyst for sealed-bid auction participants.
You analyze a provider's past bidding history to extract actionable insights.
You NEVER reveal other participants' data — only the requesting provider's own history.
You respond ONLY in valid JSON, no markdown, no backticks.`;

      const wins = bidHistory.filter(b => b.won).length;
      const losses = bidHistory.length - wins;
      const avgPrice = bidHistory.reduce((s, b) => s + b.price, 0) / bidHistory.length;

      const userPrompt = `
Analyze this provider's auction performance:

PROVIDER: ${providerAddress.slice(0, 10)}...
TOTAL BIDS: ${bidHistory.length} (${wins} wins, ${losses} losses)
AVERAGE BID PRICE: ${avgPrice.toFixed(2)} ADI
WIN RATE: ${((wins / bidHistory.length) * 100).toFixed(1)}%

RECENT BIDS:
${bidHistory
  .slice(-10)
  .map((b, i) => `- Bid ${i + 1}: ${b.price} ADI on "${b.auctionTitle}" → ${b.won ? "WON" : "LOST"}`)
  .join("\n")}

Return ONLY this JSON (no markdown):
{
  "winRate": <number 0-100>,
  "avgPriceVsMedian": <number, positive = above median, negative = below>,
  "strengths": ["<strength1>", "<strength2>"],
  "weaknesses": ["<weakness1>", "<weakness2>"],
  "recommendations": ["<rec1>", "<rec2>", "<rec3>"],
  "trendDirection": "<improving|declining|stable>"
}`.trim();

      const rawResponse = await runInference(systemPrompt, userPrompt, 700);

      let insights;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");
        insights = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (parseError: any) {
        console.error("[Parse Error] provider-insights:", rawResponse);
        const fallbackInsights = buildFallbackInsights(body);
        return NextResponse.json({
          insights: fallbackInsights,
          source: "parse-error-fallback",
          parseError: parseError.message,
        });
      }

      return NextResponse.json({ insights, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Provider insights fallback:", ogError.message);
      const fallbackInsights = buildFallbackInsights(body);
      return NextResponse.json({
        insights: fallbackInsights,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] provider-insights:", error);
    return NextResponse.json(
      {
        error: error?.message || "Internal error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
