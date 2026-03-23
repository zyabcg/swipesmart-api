/**
 * Scoring engine — the core recommendation algorithm.
 *
 * Design goals:
 *  1. Fully configurable via ScoringWeights (tunable without code changes)
 *  2. Produces deterministic, explainable scores
 *  3. No hidden magic — every factor is documented
 *
 * Score = annualRewardValue + welcomeBonus(discounted) + lifestyleBonus
 *       + intlTravelBonus + categoryBreadthBonus - annualFee
 */
import type {
  CardRecord,
  RecommendInput,
  ScoredCard,
  ScoringWeights,
  RewardRates,
  PrimaryCategory,
} from '../../types';

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_WEIGHTS: ScoringWeights = {
  // How much weight to give the annual reward value (1.0 = full face value)
  annualRewardMultiplier: 1.0,

  // Welcome bonuses are one-time; discount them to 50% of face value
  welcomeBonusMultiplier: 0.5,

  // Flat bonus when a card matches the user's stated lifestyle preference
  lifestyleBonus: 5000,

  // International travel bonuses reward cards with lounge + forex benefits
  intlTravelBonusFrequent: 8000,
  intlTravelBonusOccasional: 3000,

  // Annual fee is subtracted at face value (1.0)
  annualFeeMultiplier: 1.0,

  // How much to reward cards that perform well across ALL categories, not just
  // the primary one. Weighted at 30% to avoid over-penalizing specialist cards.
  categoryBreadthWeight: 0.3,
};

// ─── Labels ────────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  travel: 'travel',
  dining: 'dining & food',
  online: 'online shopping',
  groceries: 'groceries',
  fuel: 'fuel',
  utility: 'utility bills',
  everything: 'all categories',
};

const LIFESTYLE_LABELS: Record<string, string> = {
  travel_perks: 'travel perks & lounge access',
  cashback: 'maximum cashback',
  rewards_points: 'reward points',
  low_fee: 'low/no annual fee',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRate(rates: RewardRates, category: PrimaryCategory): number {
  if (category === 'everything') return rates.default;
  return (rates[category as keyof RewardRates] as number | undefined) ?? rates.default;
}

function formatInr(amount: number): string {
  return '₹' + Math.round(amount).toLocaleString('en-IN');
}

// ─── Core scoring ──────────────────────────────────────────────────────────────

/**
 * Returns a numeric score for a card against a user profile, or -1 if the
 * card is disqualified by a hard constraint.
 */
export function scoreCard(
  card: CardRecord,
  input: RecommendInput,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
  // ── Hard filters ──────────────────────────────────────────────────────────
  if (card.annualFee > input.maxFee) return -1;

  // Income check: if card requires income > 1.5× user's income, disqualify.
  // The 1.5× buffer accounts for approval thresholds being approximate.
  if (card.minIncome > input.income * 1.5) return -1;

  const rates = card.rewardRates as RewardRates;
  const primaryRate = getRate(rates, input.primaryCategory);

  // ── Annual reward value ───────────────────────────────────────────────────
  const annualRewardValue = input.totalSpend * 12 * (primaryRate / 100);

  // ── Welcome bonus (discounted, one-time) ─────────────────────────────────
  const welcomeValue = card.welcomeBonus * weights.welcomeBonusMultiplier;

  // ── Lifestyle match bonus ─────────────────────────────────────────────────
  const lifestyleBonus = card.bestFor.includes(input.lifestylePreference) ? weights.lifestyleBonus : 0;

  // ── International travel bonus ────────────────────────────────────────────
  let intlBonus = 0;
  if (card.intlTravel) {
    if (input.intlTravel === 'frequently') intlBonus = weights.intlTravelBonusFrequent;
    else if (input.intlTravel === 'occasionally') intlBonus = weights.intlTravelBonusOccasional;
  }

  // ── Category breadth bonus ────────────────────────────────────────────────
  // Rewards cards that perform well even in non-primary categories.
  const allCategories = ['travel', 'dining', 'online', 'groceries', 'fuel', 'utility'] as const;
  const avgRate =
    allCategories.reduce((sum, cat) => sum + ((rates[cat] as number | undefined) ?? rates.default), 0) /
    allCategories.length;
  const breadthBonus = ((avgRate * input.totalSpend * 12) / 100) * weights.categoryBreadthWeight;

  // ── Annual fee penalty ────────────────────────────────────────────────────
  const feePenalty = card.annualFee * weights.annualFeeMultiplier;

  const total =
    annualRewardValue * weights.annualRewardMultiplier +
    welcomeValue +
    lifestyleBonus +
    intlBonus +
    breadthBonus -
    feePenalty;

  return Math.round(total);
}

// ─── Explanation ───────────────────────────────────────────────────────────────

/**
 * Returns a human-readable explanation of why a card was recommended.
 */
export function explainScore(card: CardRecord, input: RecommendInput): string {
  const rates = card.rewardRates as RewardRates;
  const primaryRate = getRate(rates, input.primaryCategory);
  const annualRewards = Math.round(input.totalSpend * 12 * (primaryRate / 100));

  const parts: string[] = [];

  parts.push(
    `Earns ${primaryRate}% on ${CATEGORY_LABELS[input.primaryCategory] ?? input.primaryCategory}, ` +
      `worth ~${formatInr(annualRewards)}/year on your spend`
  );

  if (card.bestFor.includes(input.lifestylePreference)) {
    parts.push(`Strong match for your preference: ${LIFESTYLE_LABELS[input.lifestylePreference] ?? input.lifestylePreference}`);
  }

  if (input.intlTravel !== 'no' && card.intlTravel) {
    parts.push('Includes international lounge access and competitive forex rates');
  }

  if (card.annualFee === 0) {
    parts.push('Lifetime free — zero annual cost');
  } else if (card.feeWaiverRule) {
    parts.push(`Annual fee waivable: ${card.feeWaiverRule}`);
  }

  return parts.join('. ') + '.';
}

// ─── Highlights ────────────────────────────────────────────────────────────────

/**
 * Returns up to 4 contextual highlights for the user's profile.
 * Prioritises the most relevant perks.
 */
export function getHighlights(card: CardRecord, input: RecommendInput): string[] {
  const rates = card.rewardRates as RewardRates;
  const highlights: string[] = [];

  // Primary rate callout
  const primaryRate = getRate(rates, input.primaryCategory);
  if (primaryRate > 0) {
    highlights.push(
      `${primaryRate}% on ${CATEGORY_LABELS[input.primaryCategory] ?? input.primaryCategory}`
    );
  }

  // Travel-specific highlights
  if (input.lifestylePreference === 'travel_perks' || input.intlTravel !== 'no') {
    if (card.intlTravel) highlights.push('International lounge access');
  }

  // Fee highlight
  if (card.annualFee === 0) {
    highlights.push('Lifetime free');
  } else if (card.feeWaiverRule) {
    highlights.push(`Fee waiver: ${card.feeWaiverRule}`);
  }

  // Top perk not already covered
  const usedHighlights = new Set(highlights.map((h) => h.toLowerCase()));
  for (const perk of card.perks) {
    const perkLower = perk.toLowerCase();
    const alreadyCovered = [...usedHighlights].some((h) => perkLower.includes(h) || h.includes(perkLower));
    if (!alreadyCovered && highlights.length < 4) {
      highlights.push(perk);
    }
  }

  return highlights.slice(0, 4);
}

// ─── Full scored card builder ──────────────────────────────────────────────────

export function buildScoredCard(
  card: CardRecord,
  input: RecommendInput,
  rank: number,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ScoredCard {
  const rates = card.rewardRates as RewardRates;
  const primaryRate = getRate(rates, input.primaryCategory);
  const estimatedAnnualRewards = Math.round(input.totalSpend * 12 * (primaryRate / 100));
  const netAnnualValue = estimatedAnnualRewards - card.annualFee + card.welcomeBonus;

  return {
    card,
    score: scoreCard(card, input, weights),
    rank,
    explanation: explainScore(card, input),
    estimatedAnnualRewards,
    netAnnualValue,
    primaryRate,
    highlights: getHighlights(card, input),
  };
}
