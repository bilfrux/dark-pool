import { NextRequest, NextResponse } from "next/server";
import { aiRateLimit } from "~~/lib/rate-limit";
import { runInference } from "~~/services/gemini/client";
import { computePostRevealFallback } from "~~/services/og/fallback";

interface RevealedBid {
  bidderAddress: string;
  price: number;
  conditions: string;
  submittedAt: number;
  revealedAt: number;
}

interface PostRevealRequest {
  auctionId: string;
  auctionCategory: string;
  buyerAddress: string;
  revealedBids: RevealedBid[];
  auctionStartedAt: number;
  auctionEndedAt: number;
}

export async function POST(req: NextRequest) {
  const limited = await aiRateLimit(req);
  if (limited) return limited;

  try {
    const body = (await req.json()) as PostRevealRequest;
    const { auctionId, auctionCategory, revealedBids } = body;

    if (!revealedBids || revealedBids.length < 2) {
      return NextResponse.json(
        { error: "Minimum 2 offres révélées requises pour l'analyse statistique." },
        { status: 400 },
      );
    }

    try {
      const systemPrompt = `Tu es un expert en analyse d'appels d'offres, marchés publics décentralisés, et détection de comportements anticoncurrentiels.
Tu analyses des enchères scellées APRÈS leur révélation publique on-chain.
Toutes les données que tu reçois sont désormais publiques et vérifiables sur la blockchain.
Tu fournis une analyse objective, des alertes factuelles, et des recommandations stratégiques pour l'acheteur.
Tu réponds TOUJOURS en JSON valide uniquement, sans markdown ni backticks.`;

      const userPrompt = buildPostRevealPrompt(auctionId, auctionCategory, revealedBids, body);

      const rawResponse = await runInference(systemPrompt, userPrompt, 900);

      let report;
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
        report = JSON.parse(jsonStr);
      } catch (parseError: any) {
        console.error("[Parse Error] Réponse brute :", rawResponse);
        const fallbackReport = computePostRevealFallback(revealedBids);
        return NextResponse.json({
          report: fallbackReport,
          auctionId,
          analyzedAt: Date.now(),
          source: "parse-error-fallback",
          parseError: parseError.message,
          raw: rawResponse.slice(0, 200),
        });
      }

      return NextResponse.json({ report, auctionId, analyzedAt: Date.now(), source: "0g-compute" });
    } catch (ogError: any) {
      console.warn("[0G Unavailable] Post-reveal fallback:", ogError.message);

      const fallbackReport = computePostRevealFallback(revealedBids);
      return NextResponse.json({
        report: fallbackReport,
        auctionId,
        analyzedAt: Date.now(),
        source: "statistical-fallback",
        fallbackReason: ogError.message,
      });
    }
  } catch (error: any) {
    console.error("[API Error] post-reveal:", error);
    return NextResponse.json(
      {
        error: error?.message || "Erreur interne",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}

function buildPostRevealPrompt(
  auctionId: string,
  category: string,
  bids: RevealedBid[],
  meta: PostRevealRequest,
): string {
  const prices = bids.map(b => b.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const spread = (((max - min) / avg) * 100).toFixed(2);
  const stdDev = Math.sqrt(prices.map(p => Math.pow(p - avg, 2)).reduce((a, b) => a + b, 0) / prices.length).toFixed(2);

  const anonymizedBids = bids.map((b, i) => ({
    id: `Fournisseur_${i + 1}`,
    price: b.price,
    conditions: b.conditions,
    revealDelay: b.revealedAt - meta.auctionEndedAt,
  }));

  const sortedPrices = [...prices].sort((a, b) => a - b);
  const gaps = sortedPrices.slice(1).map((p, i) => p - sortedPrices[i]);
  const maxGap = Math.max(...gaps);
  const minGap = Math.min(...gaps);
  const suspiciouslyClose = minGap < avg * 0.005;
  const suspiciouslyEvenly = maxGap - minGap < avg * 0.01;

  return `
Analyse post-révélation — Enchère #${auctionId} — Catégorie : "${category}"
Durée d'enchère : ${Math.round((meta.auctionEndedAt - meta.auctionStartedAt) / 3600)} heures
Nombre de soumissionnaires : ${bids.length}

OFFRES RÉVÉLÉES (anonymisées) :
${anonymizedBids.map(b => `- ${b.id} : Prix = ${b.price} | Conditions : "${b.conditions}" | Délai de révélation : ${b.revealDelay}s après la clôture`).join("\n")}

STATISTIQUES BRUTES :
- Min : ${min}, Max : ${max}
- Moyenne : ${avg.toFixed(2)}, Écart-type : ${stdDev}
- Spread total : ${spread}%
- Plus petit écart entre deux offres consécutives : ${minGap.toFixed(2)} (${((minGap / avg) * 100).toFixed(2)}% de la moyenne)
- Offres suspicieusement proches (< 0.5% écart) : ${suspiciouslyClose ? "OUI ⚠️" : "Non"}
- Distribution anormalement régulière : ${suspiciouslyEvenly ? "OUI ⚠️" : "Non"}

Retourne UNIQUEMENT ce JSON (sans markdown, sans texte supplémentaire) :
{
  "collusionRisk": "<none|low|medium|high|critical>",
  "collusionIndicators": ["<string>"],
  "collusionExplanation": "<string>",
  "priceDispersion": {
    "spreadPercent": <number>,
    "standardDeviation": <number>,
    "interpretation": "<string>",
    "outliers": ["<string>"]
  },
  "winnerJustification": "<string>",
  "marketHealthScore": <number entre 0 et 100>,
  "revealBehaviorAnalysis": "<string>",
  "nextCycleRecommendations": ["<string>", "<string>", "<string>"],
  "shouldEscalate": <boolean>
}
`.trim();
}
