import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";

interface CategorizeRequest {
  title: string;
  description: string;
}

function buildFallbackCategorization(body: CategorizeRequest) {
  const text = (body.title + " " + body.description).toLowerCase();

  const categories: Record<string, string[]> = {
    "Real Estate": ["real estate", "property", "building", "land", "villa", "apartment", "tower", "plot"],
    Infrastructure: ["infrastructure", "road", "bridge", "utility", "water", "power", "transport"],
    Construction: ["construction", "renovation", "development", "build"],
    Technology: ["technology", "software", "hardware", "digital", "it ", "cloud", "ai"],
    "Financial Services": ["financial", "banking", "insurance", "investment", "fund"],
    Energy: ["energy", "solar", "oil", "gas", "renewable", "power plant"],
    Healthcare: ["healthcare", "hospital", "medical", "pharma"],
    Government: ["government", "public", "municipal", "federal"],
  };

  const scores: Array<{ cat: string; score: number }> = [];
  for (const [cat, keywords] of Object.entries(categories)) {
    const score = keywords.filter(kw => text.includes(kw)).length;
    if (score > 0) scores.push({ cat, score });
  }
  scores.sort((a, b) => b.score - a.score);

  const primary = scores[0]?.cat || "General";
  const secondary = scores.slice(1, 3).map(s => s.cat);

  // Extract simple tags from title
  const tags = body.title
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5)
    .map(w => w.toUpperCase());

  return {
    primaryCategory: primary,
    secondaryCategories: secondary,
    tags,
    confidence: scores[0]?.score ? Math.min(0.9, 0.3 + scores[0].score * 0.15) : 0.2,
    isFallback: true,
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as CategorizeRequest;
    const { title, description } = body;

    if (!title) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    try {
      const systemPrompt = `You are a categorization expert for institutional RWA (Real World Asset) auctions.
You classify auctions into industry categories based on their title and description.
You respond ONLY in valid JSON, no markdown, no backticks.`;

      const userPrompt = `
Categorize this auction:

TITLE: "${title}"
DESCRIPTION: "${description || "No description provided"}"

Assign a primary category, secondary categories (if applicable), and relevant tags.

Return ONLY this JSON (no markdown):
{
  "primaryCategory": "<main category>",
  "secondaryCategories": ["<cat1>", "<cat2>"],
  "tags": ["<tag1>", "<tag2>", "<tag3>", ...],
  "confidence": <number 0-1>
}`.trim();

      const rawResponse = await runInference(systemPrompt, userPrompt, 400);

      let categorization;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");
        categorization = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (parseError: any) {
        console.error("[Parse Error] categorize:", rawResponse);
        const fallback = buildFallbackCategorization(body);
        return NextResponse.json({
          categorization: fallback,
          source: "parse-error-fallback",
          parseError: parseError.message,
        });
      }

      return NextResponse.json({ categorization, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Categorization fallback:", ogError.message);
      const fallback = buildFallbackCategorization(body);
      return NextResponse.json({
        categorization: fallback,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] categorize:", error);
    return NextResponse.json(
      {
        error: error?.message || "Internal error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
