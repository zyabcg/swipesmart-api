// ─── Shared TypeScript types used across the entire API ───────────────────────

export interface RewardRates {
  travel: number;
  dining: number;
  online: number;
  groceries: number;
  fuel: number;
  utility: number;
  default: number;
}

export type SpendCategory = 'groceries' | 'dining' | 'travel' | 'online' | 'fuel' | 'utility';
export type PrimaryCategory = SpendCategory | 'everything';
export type LifestylePreference = 'travel_perks' | 'cashback' | 'rewards_points' | 'low_fee';
export type IntlTravelFrequency = 'no' | 'occasionally' | 'frequently';

export interface CardRecord {
  id: string;
  slug: string;
  name: string;
  bank: string;
  network: string;
  annualFee: number;
  feeWaiverRule: string | null;
  minIncome: number;
  rewardRates: RewardRates;
  perks: string[];
  bestFor: string[];
  categories: string[];
  intlTravel: boolean;
  welcomeBonus: number;
  isActive: boolean;
  isInviteOnly: boolean;
  imageUrl: string | null;
  applyUrl: string | null;
  /** Incremented on every admin reward-rate or fee update. Used by alert system. */
  version: number;
}

// ─── Card Devaluation Alert types ─────────────────────────────────────────────

export interface CardChange {
  field: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
  oldValue: unknown;
  newValue: unknown;
}

export interface DevaluationAlert {
  id: string;
  cardSlug: string;
  card: string;
  change: string;
  impact: number;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export interface MonthlySpend {
  groceries?: number;
  dining?: number;
  travel?: number;
  online?: number;
  fuel?: number;
  utility?: number;
}

export interface OptimizeInput {
  selectedCards: string[]; // card slugs
  monthlySpend: MonthlySpend;
}

export interface RecommendInput {
  income: number;
  totalSpend: number;
  primaryCategory: PrimaryCategory;
  lifestylePreference: LifestylePreference;
  maxFee: number;
  intlTravel: IntlTravelFrequency;
}

export interface ScoringWeights {
  annualRewardMultiplier: number;
  welcomeBonusMultiplier: number;
  lifestyleBonus: number;
  intlTravelBonusFrequent: number;
  intlTravelBonusOccasional: number;
  annualFeeMultiplier: number;
  categoryBreadthWeight: number;
}

export interface ScoredCard {
  card: CardRecord;
  score: number;
  rank: number;
  explanation: string;
  estimatedAnnualRewards: number;
  netAnnualValue: number;
  primaryRate: number;
  highlights: string[];
}

export interface CategoryOptimization {
  card: CardRecord;
  rate: number;
  monthlySpend: number;
  monthlyReward: number;
  annualReward: number;
}

export interface OptimizationResult {
  bestPerCategory: Record<string, CategoryOptimization>;
  totalOptimizedAnnualRewards: number;
  totalBaselineAnnualRewards: number;
  optimizationDelta: number;
  tips: string[];
}

// ─── Card Stack Strategy types ────────────────────────────────────────────────

export interface StrategyItem {
  category: string;
  /** Human-readable UX label e.g. "Best for Travel" */
  label: string;
  card: string;
  bank: string;
  rewardRate: number;
  /** Short explanation of why this card wins for this category */
  reason: string;
  annualReward: number;
}

export interface CardStackStrategy {
  totalCardsUsed: number;
  strategy: StrategyItem[];
  annualRewards: number;
  tips: string[];
}

export interface Cheatsheet {
  title: string;
  summary: string;
  /** One line per category: "Travel → Axis Atlas" */
  items: string[];
  /** Printable plain-text version of the full cheatsheet */
  text: string;
}

export interface LossBreakdownItem {
  category: string;
  current: number;    // annual reward using user's best card for this category
  optimal: number;    // annual reward using the best card in the entire DB
  loss: number;       // optimal - current
}

export interface OpportunityLossResult {
  currentRewards: number;   // total annual rewards with user's optimised card stack
  optimalRewards: number;   // total annual rewards with the best possible card for every category
  opportunityLoss: number;  // optimalRewards - currentRewards
  monthlyLoss: number;      // opportunityLoss / 12
  breakdown: LossBreakdownItem[];
  lossMessage: string;
}

export interface SessionData {
  id: string;
  sessionId: string;
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  alertsEnabled: boolean;
  isPremium: boolean;
}

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: string;
  details?: unknown;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// Augment Fastify request with session
declare module 'fastify' {
  interface FastifyRequest {
    sessionData: SessionData;
  }
}
