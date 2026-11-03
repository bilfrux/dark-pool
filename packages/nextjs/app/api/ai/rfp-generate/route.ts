import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";

interface RFPGenerateRequest {
  assetType: string;
  location: string;
  budget: string;
  requirements: string;
  timeline: string;
}

function buildFallbackRFP(body: RFPGenerateRequest) {
  const { assetType, location, budget, requirements, timeline } = body;
  return {
    suggestedTitle: `${assetType.toUpperCase()} — ${location.toUpperCase()} SEALED-BID TENDER`,
    suggestedDescription: `Request for Proposals for ${assetType} located in ${location}. Budget range: ${budget} ADI. Requirements: ${requirements}. Expected timeline: ${timeline}. All bids must comply with platform KYB verification requirements.`,
    suggestedDuration: 48,
    suggestedDeposit: "0.01",
    keyTerms: [
      assetType,
      location,
      ...requirements
        .split(",")
        .map(r => r.trim())
        .filter(Boolean)
        .slice(0, 3),
    ],
    isFallback: true,
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as RFPGenerateRequest;
    const { assetType, requirements } = body;

    if (!assetType || !requirements) {
      return NextResponse.json({ error: "assetType and requirements are required" }, { status: 400 });
    }

    try {
      const systemPrompt = `You are an expert RFP (Request for Proposal) writer for institutional RWA sealed-bid auctions.
You help buyers create clear, professional auction listings that maximize quality bid submissions.
You respond ONLY in valid JSON, no markdown, no backticks.`;

      const userPrompt = `
Generate a professional auction listing from these inputs:

ASSET TYPE: ${assetType}
LOCATION: ${body.location || "Not specified"}
BUDGET: ${body.budget || "Not specified"} ADI
KEY REQUIREMENTS: ${requirements}
TIMELINE: ${body.timeline || "Not specified"}

Return ONLY this JSON (no markdown):
{
  "suggestedTitle": "<concise professional title, max 80 chars>",
  "suggestedDescription": "<detailed 2-3 paragraph description covering scope, requirements, and expectations>",
  "suggestedDuration": <number, recommended auction duration in hours>,
  "suggestedDeposit": "<recommended deposit in ADI as string>",
  "keyTerms": ["<term1>", "<term2>", ...]
}`.trim();

      const rawResponse = await runInference(systemPrompt, userPrompt, 800);

      let rfp;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");
        rfp = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (parseError: any) {
        console.error("[Parse Error] rfp-generate:", rawResponse);
        const fallbackRFP = buildFallbackRFP(body);
        return NextResponse.json({
          rfp: fallbackRFP,
          source: "parse-error-fallback",
          parseError: parseError.message,
        });
      }

      return NextResponse.json({ rfp, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] RFP generation fallback:", ogError.message);
      const fallbackRFP = buildFallbackRFP(body);
      return NextResponse.json({
        rfp: fallbackRFP,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] rfp-generate:", error);
    return NextResponse.json(
      {
        error: error?.message || "Internal error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
