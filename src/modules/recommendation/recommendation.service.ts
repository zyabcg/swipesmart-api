import { prisma } from '../../lib/prisma';
import { getAllCards } from '../cards/cards.service';
import { scoreCard, buildScoredCard, DEFAULT_WEIGHTS } from './scoring.engine';
import type { RecommendInput, ScoredCard, ScoringWeights } from '../../types';

export interface RecommendationResult {
  recommendations: ScoredCard[];
  totalMatched: number;
  totalEvaluated: number;
}

export async function recommend(
  input: RecommendInput,
  sessionId: string,
  options?: {
    limit?: number;
    weights?: ScoringWeights;
  }
): Promise<RecommendationResult> {
  const limit = options?.limit ?? 5;
  const weights = options?.weights ?? DEFAULT_WEIGHTS;

  // Load all active cards (cached via Redis)
  const allCards = await getAllCards({ isActive: true });
  const totalEvaluated = allCards.length;

  // Score and filter
  const scored = allCards
    .map((card) => ({ card, score: scoreCard(card, input, weights) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  const totalMatched = scored.length;
  const topCards = scored.slice(0, limit);

  // Build full scored card objects with explanations + highlights
  const recommendations: ScoredCard[] = topCards.map((x, i) =>
    buildScoredCard(x.card, input, i + 1, weights)
  );

  // Persist async (fire-and-forget)
  persistRecommendation(sessionId, input, recommendations).catch(() => {});

  return { recommendations, totalMatched, totalEvaluated };
}

async function persistRecommendation(
  sessionId: string,
  input: RecommendInput,
  recommendations: ScoredCard[]
): Promise<void> {
  const session = await prisma.session.findUnique({ where: { sessionId } });
  if (!session) return;

  await prisma.recommendationRequest.create({
    data: {
      sessionId: session.id,
      income: input.income,
      totalSpend: input.totalSpend,
      primaryCategory: input.primaryCategory,
      lifestylePreference: input.lifestylePreference,
      maxFee: input.maxFee,
      intlTravel: input.intlTravel,
      result: recommendations as object,
    },
  });
}
