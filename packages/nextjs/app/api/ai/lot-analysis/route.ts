import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";

interface LotAnalysisRequest {
  auctionTitle: string;
  auctionDescription: string;
  depositRequired: string;
  closeTime: number;
}

function buildFallbackAnalysis(body: LotAnalysisRequest) {
  const words = (body.auctionTitle + " " + body.auctionDescription).toLowerCase();
  const keywords = ["real estate", "tender", "construction", "supply", "service", "infrastructure", "asset"];
  const matched = keywords.filter(kw => words.includes(kw));

  const riskFactors: string[] = [];
  if (body.closeTime && body.closeTime - Date.now() / 1000 < 86400)
    riskFactors.push("Tight deadline — less than 24h remaining");
  if (parseFloat(body.depositRequired || "0") > 1) riskFactors.push("High deposit requirement");

  return {
    keyRequirements:
      matched.length > 0
        ? matched.map(kw => `Related to: ${kw}`)
        : ["Review auction description for specific requirements"],
    riskFactors: riskFactors.length > 0 ? riskFactors : ["No obvious risk factors detected"],
    recommendedStrategy:
      "Review the auction description carefully and prepare a competitive bid addressing all stated requirements.",
    complexityScore: Math.min(10, 3 + matched.length + riskFactors.length),
    idealProfileDescription: "Provider with relevant domain experience and capacity to meet deposit requirements.",
    isFallback: true,
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as LotAnalysisRequest;
    const { auctionTitle, auctionDescription } = body;

    if (!auctionTitle || !auctionDescription) {
      return NextResponse.json({ error: "auctionTitle and auctionDescription are required" }, { status: 400 });
    }

    try {
      const systemPrompt = `You are an expert procurement analyst for sealed-bid RWA auctions.
You analyze auction lots to help providers understand requirements and position their bid strategically.
You respond ONLY in valid JSON, no markdown, no backticks.`;

      const userPrompt = `
Analyze this auction lot for a potential bidder:

TITLE: "${auctionTitle}"
DESCRIPTION: "${auctionDescription}"
DEPOSIT REQUIRED: ${body.depositRequired || "N/A"}
CLOSES IN: ${body.closeTime ? Math.max(0, Math.round((body.closeTime - Date.now() / 1000) / 3600)) + " hours" : "N/A"}

Return ONLY this JSON (no markdown):
{
  "keyRequirements": ["<requirement1>", "<requirement2>", ...],
  "riskFactors": ["<risk1>", "<risk2>", ...],
  "recommendedStrategy": "<2-3 sentences of strategic advice>",
  "complexityScore": <number 1-10>,
  "idealProfileDescription": "<description of ideal bidder profile>"
}`.trim();

      const rawResponse = await runInference(systemPrompt, userPrompt, 700);

      let analysis;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");
        analysis = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (parseError: any) {
        console.error("[Parse Error] lot-analysis:", rawResponse);
        const fallbackAnalysis = buildFallbackAnalysis(body);
        return NextResponse.json({
          analysis: fallbackAnalysis,
          source: "parse-error-fallback",
          parseError: parseError.message,
        });
      }

      return NextResponse.json({ analysis, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Lot analysis fallback:", ogError.message);
      const fallbackAnalysis = buildFallbackAnalysis(body);
      return NextResponse.json({
        analysis: fallbackAnalysis,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] lot-analysis:", error);
    return NextResponse.json(
      {
        error: error?.message || "Internal error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
