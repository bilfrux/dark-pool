import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";

interface BidDraftRequest {
  auctionTitle: string;
  auctionDescription: string;
  providerPrice: number;
  providerStrengths: string;
}

function buildFallbackDraft(body: BidDraftRequest) {
  const { auctionTitle, providerPrice, providerStrengths } = body;
  const strengths = providerStrengths
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    draftText: `Regarding "${auctionTitle}": We propose a competitive offer at ${providerPrice} ADI, leveraging our core strengths: ${strengths.join(", ")}. Our team is committed to delivering high-quality results within the specified timeline.`,
    toneAnalysis: "professional",
    suggestedKeywords: strengths.slice(0, 5),
    confidenceLevel: "low" as const,
    isFallback: true,
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as BidDraftRequest;
    const { auctionTitle, auctionDescription, providerPrice, providerStrengths } = body;

    if (!auctionTitle || !providerPrice || !providerStrengths) {
      return NextResponse.json(
        { error: "auctionTitle, providerPrice, and providerStrengths are required" },
        { status: 400 },
      );
    }

    try {
      const systemPrompt = `You are an expert B2B bid writer for sealed-bid auctions.
You help providers draft compelling, professional bid descriptions based on their strengths and the auction context.
You NEVER fabricate credentials or capabilities the provider hasn't mentioned.
You respond ONLY in valid JSON, no markdown, no backticks.`;

      const userPrompt = `
Draft a professional bid description for this sealed-bid auction:

AUCTION: "${auctionTitle}"
DESCRIPTION: "${auctionDescription}"
PROPOSED PRICE: ${providerPrice} ADI
PROVIDER STRENGTHS: ${providerStrengths}

Return ONLY this JSON (no markdown):
{
  "draftText": "<2-4 paragraph professional bid text>",
  "toneAnalysis": "<formal|professional|technical>",
  "suggestedKeywords": ["<keyword1>", "<keyword2>", ...],
  "confidenceLevel": "<low|medium|high>"
}`.trim();

      const rawResponse = await runInference(systemPrompt, userPrompt, 800);

      let draft;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");
        draft = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (parseError: any) {
        console.error("[Parse Error] bid-draft:", rawResponse);
        const fallbackDraft = buildFallbackDraft(body);
        return NextResponse.json({
          draft: fallbackDraft,
          source: "parse-error-fallback",
          parseError: parseError.message,
        });
      }

      return NextResponse.json({ draft, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Bid draft fallback:", ogError.message);
      const fallbackDraft = buildFallbackDraft(body);
      return NextResponse.json({
        draft: fallbackDraft,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] bid-draft:", error);
    return NextResponse.json(
      {
        error: error?.message || "Internal error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
