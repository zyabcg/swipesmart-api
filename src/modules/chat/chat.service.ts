/**
 * Chat service — logic-first, AI-last conversational recommendations.
 *
 * Request flow
 * ─────────────────────────────────────────────────────────────────────
 *
 *   User message
 *        │
 *   detectIntent()          ← pure keyword matching, zero cost
 *        │
 *   ┌────┴──────────────────────────────────────────────────────────┐
 *   │ "calculation"                  │ "explanation"/"general_question"
 *   │                                │
 *   │ extractContext()               │ computeTopCards() (if context)
 *   │ hasEnoughContext?              │        │
 *   │  yes → scoring.engine         │  generateExplanationTemplate()
 *   │  no  → ask for more info      │   match? ──→ return (0 API calls)
 *   │                               │        │
 *   │                               │  matchFAQ()
 *   │                               │   match? ──→ return (0 API calls)
 *   │                               │        │
 *   │                               │  Redis cache check
 *   │                               │   hit ──→ return (0 API calls)
 *   │                               │        │
 *   │                               │  checkAndIncrementAIUsage()
 *   │                               │   blocked? ──→ return fallback
 *   │                               │        │
 *   │                               │  Claude API call
 *   │                               │   └──→ cache result in Redis
 *
 * Cost controls
 * ─────────────────────────────────────────────────────────────────────
 *  • ~50–60% of messages resolve via calculation path (no Claude)
 *  • Template engine handles "why/explain/compare" without Claude
 *  • FAQ layer handles ~15 common questions without Claude
 *  • AI responses cached in Redis for CHAT_CACHE_TTL seconds (default 1hr)
 *  • Per-session AI limit: 3 Claude calls per 24h (silent enforcement)
 *  • Claude prompt contains only top-3 cards, not all 36
 *  • max_tokens reduced from 1024 → 512 (explanations are short)
 */

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../lib/prisma';
import { redis, getJson, setJson, KEYS } from '../../lib/redis';
import { getAllCards } from '../cards/cards.service';
import { scoreCard, buildScoredCard, DEFAULT_WEIGHTS } from '../recommendation/scoring.engine';
import { track } from '../analytics/analytics.service';
import { env } from '../../config/env';
import type { CardRecord, RecommendInput, ScoredCard, RewardRates } from '../../types';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 512; // explanations don't need long responses
const AI_USAGE_LIMIT = 3; // max Claude calls per session per day
const AI_USAGE_TTL = 24 * 60 * 60; // 24 hours in seconds

// ─── Anthropic client (lazy init, unchanged) ──────────────────────────────────

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. Chat AI requires an Anthropic API key.');
    }
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// ─── Part 1: Intent detection ─────────────────────────────────────────────────
//
// Classifies a message into one of three intents WITHOUT any API call.
// Uses regex/keyword matching — O(1), deterministic, zero cost.
//
//   calculation     → route to scoring engine (no Claude)
//   explanation     → route to Claude (with cache)
//   general_question→ route to Claude (with cache)

type Intent = 'calculation' | 'explanation' | 'general_question';

/**
 * Detect what the user wants.
 *
 * Explanation patterns take priority: if the user is asking WHY, we need
 * Claude's reasoning even if numbers are present.
 *
 * Calculation patterns are matched next: any message with income/spend
 * signals + a card/recommendation ask can be resolved by the engine.
 *
 * Everything else is a general question for Claude.
 */
function detectIntent(message: string): Intent {
  const m = message.toLowerCase().trim();

  // Explanation — "why did you / why is / explain"
  const explanationPatterns: RegExp[] = [
    /why (did you|is|this|that|the)\b/,
    /explain (why|this|the|that)\b/,
    /what makes .{1,30}(good|better|best)\b/,
    /reason(s?) for\b/,
    /how (is|does) .{1,30}(better|different|compare)\b/,
    /tell me more about\b/,
  ];
  if (explanationPatterns.some((re) => re.test(m))) return 'explanation';

  // Calculation — user wants a recommendation or reward estimate
  const calculationPatterns: RegExp[] = [
    /which card\b/,
    /best card (for|to|if)\b/,
    /\brecommend (a |me |a card|cards)\b/,
    /what card\b/,
    /top card\b/,
    /how much (will|would|can|do) i (earn|get|save|make)\b/,
    /how much reward\b/,
    /compare .{1,30}(vs|versus|and) .{1,30}card\b/,
    /\bi (earn|make|have) .*?₹/,
    /₹[\d,]+ *(income|salary|spend)/,
    /my (income|salary|spending) is\b/,
    /i (spend|splurge) (about|around|roughly|approximately|on)\b/,
    /monthly (spend|spending|income|salary)\b/,
    /(travel|dining|online|groceries|fuel|utility) (card|spend|spends)\b/,
    /suggest (a |me |some )?(card|cards)\b/,
    /find (me )?(a |the )?(best |right )?(card|cards)\b/,
  ];
  if (calculationPatterns.some((re) => re.test(m))) return 'calculation';

  return 'general_question';
}

// ─── Part 2: Context extraction ───────────────────────────────────────────────
//
// Pulls structured fields out of natural language. Extends (never overwrites)
// the accumulated conversation context. Called on every message so the profile
// builds up incrementally across turns.

type ConversationContext = {
  income?: number;
  totalSpend?: number;
  primaryCategory?: RecommendInput['primaryCategory'];
  lifestylePreference?: RecommendInput['lifestylePreference'];
  maxFee?: number;
  intlTravel?: RecommendInput['intlTravel'];
};

function extractContext(
  message: string,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const updated = { ...existing } as ConversationContext & Record<string, unknown>;
  const m = message.toLowerCase();

  // Monthly income — handles "75k", "75,000", "1.5 lakh", "₹80000"
  if (!updated.income) {
    const match = m.match(/(?:income|earn|salary|make)[^\d]*?([\d,]+)\s*(k|l|lakh)?/i);
    if (match) {
      let val = parseFloat(match[1].replace(/,/g, ''));
      const unit = match[2]?.toLowerCase();
      if (unit === 'lakh' || unit === 'l') val *= 100_000;
      else if (unit === 'k' || val < 1_000) val *= 1_000;
      if (val > 5_000 && val < 10_000_000) updated.income = val;
    }
  }

  // Monthly card spend
  if (!updated.totalSpend) {
    const match = m.match(/(?:spend|spending|splurge)[^\d]*?([\d,]+)\s*(k)?/i);
    if (match) {
      let val = parseFloat(match[1].replace(/,/g, ''));
      if (match[2]?.toLowerCase() === 'k' || val < 1_000) val *= 1_000;
      if (val > 500 && val < 1_000_000) updated.totalSpend = val;
    }
  }

  // Primary spend category
  if (!updated.primaryCategory) {
    if (/\btravel\b/.test(m)) updated.primaryCategory = 'travel';
    else if (/\bdining|restaurant|food delivery|eating out\b/.test(m)) updated.primaryCategory = 'dining';
    else if (/\bonline|shopping|amazon|flipkart|ecommerce\b/.test(m)) updated.primaryCategory = 'online';
    else if (/\bgroceries|grocery|supermarket|bigbasket\b/.test(m)) updated.primaryCategory = 'groceries';
    else if (/\bfuel|petrol|diesel\b/.test(m)) updated.primaryCategory = 'fuel';
    else if (/\butility|utilities|electricity|bills\b/.test(m)) updated.primaryCategory = 'utility';
    else if (/\beverything equally|all categories|evenly spread\b/.test(m)) updated.primaryCategory = 'everything';
  }

  // Lifestyle preference
  if (!updated.lifestylePreference) {
    if (/\blounge|airport lounge|travel perks|miles|points.*transfer\b/.test(m)) updated.lifestylePreference = 'travel_perks';
    else if (/\bcashback|cash back\b/.test(m)) updated.lifestylePreference = 'cashback';
    else if (/\breward points?|points.*redeem\b/.test(m)) updated.lifestylePreference = 'rewards_points';
    else if (/\bno fee|zero fee|free card|low fee|lifetime free\b/.test(m)) updated.lifestylePreference = 'low_fee';
  }

  // Max annual fee willing to pay
  if (updated.maxFee === undefined) {
    if (/\bno fee|zero fee|free card|lifetime free\b/.test(m)) {
      updated.maxFee = 0;
    } else {
      const feeMatch = m.match(/(?:fee|annual fee|pay up to|max.*fee)[^\d]*?([\d,]+)/i);
      if (feeMatch) {
        const val = parseFloat(feeMatch[1].replace(/,/g, ''));
        if (val >= 0 && val <= 50_000) updated.maxFee = val;
      }
    }
  }

  // International travel frequency
  if (!updated.intlTravel) {
    if (/\bfrequently|often|regularly|multiple times.*year|every.*month.*abroad\b/.test(m))
      updated.intlTravel = 'frequently';
    else if (/\boccasionally|sometimes|once.*year|twice.*year|1.?2.*year\b/.test(m))
      updated.intlTravel = 'occasionally';
    else if (/\bno international|don.?t travel abroad|domestic only|no.*abroad\b/.test(m))
      updated.intlTravel = 'no';
  }

  return updated;
}

/** Minimum viable context: income + spend + category are enough to score cards. */
function hasEnoughContext(ctx: Record<string, unknown>): boolean {
  return (
    typeof ctx.income === 'number' &&
    typeof ctx.totalSpend === 'number' &&
    typeof ctx.primaryCategory === 'string'
  );
}

/** Build a RecommendInput from context, filling optional fields with safe defaults. */
function toRecommendInput(ctx: Record<string, unknown>): RecommendInput {
  return {
    income: ctx.income as number,
    totalSpend: ctx.totalSpend as number,
    primaryCategory: ctx.primaryCategory as RecommendInput['primaryCategory'],
    lifestylePreference: (ctx.lifestylePreference as RecommendInput['lifestylePreference']) ?? 'cashback',
    maxFee: typeof ctx.maxFee === 'number' ? ctx.maxFee : 99_999,
    intlTravel: (ctx.intlTravel as RecommendInput['intlTravel']) ?? 'no',
  };
}

// ─── Part 3: Internal recommendation helper ───────────────────────────────────
//
// Runs the scoring engine directly — no DB side-effects, no session tracking.
// Used only within chat to compute cards for display or to build Claude context.

async function computeTopCards(input: RecommendInput, limit = 3): Promise<ScoredCard[]> {
  const cards = await getAllCards({ isActive: true });
  const scored = cards
    .map((card) => ({ card, score: scoreCard(card, input, DEFAULT_WEIGHTS) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x, i) => buildScoredCard(x.card, input, i + 1, DEFAULT_WEIGHTS));
}

// ─── Part 4: Logic-path response formatters ───────────────────────────────────
//
// Produce natural-sounding responses from structured data WITHOUT Claude.

const CATEGORY_LABELS: Record<string, string> = {
  travel: 'travel',
  dining: 'dining & food',
  online: 'online shopping',
  groceries: 'groceries',
  fuel: 'fuel',
  utility: 'utility bills',
  everything: 'all categories',
};

function formatRecommendationResponse(recs: ScoredCard[], input: RecommendInput): string {
  if (recs.length === 0) {
    return (
      "I couldn't find any cards matching your criteria. " +
      'Try a higher annual fee limit or check if your income meets the card minimums.'
    );
  }

  const top = recs[0];
  const catLabel = CATEGORY_LABELS[input.primaryCategory] ?? input.primaryCategory;
  const lines: string[] = [
    `Your best match is the **${top.card.name}** by **${top.card.bank}**.`,
    '',
    `• Estimated annual value: **₹${top.netAnnualValue.toLocaleString('en-IN')}**`,
    `• ${top.primaryRate}% on ${catLabel}`,
    `• Annual fee: ₹${top.card.annualFee.toLocaleString('en-IN')}${
      top.card.feeWaiverRule ? ` (${top.card.feeWaiverRule})` : ''
    }`,
  ];

  if (top.card.intlTravel && input.intlTravel !== 'no') {
    lines.push('• International lounge access included');
  }

  if (recs.length > 1) {
    const runners = recs
      .slice(1, 3)
      .map((r) => `**${r.card.name}** (${r.card.bank}, ₹${r.netAnnualValue.toLocaleString('en-IN')}/yr)`)
      .join(' and ');
    lines.push('', `Other strong options: ${runners}.`);
  }

  lines.push('', 'Want me to explain why this card scored highest, or compare specific options?');
  return lines.join('\n');
}

function formatMissingInfoPrompt(ctx: Record<string, unknown>): string {
  const missing: string[] = [];
  if (!ctx.income) missing.push('your approximate **monthly income**');
  if (!ctx.totalSpend) missing.push('your **monthly credit card spend**');
  if (!ctx.primaryCategory) missing.push('**what you spend the most on** (travel, dining, online shopping, etc.)');

  return (
    `To find the best card for you I need a couple more details:\n\n` +
    missing.map((m) => `• ${m}`).join('\n') +
    `\n\nFeel free to share them together — e.g. *"I earn ₹80k/month, spend ₹25k mostly on travel."*`
  );
}

// ─── Part 5: Template engine ──────────────────────────────────────────────────
//
// Generates a structured natural-language response for explanation-type questions
// when we already have pre-computed card data. Zero API cost.
//
// Returns null if the message doesn't match a known explanation pattern or if
// there are no cards to reason about.

function generateExplanationTemplate(
  message: string,
  context: Record<string, unknown>,
  topCards: ScoredCard[]
): string | null {
  if (topCards.length === 0) return null;

  const m = message.toLowerCase();
  const top = topCards[0];
  const catLabel = CATEGORY_LABELS[context.primaryCategory as string] ?? (context.primaryCategory as string) ?? 'your primary category';

  // "why did you recommend / why is [card] the best / explain why"
  if (
    /why (did you|is|this|that|the)\b/.test(m) ||
    /explain (why|this|the|that)\b/.test(m) ||
    /reason(s?) for\b/.test(m)
  ) {
    const lines: string[] = [
      `**${top.card.name}** (${top.card.bank}) scores highest for your profile because:`,
      '',
      `• **${top.primaryRate}% rewards** on ${catLabel} — your primary spend category`,
    ];

    if (typeof context.totalSpend === 'number') {
      const annual = Math.round(((context.totalSpend as number) * top.primaryRate) / 100 * 12);
      lines.push(`• At ₹${(context.totalSpend as number).toLocaleString('en-IN')}/month spend, that's ~₹${annual.toLocaleString('en-IN')}/year in rewards`);
    }

    if (top.card.annualFee === 0) {
      lines.push('• Zero annual fee — no cost to hold');
    } else if (top.card.feeWaiverRule) {
      lines.push(`• Annual fee of ₹${top.card.annualFee.toLocaleString('en-IN')} is waived if ${top.card.feeWaiverRule}`);
    } else {
      lines.push(`• Annual fee: ₹${top.card.annualFee.toLocaleString('en-IN')}`);
    }

    if (top.card.perks.length > 0) {
      lines.push(`• Standout perk: ${top.card.perks[0]}`);
    }

    if (topCards.length > 1) {
      const second = topCards[1];
      const feeNote = second.card.annualFee === 0 ? 'zero annual fee' : `₹${second.card.annualFee.toLocaleString('en-IN')} fee`;
      lines.push('', `Runner-up: **${second.card.name}** (${second.card.bank}) at ${second.primaryRate}% on ${catLabel} — ${feeNote}.`);
    }

    return lines.join('\n');
  }

  // "what makes [card] good/better/best" / "tell me more about"
  if (
    /what makes .{1,30}(good|better|best)\b/.test(m) ||
    /tell me more about\b/.test(m)
  ) {
    const lines: string[] = [
      `Here's what makes **${top.card.name}** the top pick for you:`,
      '',
      `• **Primary rate:** ${top.primaryRate}% on ${catLabel}`,
      `• **Annual fee:** ₹${top.card.annualFee.toLocaleString('en-IN')}${top.card.feeWaiverRule ? ` (waived: ${top.card.feeWaiverRule})` : ''}`,
      `• **Est. net value:** ₹${top.netAnnualValue.toLocaleString('en-IN')}/year`,
    ];

    if (top.card.perks.length > 0) {
      lines.push(`• **Perks:** ${top.card.perks.slice(0, 3).join(', ')}`);
    }
    if (top.card.intlTravel) {
      lines.push('• Includes international travel/lounge benefits');
    }

    return lines.join('\n');
  }

  // "how does [card] compare / compare X vs Y"
  if (
    /how (is|does) .{1,30}(better|different|compare)\b/.test(m) ||
    /compare .{1,30}(vs|versus|and)\b/.test(m)
  ) {
    if (topCards.length < 2) return null;
    const second = topCards[1];
    return [
      `**${top.card.name}** vs **${second.card.name}** for your profile:`,
      '',
      `| | ${top.card.name} | ${second.card.name} |`,
      `|---|---|---|`,
      `| Rate on ${catLabel} | ${top.primaryRate}% | ${second.primaryRate}% |`,
      `| Annual fee | ₹${top.card.annualFee.toLocaleString('en-IN')} | ₹${second.card.annualFee.toLocaleString('en-IN')} |`,
      `| Est. net value | ₹${top.netAnnualValue.toLocaleString('en-IN')}/yr | ₹${second.netAnnualValue.toLocaleString('en-IN')}/yr |`,
      '',
      `**${top.card.name}** wins on net annual value for your spend profile.`,
    ].join('\n');
  }

  return null;
}

// ─── Part 6: FAQ layer ────────────────────────────────────────────────────────
//
// Keyword-matched answers for ~15 common credit card questions.
// Zero API cost — pure string matching, instant response.

interface FAQEntry {
  keywords: RegExp[];
  answer: string;
}

const FAQ_MAP: FAQEntry[] = [
  {
    keywords: [/what is (a )?lounge access\b/, /airport lounge\b/, /how does lounge access work\b/],
    answer:
      '**Airport lounge access** lets you relax in premium airport lounges while waiting for your flight — free of charge. Premium cards (Axis Atlas, HDFC Regalia, Amex Platinum) include complimentary visits, typically 4–12 free visits/year. Some cards also cover a complimentary guest.',
  },
  {
    keywords: [/what is forex markup\b/, /foreign transaction fee\b/, /forex fee\b/, /international transaction fee\b/],
    answer:
      '**Forex markup** is a % surcharge applied when you pay in a foreign currency — typically 1.5–3.5% on Indian cards. Cards like IDFC WOW, Niyo Global, and Scapia offer zero forex markup, making them ideal for international travel.',
  },
  {
    keywords: [/what is (a )?credit score\b/, /how does (a )?credit score work\b/, /cibil score\b/],
    answer:
      'Your **CIBIL/credit score** (300–900) reflects your creditworthiness. Scores above 750 unlock premium cards. Key factors: payment history (35%), credit utilization (30%), credit history length (15%), credit mix (10%), new inquiries (10%). Pay on time and keep utilization under 30%.',
  },
  {
    keywords: [/what (are|is) (a )?reward points?\b/, /how do reward points work\b/, /how to redeem (reward )?points\b/],
    answer:
      '**Reward points** are earned on every transaction — typically 1–10 points per ₹100 spent. They can be redeemed for cashback, flight miles, gift vouchers, or statement credit. Always check the redemption ratio: 1 point = ₹0.25 vs ₹1 is a 4× difference in value.',
  },
  {
    keywords: [/what is (a )?joining fee\b/, /what is (an )?annual fee\b/, /annual fee waiver\b/, /fee waiver rule\b/],
    answer:
      '**Annual fee** is a yearly charge for holding a card, typically ₹500–₹10,000. Most cards waive it if you spend above a threshold (e.g., ₹1.5L/year). A higher-fee card often gives better rewards than a "free" one — check if you\'ll cross the waiver spend anyway.',
  },
  {
    keywords: [/what is cashback\b/, /how does cashback work\b/, /cashback vs reward points\b/],
    answer:
      '**Cashback** is a direct % of your spend credited back — simpler than reward points with no expiry or redemption friction. SBI Cashback (5% online), HDFC Millennia (5% online), and HSBC Live+ (10% on top categories) lead this segment.',
  },
  {
    keywords: [/what is (a )?fuel surcharge waiver\b/, /fuel surcharge\b/],
    answer:
      '**Fuel surcharge** is a 1% fee on fuel transactions. Most cards offer a **waiver** on fills between ₹400–₹5,000, saving you 1% every time. At ₹3,000/month on fuel that\'s ₹360/year — small but free money.',
  },
  {
    keywords: [/how many credit cards should i have\b/, /how many cards (should|can) i (have|hold)\b/],
    answer:
      'Most people benefit from **2–3 cards**: one for your primary category (travel/cashback), one for everyday spends, and optionally a co-branded card (Amazon, Swiggy, etc.). A two-card strategy covers ~80% of spend categories at optimal reward rates.',
  },
  {
    keywords: [/what is (a )?credit limit\b/, /how is credit limit determined\b/, /how to increase credit limit\b/],
    answer:
      'Your **credit limit** is the maximum you can charge. Banks set it based on income, existing obligations, and credit score. To increase it: use the card regularly, pay in full on time, and request a review after 6–12 months. Keep utilization under 30% to also protect your credit score.',
  },
  {
    keywords: [/what is (the )?minimum due\b/, /minimum payment\b/, /what happens if i only pay minimum\b/],
    answer:
      '**Minimum due** (usually 5% of outstanding) is the least to avoid a late fee. Paying only the minimum means the remainder accrues **3–4% monthly interest** (~40%+ APR). Always pay the **full amount** — interest erases every reward you earn.',
  },
  {
    keywords: [/what is (a )?balance transfer\b/, /balance transfer credit card\b/],
    answer:
      '**Balance transfer** moves outstanding debt from one card to another at a lower introductory rate (sometimes 0% for 3–6 months vs 3.5% normal). Useful for clearing high-interest debt — but watch the transfer fee (1–2%) and the rate after the intro period ends.',
  },
  {
    keywords: [/best card (for|on) amazon\b/, /which card (for|on) amazon\b/, /amazon (pay )?card\b/],
    answer:
      'For Amazon: **Amazon Pay ICICI** (5% back for Prime, 3% others — lifetime free), **HDFC Millennia** (5% on all online), and **SBI Cashback** (5% all online). Amazon Pay ICICI is the clear winner for Prime members — cashback is instant, no redemption needed.',
  },
  {
    keywords: [/best card (for|on) (swiggy|zomato|food delivery)\b/, /best (dining|food) card\b/],
    answer:
      'For food delivery: **HDFC Swiggy Card** (10% on Swiggy, 5% elsewhere — ₹500 fee), **HSBC Live+** (10% on top 3 categories including dining — ₹999 fee, waived at ₹2L spend). For restaurants generally: Axis Magnus or HDFC Infinia for premium dining perks.',
  },
  {
    keywords: [/what is (a )?(lifetime free|ltf) card\b/, /lifetime free credit card\b/],
    answer:
      '**Lifetime Free (LTF)** cards have zero joining and annual fee — forever, no waiver condition needed. Great picks: Amazon Pay ICICI, HDFC Millennia (LTF variant), SBI SimplyCLICK, and Axis ACE. They\'re not "free" in terms of rewards though — evaluate the reward rates vs. paid alternatives.',
  },
  {
    keywords: [/what is (a )?co.?branded card\b/, /what are co.?branded cards\b/],
    answer:
      '**Co-branded cards** are issued jointly by a bank and a merchant (e.g., Amazon-ICICI, Swiggy-HDFC, Flipkart-Axis). They offer elevated rewards on that specific platform — 5–10% vs the usual 1–2%. Best added on top of a general cashback/rewards card, not as a replacement.',
  },
];

/**
 * Returns a pre-written FAQ answer if the message matches a known question.
 * Returns null if no match — caller should proceed to AI.
 */
function matchFAQ(message: string): string | null {
  const m = message.toLowerCase().trim();
  for (const entry of FAQ_MAP) {
    if (entry.keywords.some((re) => re.test(m))) {
      return entry.answer;
    }
  }
  return null;
}

// ─── Part 7: Per-session AI usage limiter ─────────────────────────────────────
//
// Tracks how many times Claude has been called in this session using Redis INCR.
// Limit: AI_USAGE_LIMIT calls per AI_USAGE_TTL window (default: 3 calls / 24h).
//
// Uses conversation.sessionId (the DB session CUID) as the Redis key.
// Redis unavailability always returns { allowed: true } — never block users due
// to a Redis outage.

async function checkAndIncrementAIUsage(
  sessionId: string
): Promise<{ allowed: boolean; count: number }> {
  try {
    const key = KEYS.aiUsage(sessionId);
    const count = await redis.incr(key);
    if (count === 1) {
      // First use this window — set TTL on the freshly created key
      await redis.expire(key, AI_USAGE_TTL);
    }
    return { allowed: count <= AI_USAGE_LIMIT, count };
  } catch {
    // Redis unavailable — degrade gracefully, let the AI call through
    return { allowed: true, count: 0 };
  }
}

// ─── Part 8: Redis cache for AI responses ─────────────────────────────────────
//
// Key = SHA-256( normalizedMessage | sortedContextJSON )
//
// Why include context in the key?
//   Different user profiles need different answers ("why this card?" for a
//   travel user vs a cashback user means different recommended cards).
//
// Why normalize the message?
//   "Why is this card better?" and "why is this card better?" should hit the
//   same cache entry regardless of capitalisation or extra whitespace.
//
// General questions (e.g. "what is lounge access?") have empty/stable context
// so they cache effectively across users — intended behaviour.

interface CachedAIEntry {
  message: string;
  cachedAt: number; // epoch ms, useful for debugging / cache auditing
}

function buildCacheKey(message: string, context: Record<string, unknown>): string {
  const normalizedMsg = message.toLowerCase().trim().replace(/\s+/g, ' ');
  // Sort keys for a stable JSON representation regardless of insertion order
  const contextStr = JSON.stringify(context, Object.keys(context).sort());
  const hash = crypto
    .createHash('sha256')
    .update(normalizedMsg + '|' + contextStr)
    .digest('hex');
  return KEYS.chatResponse(hash);
}

async function readFromCache(key: string): Promise<string | null> {
  try {
    const entry = await getJson<CachedAIEntry>(key);
    return entry?.message ?? null;
  } catch {
    // Redis is unavailable — degrade gracefully, don't crash the request
    return null;
  }
}

async function writeToCache(key: string, message: string): Promise<void> {
  try {
    await setJson<CachedAIEntry>(key, { message, cachedAt: Date.now() }, env.CHAT_CACHE_TTL);
  } catch {
    // Redis write failure — log nothing (fire-and-forget), request still succeeds
  }
}

// ─── Part 9: AI prompt builder ────────────────────────────────────────────────
//
// Returns a structured { system, userMessage } pair for Claude.
// The system prompt is fully templated — no raw JSON, no generic filler.
// The user message wraps the original query so Claude receives it in context.
//
// Replaces the old buildOptimizedSystemPrompt() which sent raw JSON and had no
// output-format guidance. New prompt is ~same token count but far more targeted.

interface AIPrompt {
  system: string;
  userMessage: string;
}

/** Format user context into a readable one-liner for the system prompt. */
function formatProfileSummary(context: Record<string, unknown>): string {
  if (Object.keys(context).length === 0) {
    return 'Profile incomplete — income, monthly spend, and primary category not yet provided.';
  }
  const parts: string[] = [];
  if (typeof context.income === 'number')
    parts.push(`monthly income ₹${(context.income as number).toLocaleString('en-IN')}`);
  if (typeof context.totalSpend === 'number')
    parts.push(`spends ₹${(context.totalSpend as number).toLocaleString('en-IN')}/month`);
  if (typeof context.primaryCategory === 'string')
    parts.push(`primary category: ${CATEGORY_LABELS[context.primaryCategory] ?? context.primaryCategory}`);
  if (typeof context.lifestylePreference === 'string')
    parts.push(`prefers ${context.lifestylePreference.replace('_', ' ')}`);
  if (typeof context.maxFee === 'number')
    parts.push(context.maxFee === 0 ? 'wants zero annual fee' : `max fee ₹${(context.maxFee as number).toLocaleString('en-IN')}`);
  if (typeof context.intlTravel === 'string' && context.intlTravel !== 'no')
    parts.push(`travels internationally ${context.intlTravel}`);
  return parts.length > 0 ? parts.join(', ') : 'Profile incomplete.';
}

/** Format top cards as a numbered list with key rates and fee details. */
function formatTopCards(topCards: ScoredCard[]): string {
  if (topCards.length === 0) return 'Not yet computed — need more profile data.';
  return topCards
    .slice(0, 3)
    .map(
      (r, i) =>
        `${i + 1}. ${r.card.name} (${r.card.bank}) — ` +
        `${r.primaryRate}% on ${r.card.categories.slice(0, 2).join('/')}, ` +
        `fee ₹${r.card.annualFee.toLocaleString('en-IN')}` +
        `${r.card.feeWaiverRule ? ` (waived: ${r.card.feeWaiverRule})` : ''}, ` +
        `perks: ${r.card.perks.slice(0, 2).join('; ')}`
    )
    .join('\n');
}

/** Format estimated annual reward values per card. */
function formatExpectedRewards(topCards: ScoredCard[]): string {
  if (topCards.length === 0) return 'Not yet computed.';
  return topCards
    .slice(0, 3)
    .map((r) => `${r.card.name}: ₹${r.netAnnualValue.toLocaleString('en-IN')}/year net`)
    .join(', ');
}

/**
 * Build the personalized AI prompt for Claude.
 *
 * @returns system  — structured system prompt with profile, cards, and format rules
 * @returns userMessage — the original query wrapped for Claude's user turn
 */
function buildAIPrompt(
  context: Record<string, unknown>,
  topCards: ScoredCard[] | null,
  originalMessage: string
): AIPrompt {
  const userProfileSummary = formatProfileSummary(context);
  const topCardsStr = formatTopCards(topCards ?? []);
  const expectedRewards = formatExpectedRewards(topCards ?? []);

  const system = `You are SwipeSense — a smart credit card advisor for Indian users.

Your role is to explain recommendations clearly, using the user's spending habits and financial context.

---

USER PROFILE:
${userProfileSummary}

TOP CARDS:
${topCardsStr}

EXPECTED VALUE:
${expectedRewards}

---

INSTRUCTIONS:

1. Start with a personalized one-line insight about the user.
2. Clearly recommend the best card.
3. Explain WHY using specific numbers:
   - reward %
   - categories
   - estimated annual rewards
4. Briefly mention 1 alternative (if relevant).
5. Give 1 actionable optimization tip.
6. Keep tone:
   - confident
   - simple
   - human (not robotic)
7. Keep response under 100 words.
8. Avoid generic phrases like "it depends".

---

OUTPUT FORMAT:

[Personalized insight]

• [Main reason with numbers]
• [Second benefit]
• [Optional comparison]

💡 [1 actionable tip]

Make it feel like expert advice, not AI output.`;

  const userMessage = `The user asked:\n"${originalMessage}"\n\nRespond using the instructions above.`;

  return { system, userMessage };
}

// ─── Part 7: Analytics helper ─────────────────────────────────────────────────
//
// Fire-and-forget — never blocks the response path.
// We don't pass sessionId here because conversation.sessionId is the DB row id,
// not the cookie session id. Events are still recorded; they just won't have a
// session association.

function fireAnalytics(event: string): void {
  track({ event, page: '/chat' }).catch(() => {});
}

// ─── Conversation management (unchanged public API) ───────────────────────────

export async function createConversation(sessionId: string): Promise<string> {
  const session = await prisma.session.findUnique({ where: { sessionId } });
  if (!session) throw new Error('Session not found');
  const conversation = await prisma.chatConversation.create({
    data: { sessionId: session.id, context: {} },
  });
  return conversation.id;
}

export async function getConversation(conversationId: string) {
  return prisma.chatConversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function resetConversation(conversationId: string): Promise<void> {
  await prisma.chatMessage.deleteMany({ where: { conversationId } });
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { context: {} },
  });
}

// ─── Updated response type ────────────────────────────────────────────────────
//
// Extends the original type with two new fields:
//   source  — "logic" if answered by the backend engine, "ai" if Claude was used
//   cached  — true if the response was served from Redis (no API call this request)
//
// The route handler passes this object through as-is, so the frontend receives
// the extra fields without any changes to chat.routes.ts.

export interface ChatResponse {
  conversationId: string;
  message: string;
  role: 'assistant';
  /** How the response was generated */
  source: 'logic' | 'template' | 'faq' | 'ai';
  /** true if the response was served from Redis (no API call this request) */
  cached: boolean;
  /** true only when Claude was actually invoked this request */
  aiUsed: boolean;
}

// ─── Main chat function ────────────────────────────────────────────────────────

export async function chat(
  conversationId: string,
  userMessage: string
): Promise<ChatResponse> {
  // ── Load conversation ──────────────────────────────────────────────────────
  const conversation = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conversation) throw new Error('Conversation not found');

  // Persist user message immediately so it appears in history on refresh
  await prisma.chatMessage.create({
    data: { conversationId, role: 'user', content: userMessage },
  });

  const existingContext = (conversation.context as Record<string, unknown> | null) ?? {};

  // ── Step 1: Classify intent — free, no API call ────────────────────────────
  const intent = detectIntent(userMessage);

  // ── Step 2: Extend context from this message ──────────────────────────────
  const updatedContext = extractContext(userMessage, existingContext);
  const contextChanged = JSON.stringify(updatedContext) !== JSON.stringify(existingContext);

  let responseMessage: string;
  let source: ChatResponse['source'];
  let cached = false;
  let aiUsed = false;

  // ── Step 3: Route by intent ────────────────────────────────────────────────

  if (intent === 'calculation') {
    //
    // LOGIC PATH — scoring engine only, zero AI cost
    //
    if (hasEnoughContext(updatedContext)) {
      const input = toRecommendInput(updatedContext);
      const recs = await computeTopCards(input, 3);
      responseMessage = formatRecommendationResponse(recs, input);
    } else {
      responseMessage = formatMissingInfoPrompt(updatedContext);
    }
    source = 'logic';
    fireAnalytics('ai_skipped');

  } else {
    //
    // NON-CALCULATION PATH — try layers in strict order before reaching Claude
    //

    // Pre-compute top cards once (used by template layer + Claude prompt)
    let topCards: ScoredCard[] | null = null;
    if (hasEnoughContext(updatedContext)) {
      topCards = await computeTopCards(toRecommendInput(updatedContext), 3);
    }

    // ── Layer 1: Template engine ──────────────────────────────────────────
    const templateResponse = topCards
      ? generateExplanationTemplate(userMessage, updatedContext, topCards)
      : null;

    if (templateResponse !== null) {
      responseMessage = templateResponse;
      source = 'template';
      fireAnalytics('ai_skipped');

    } else {
      // ── Layer 2: FAQ ────────────────────────────────────────────────────
      const faqResponse = matchFAQ(userMessage);

      if (faqResponse !== null) {
        responseMessage = faqResponse;
        source = 'faq';
        fireAnalytics('ai_skipped');

      } else {
        // ── Layer 3: Redis cache ──────────────────────────────────────────
        const cacheKey = buildCacheKey(userMessage, updatedContext);
        const cachedMessage = await readFromCache(cacheKey);

        if (cachedMessage !== null) {
          responseMessage = cachedMessage;
          cached = true;
          source = 'ai';
          fireAnalytics('ai_cache_hit');

        } else {
          // ── Layer 4: AI usage limit check ───────────────────────────────
          fireAnalytics('ai_cache_miss');
          const usage = await checkAndIncrementAIUsage(conversation.sessionId);

          if (!usage.allowed) {
            responseMessage =
              "You've reached the limit for AI insights in this session. " +
              'You can still use all core features like card optimization and recommendations.';
            source = 'ai';
            fireAnalytics('ai_blocked');

          } else {
            // ── Layer 5: Claude ───────────────────────────────────────────
            const { system: systemPrompt, userMessage: formattedUserMessage } =
              buildAIPrompt(updatedContext, topCards, userMessage);

            // Conversation history (previous turns) + personalized user turn
            const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
              ...conversation.messages.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
              })),
              { role: 'user' as const, content: formattedUserMessage },
            ];

            let claudeResponse: string;
            try {
              const client = getClient();
              const response = await client.messages.create({
                model: MODEL,
                max_tokens: MAX_TOKENS,
                system: systemPrompt,
                messages: history,
              });
              claudeResponse = response.content
                .filter((block) => block.type === 'text')
                .map((block) => (block as { type: 'text'; text: string }).text)
                .join('');
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              const isApiKeyError =
                errorMsg.includes('API key') || errorMsg.includes('ANTHROPIC_API_KEY');
              claudeResponse = isApiKeyError
                ? "The AI assistant isn't configured yet. Use the Card Finder form for instant results."
                : 'The AI assistant is temporarily unavailable. Please try again in a moment.';
            }

            responseMessage = claudeResponse;
            await writeToCache(cacheKey, responseMessage);
            source = 'ai';
            aiUsed = true;
            fireAnalytics('ai_called');
          }
        }
      }
    }
  }

  // ── Persist assistant response ─────────────────────────────────────────────
  await prisma.chatMessage.create({
    data: { conversationId, role: 'assistant', content: responseMessage },
  });

  // ── Persist updated context (only if it changed) ──────────────────────────
  if (contextChanged) {
    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { context: updatedContext as object },
    });
  }

  return {
    conversationId,
    message: responseMessage,
    role: 'assistant',
    source,
    cached,
    aiUsed,
  };
}
