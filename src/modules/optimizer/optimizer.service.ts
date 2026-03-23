/**
 * Optimizer service — given a user's cards and monthly spend, determines the
 * optimal card to use per spend category and calculates the gain vs using a
 * single card for everything.
 */
import { prisma } from '../../lib/prisma';
import { getCardsBySlugs } from '../cards/cards.service';
import { getAllCards } from '../cards/cards.service';
import type {
  OptimizeInput,
  OptimizationResult,
  CategoryOptimization,
  OpportunityLossResult,
  LossBreakdownItem,
  RewardRates,
  CardRecord,
  MonthlySpend,
} from '../../types';

const CATEGORY_MAP: Record<string, keyof RewardRates> = {
  grocery: 'groceries',
  groceries: 'groceries',
  dining: 'dining',
  travel: 'travel',
  online: 'online',
  fuel: 'fuel',
  utility: 'utility',
};

const CATEGORY_LABELS: Record<string, string> = {
  groceries: 'Groceries',
  dining: 'Dining',
  travel: 'Travel',
  online: 'Online Shopping',
  fuel: 'Fuel',
  utility: 'Utilities',
};

// ─── Pure reward computation (shared by optimize + calculateOpportunityLoss) ───
//
// Given any set of cards and a monthly spend profile, returns:
//   bestPerCategory — the best card + rate + reward for each spend category
//   totalAnnualRewards — sum across all categories
//
// No DB calls, no side-effects — safe to call multiple times per request.

interface CategoryRewardResult {
  bestPerCategory: Record<string, CategoryOptimization>;
  totalAnnualRewards: number;
}

function computeCategoryRewards(
  cards: CardRecord[],
  monthlySpend: MonthlySpend
): CategoryRewardResult {
  const bestPerCategory: Record<string, CategoryOptimization> = {};
  let totalAnnualRewards = 0;

  for (const [inputCat, monthlyAmount] of Object.entries(monthlySpend)) {
    if (!monthlyAmount || monthlyAmount <= 0) continue;

    const cardCat = CATEGORY_MAP[inputCat];
    if (!cardCat) continue;

    let bestCard: CardRecord | null = null;
    let bestRate = 0;

    for (const card of cards) {
      const rates = card.rewardRates as RewardRates;
      const rate = rates[cardCat] ?? rates.default;
      if (rate > bestRate) {
        bestRate = rate;
        bestCard = card;
      }
    }

    if (!bestCard) continue;

    const monthlyReward = (monthlyAmount * bestRate) / 100;
    const annualReward = monthlyReward * 12;

    bestPerCategory[cardCat] = {
      card: bestCard,
      rate: bestRate,
      monthlySpend: monthlyAmount,
      monthlyReward: Math.round(monthlyReward),
      annualReward: Math.round(annualReward),
    };

    totalAnnualRewards += annualReward;
  }

  return { bestPerCategory, totalAnnualRewards };
}

// ─── Core algorithm ────────────────────────────────────────────────────────────

export async function optimize(input: OptimizeInput, sessionId: string): Promise<OptimizationResult> {
  if (input.selectedCards.length === 0) {
    throw new Error('At least one card must be selected');
  }

  const userCards = await getCardsBySlugs(input.selectedCards);
  if (userCards.length === 0) {
    throw new Error('None of the selected cards were found in the database');
  }

  const { bestPerCategory, totalAnnualRewards: totalOptimizedAnnualRewards } =
    computeCategoryRewards(userCards, input.monthlySpend);

  // Baseline: best single card used for everything
  const baselineCard = userCards.reduce<CardRecord | null>(
    (best, c) => {
      const rate = (c.rewardRates as RewardRates).default;
      return !best || rate > (best.rewardRates as RewardRates).default ? c : best;
    },
    null
  )!;

  let totalBaselineAnnualRewards = 0;
  for (const [inputCat, monthlyAmount] of Object.entries(input.monthlySpend)) {
    if (!monthlyAmount || monthlyAmount <= 0) continue;
    const cardCat = CATEGORY_MAP[inputCat];
    if (!cardCat) continue;
    const baselineRates = baselineCard.rewardRates as RewardRates;
    const baselineRate = baselineRates[cardCat] ?? baselineRates.default;
    totalBaselineAnnualRewards += (monthlyAmount * baselineRate * 12) / 100;
  }

  const optimizationDelta = Math.max(
    0,
    Math.round(totalOptimizedAnnualRewards - totalBaselineAnnualRewards)
  );

  const tips = generateTips(userCards, input, bestPerCategory);

  const result: OptimizationResult = {
    bestPerCategory,
    totalOptimizedAnnualRewards: Math.round(totalOptimizedAnnualRewards),
    totalBaselineAnnualRewards: Math.round(totalBaselineAnnualRewards),
    optimizationDelta,
    tips,
  };

  // Persist async (fire-and-forget, don't block response)
  persistOptimization(sessionId, input, result).catch(() => {});

  return result;
}

// ─── Opportunity loss calculator ───────────────────────────────────────────────
//
// Answers: "How much more could I earn if I had the best card for every category?"
//
//   currentRewards  = optimised rewards using the user's own cards
//   optimalRewards  = rewards using the single best card in the DB per category
//   opportunityLoss = optimalRewards - currentRewards
//
// No DB writes — pure compute, recomputed on every request.

export async function calculateOpportunityLoss(
  selectedCardSlugs: string[],
  monthlySpend: MonthlySpend
): Promise<OpportunityLossResult> {
  if (selectedCardSlugs.length === 0) {
    throw new Error('At least one card must be selected');
  }

  // Run both computations in parallel — independent DB/cache reads
  const [userCards, allCards] = await Promise.all([
    getCardsBySlugs(selectedCardSlugs),
    getAllCards({ isActive: true }),
  ]);

  if (userCards.length === 0) {
    throw new Error('None of the selected cards were found in the database');
  }

  const { bestPerCategory: currentByCategory, totalAnnualRewards: currentRewards } =
    computeCategoryRewards(userCards, monthlySpend);

  const { bestPerCategory: optimalByCategory, totalAnnualRewards: optimalRewards } =
    computeCategoryRewards(allCards, monthlySpend);

  // Build per-category breakdown — only include categories the user actually spends on
  const breakdown: LossBreakdownItem[] = [];

  for (const cat of Object.keys(optimalByCategory)) {
    const current = currentByCategory[cat]?.annualReward ?? 0;
    const optimal = optimalByCategory[cat].annualReward;
    breakdown.push({
      category: cat,
      current,
      optimal,
      loss: Math.max(0, optimal - current),
    });
  }

  // Sort breakdown by loss descending so the biggest leaks come first
  breakdown.sort((a, b) => b.loss - a.loss);

  const opportunityLoss = Math.max(0, Math.round(optimalRewards - currentRewards));
  const monthlyLoss = Math.round(opportunityLoss / 12);

  const lossMessage =
    opportunityLoss === 0
      ? "You're already earning the maximum rewards available for your spend profile. Your card stack is fully optimised."
      : `You're currently leaving ₹${opportunityLoss.toLocaleString('en-IN')}/year on the table.`;

  return {
    currentRewards: Math.round(currentRewards),
    optimalRewards: Math.round(optimalRewards),
    opportunityLoss,
    monthlyLoss,
    breakdown,
    lossMessage,
  };
}

// ─── Tips generator ────────────────────────────────────────────────────────────

function generateTips(
  cards: CardRecord[],
  input: OptimizeInput,
  bestPerCategory: Record<string, CategoryOptimization>
): string[] {
  const tips: string[] = [];
  const spend = input.monthlySpend;

  const hasStrongOnline = cards.some((c) => (c.rewardRates as RewardRates).online >= 5);
  const hasStrongTravel = cards.some((c) => (c.rewardRates as RewardRates).travel >= 5);
  const hasStrongDining = cards.some((c) => (c.rewardRates as RewardRates).dining >= 5);

  if (!hasStrongOnline && (spend.online ?? 0) > 3000) {
    tips.push(
      "You don't have a strong online shopping card. HDFC Millennia or SBI Cashback both give 5%+ on all online spends."
    );
  }

  if (!hasStrongTravel && (spend.travel ?? 0) > 5000) {
    tips.push(
      'Your travel spend is high but your cards offer low travel rewards. Axis Atlas (5% travel) or HDFC Regalia Gold would significantly improve returns.'
    );
  }

  if (!hasStrongDining && (spend.dining ?? 0) > 5000) {
    tips.push(
      'For dining above ₹5,000/month, consider adding HDFC Swiggy (10% on Swiggy) or HSBC Live+ (10% dining & groceries).'
    );
  }

  if ((spend.fuel ?? 0) > 3000) {
    tips.push(
      'For fuel spends above ₹3,000/month, the 1% fuel surcharge waiver alone can save ₹360/year. Look for dedicated fuel benefits.'
    );
  }

  const totalCards = input.selectedCards.length;
  if (totalCards < 2) {
    tips.push(
      'A two-card strategy — one travel-focused, one cashback-focused — typically covers 80% of spend categories at optimal rates.'
    );
  }

  // Check if any category is sub-optimal
  const subOptimalCats = Object.entries(bestPerCategory)
    .filter(([, opt]) => opt.rate < 2)
    .map(([cat]) => CATEGORY_LABELS[cat] ?? cat);

  if (subOptimalCats.length > 0) {
    tips.push(
      `Categories earning under 2%: ${subOptimalCats.join(', ')}. Adding targeted cards for these could significantly improve returns.`
    );
  }

  if (tips.length === 0) {
    tips.push(
      "Your card stack is well-optimised! Make sure you're hitting annual fee waiver thresholds on each card to keep costs zero."
    );
  }

  return tips.slice(0, 5);
}

// ─── Persistence ───────────────────────────────────────────────────────────────

async function persistOptimization(
  sessionId: string,
  input: OptimizeInput,
  result: OptimizationResult
): Promise<void> {
  const session = await prisma.session.findUnique({ where: { sessionId } });
  if (!session) return;

  await prisma.optimizationRequest.create({
    data: {
      sessionId: session.id,
      selectedCards: input.selectedCards,
      monthlySpend: input.monthlySpend as object,
      result: result as object,
    },
  });
}
