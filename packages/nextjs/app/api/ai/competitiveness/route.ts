import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";
import { computeCompetitivenessFallback } from "~~/services/og/fallback";

interface CompetitivenessRequest {
  providerPrice: number;
  providerConditions: string;
  auctionCategory: string;
  marketHistoricalData: {
    percentile25: number;
    percentile50: number;
    percentile75: number;
    winRateByRange: {
      below_q1: number;
      q1_to_median: number;
      median_to_q3: number;
      above_q3: number;
    };
    sampleSize: number;
    periodMonths: number;
  };
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  // Garantir que la réponse est toujours du JSON
  try {
    const body = (await req.json()) as CompetitivenessRequest;

    // GARDE DE SÉCURITÉ : refus explicite si des données concurrentes sont présentes
    if ("competitorPrices" in body || "otherBids" in body || "allSubmissions" in body) {
      return NextResponse.json(
        {
          error: "ISOLATION_VIOLATION: Ce endpoint ne peut pas recevoir de données d'autres soumissionnaires.",
          context: "pre-submission",
        },
        { status: 400 },
      );
    }

    const { providerPrice, providerConditions, auctionCategory, marketHistoricalData } = body;

    if (!providerPrice || !marketHistoricalData) {
      return NextResponse.json({ error: "providerPrice et marketHistoricalData sont obligatoires" }, { status: 400 });
    }

    try {
      const systemPrompt = `Tu es un assistant d'analyse de compétitivité pour un système d'enchères B2B scellées.
Tu aides exclusivement le fournisseur à évaluer son propre prix par rapport aux données historiques publiques du marché.
Tu n'as JAMAIS accès aux offres d'autres participants en cours — uniquement des statistiques historiques agrégées.
Tes recommandations sont indicatives et consultatives. Le fournisseur reste seul décideur.
Tu réponds TOUJOURS en JSON valide et uniquement en JSON, sans markdown ni backticks.
Sois précis, chiffré, et actionnable dans tes recommandations.`;

      const userPrompt = buildCompetitivenessPrompt(
        providerPrice,
        providerConditions,
        auctionCategory,
        marketHistoricalData,
      );

      const rawResponse = await runInference(systemPrompt, userPrompt, 700);

      // Parser le JSON retourné par l'IA — extraction robuste
      let analysis;
      try {
        const cleaned = rawResponse
          .replace(/```json\n?/gi, "")
          .replace(/```\n?/g, "")
          .replace(/^\s*[\r\n]/gm, "")
          .trim();

        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) {
          throw new Error("Aucun objet JSON trouvé dans la réponse IA");
        }
        const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
        analysis = JSON.parse(jsonStr);
      } catch (parseError: any) {
        console.error("[Parse Error] Réponse brute :", rawResponse);
        // Basculer sur le fallback statistique plutôt que retourner 502
        const fallbackAnalysis = computeCompetitivenessFallback(providerPrice, marketHistoricalData);
        return NextResponse.json({
          analysis: fallbackAnalysis,
          source: "parse-error-fallback",
          parseError: parseError.message,
          raw: rawResponse.slice(0, 200),
        });
      }

      return NextResponse.json({ analysis, source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Switching to statistical fallback:", ogError.message);

      // Fallback — calcul statistique pur
      const fallbackAnalysis = computeCompetitivenessFallback(providerPrice, marketHistoricalData);
      return NextResponse.json({
        analysis: fallbackAnalysis,
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] competitiveness:", error);
    return NextResponse.json(
      {
        error: error?.message || "Erreur interne",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}

function buildCompetitivenessPrompt(
  price: number,
  conditions: string,
  category: string,
  market: CompetitivenessRequest["marketHistoricalData"],
): string {
  let estimatedPercentile: string;
  if (price < market.percentile25) estimatedPercentile = "< 25th (très compétitif)";
  else if (price < market.percentile50) estimatedPercentile = "25-50th (compétitif)";
  else if (price < market.percentile75) estimatedPercentile = "50-75th (au-dessus de la médiane)";
  else estimatedPercentile = "> 75th (peu compétitif)";

  const reductionTo50 =
    price > market.percentile50
      ? `${(((price - market.percentile50) / price) * 100).toFixed(1)}%`
      : "N/A (déjà sous la médiane)";

  return `
Analyse de compétitivité pré-soumission — Enchère catégorie : "${category}"

OFFRE DU FOURNISSEUR :
- Prix proposé : ${price}
- Conditions : ${conditions}

RÉFÉRENTIEL MARCHÉ (données historiques publiques on-chain — ${market.sampleSize} enchères, ${market.periodMonths} derniers mois) :
- Q1 (25ème percentile) : ${market.percentile25}
- Médiane (50ème) : ${market.percentile50}
- Q3 (75ème) : ${market.percentile75}
- Taux de succès par tranche :
  • Offres < Q1 : ${market.winRateByRange.below_q1}% de succès
  • Q1 à médiane : ${market.winRateByRange.q1_to_median}% de succès
  • Médiane à Q3 : ${market.winRateByRange.median_to_q3}% de succès
  • > Q3 : ${market.winRateByRange.above_q3}% de succès

POSITION ESTIMÉE DE CETTE OFFRE : ${estimatedPercentile}
RÉDUCTION NÉCESSAIRE POUR ATTEINDRE LA MÉDIANE : ${reductionTo50}

Retourne UNIQUEMENT ce JSON (sans markdown, sans texte supplémentaire) :
{
  "estimatedPercentile": <number entre 0 et 100>,
  "competitivenessScore": <number entre 0 et 100, 100 étant le plus compétitif>,
  "winProbabilityEstimate": <number entre 0 et 100, en %>
  "recommendation": "<phrase courte et chiffrée>",
  "detailedExplanation": "<2-3 phrases d'analyse>",
  "riskAssessment": "<low|medium|high>",
  "suggestedPriceRange": { "min": <number>, "max": <number> },
  "confidenceLevel": "<low|medium|high> selon la taille de l'échantillon"
}
`.trim();
}
