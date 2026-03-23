/**
 * Card Devaluation Alert System.
 *
 * Responsibilities:
 *   1. detectCardChanges     — pure diff of two CardRecord snapshots
 *   2. calculateUserImpact   — derives ₹ impact from a stored OptimizationResult
 *   3. generateDevaluationAlerts — finds affected sessions, writes CardAlert rows
 *   4. getAlertsForSession   — reads + marks-read alerts for a session cookie
 *
 * No optimizer logic is duplicated. Impact is calculated from the stored
 * OptimizationRequest.result JSON, which already contains per-category
 * rewards and the card slug that "won" each category.
 */
import { prisma } from '../../lib/prisma';
import { track } from '../analytics/analytics.service';
import type { CardRecord, CardChange, DevaluationAlert, RewardRates, MonthlySpend } from '../../types';

// ─── Shared labels ────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  groceries: 'Groceries',
  dining: 'Dining',
  travel: 'Travel',
  online: 'Online Shopping',
  fuel: 'Fuel',
  utility: 'Utilities',
  default: 'General',
};

// ─── 1. Change detection ──────────────────────────────────────────────────────
//
// Pure function: compares two card snapshots and returns a human-readable list
// of what changed. Called BEFORE the DB write so old values are still accessible.

export function detectCardChanges(
  oldCard: CardRecord,
  newCard: CardRecord
): CardChange[] {
  const changes: CardChange[] = [];

  // ── Reward rate changes ──────────────────────────────────────────────────
  const oldRates = oldCard.rewardRates as RewardRates;
  const newRates = newCard.rewardRates as RewardRates;
  const rateKeys: (keyof RewardRates)[] = [
    'travel', 'dining', 'online', 'groceries', 'fuel', 'utility', 'default',
  ];

  for (const cat of rateKeys) {
    if (oldRates[cat] === newRates[cat]) continue;
    const direction = newRates[cat] > oldRates[cat] ? 'increased' : 'reduced';
    const delta = Math.abs(newRates[cat] - oldRates[cat]);
    changes.push({
      field: `rewardRates.${cat}`,
      description:
        `${CATEGORY_LABELS[cat] ?? cat} reward rate ${direction} from ${oldRates[cat]}% to ${newRates[cat]}%`,
      severity: delta >= 2 ? 'high' : delta >= 1 ? 'medium' : 'low',
      oldValue: oldRates[cat],
      newValue: newRates[cat],
    });
  }

  // ── Annual fee change ────────────────────────────────────────────────────
  if (oldCard.annualFee !== newCard.annualFee) {
    const direction = newCard.annualFee > oldCard.annualFee ? 'increased' : 'reduced';
    changes.push({
      field: 'annualFee',
      description:
        `Annual fee ${direction} from ₹${oldCard.annualFee.toLocaleString('en-IN')} to ₹${newCard.annualFee.toLocaleString('en-IN')}`,
      severity: newCard.annualFee > oldCard.annualFee ? 'high' : 'low',
      oldValue: oldCard.annualFee,
      newValue: newCard.annualFee,
    });
  }

  // ── Fee waiver change ────────────────────────────────────────────────────
  if (oldCard.feeWaiverRule !== newCard.feeWaiverRule) {
    const desc = !newCard.feeWaiverRule && oldCard.feeWaiverRule
      ? 'Fee waiver removed'
      : !oldCard.feeWaiverRule && newCard.feeWaiverRule
      ? 'Fee waiver added'
      : 'Fee waiver condition changed';
    changes.push({
      field: 'feeWaiverRule',
      description: desc,
      severity: !newCard.feeWaiverRule ? 'high' : 'medium',
      oldValue: oldCard.feeWaiverRule,
      newValue: newCard.feeWaiverRule,
    });
  }

  // ── Perk removals ────────────────────────────────────────────────────────
  const removedPerks = oldCard.perks.filter((p) => !newCard.perks.includes(p));
  if (removedPerks.length > 0) {
    changes.push({
      field: 'perks',
      description: `${removedPerks.length} perk${removedPerks.length > 1 ? 's' : ''} removed: ${removedPerks.slice(0, 2).join('; ')}`,
      severity: 'medium',
      oldValue: removedPerks,
      newValue: [],
    });
  }

  return changes;
}

// ─── 2. User impact calculation ───────────────────────────────────────────────
//
// Derives the annual reward delta for a specific user's spend profile using
// the stored OptimizationRequest.result — no re-running of optimizer needed.
//
// Logic:
//   For each category where this card was the winning card in the stored result,
//   compute old rewards (old rate) vs new rewards (new rate). Sum the deltas.
//
// Impact is negative when the card was devalued (user loses money).

interface StoredCategoryOptimization {
  card: { slug: string };
  rate: number;
  monthlySpend: number;
  annualReward: number;
}

interface StoredOptimizationResult {
  bestPerCategory: Record<string, StoredCategoryOptimization>;
}

function calculateUserImpact(
  oldCard: CardRecord,
  newCard: CardRecord,
  storedResult: StoredOptimizationResult,
  monthlySpend: MonthlySpend
): number {
  const oldRates = oldCard.rewardRates as RewardRates;
  const newRates = newCard.rewardRates as RewardRates;

  let oldAnnual = 0;
  let newAnnual = 0;

  for (const [cat, opt] of Object.entries(storedResult.bestPerCategory)) {
    // Only process categories where this card was the winner
    if (opt.card.slug !== oldCard.slug) continue;

    const spend = (monthlySpend as Record<string, number>)[cat] ?? opt.monthlySpend;
    const oldRate = oldRates[cat as keyof RewardRates] ?? oldRates.default;
    const newRate = newRates[cat as keyof RewardRates] ?? newRates.default;

    oldAnnual += (spend * oldRate * 12) / 100;
    newAnnual += (spend * newRate * 12) / 100;
  }

  // Also account for annual fee change
  const feeDelta = newCard.annualFee - oldCard.annualFee;
  // Fee increase = user pays more = negative impact; decrease = positive
  newAnnual -= feeDelta;

  return Math.round(newAnnual - oldAnnual);
}

// ─── 3. Alert generation ──────────────────────────────────────────────────────
//
// Called after a card is updated in the DB. Finds all sessions whose most
// recent optimization included this card, computes per-session impact, and
// writes CardAlert rows. Fire-and-forget from admin route.
//
// Only generates alerts for changes that affect rewards or fees (skip
// cosmetic-only updates like name or image changes).

export async function generateDevaluationAlerts(
  oldCard: CardRecord,
  newCard: CardRecord,
  changes: CardChange[]
): Promise<number> {
  // Only alert on financially significant changes
  const significantChanges = changes.filter(
    (c) => c.field.startsWith('rewardRates') || c.field === 'annualFee' || c.field === 'feeWaiverRule'
  );
  if (significantChanges.length === 0) return 0;

  // Build a single human-readable change summary for the alert
  const changeSummary = significantChanges
    .sort((a, b) => (a.severity === 'high' ? -1 : b.severity === 'high' ? 1 : 0))
    .slice(0, 2) // cap at two lines to keep it readable
    .map((c) => c.description)
    .join('; ');

  // Find the most recent optimization per session that included this card slug
  // Only sessions where the user has opted in AND has premium access
  const affectedRequests = await prisma.optimizationRequest.findMany({
    where: {
      selectedCards: { has: oldCard.slug },
      session: { alertsEnabled: true, isPremium: true },
    },
    distinct: ['sessionId'],
    orderBy: { createdAt: 'desc' },
    select: {
      sessionId: true,
      monthlySpend: true,
      result: true,
      session: { select: { id: true } },
    },
  });

  if (affectedRequests.length === 0) return 0;

  let alertsCreated = 0;

  for (const req of affectedRequests) {
    const storedResult = req.result as unknown as StoredOptimizationResult;
    const monthlySpend = req.monthlySpend as unknown as MonthlySpend;

    const impact = calculateUserImpact(oldCard, newCard, storedResult, monthlySpend);

    const message =
      impact < 0
        ? `Recent changes to ${newCard.name} reduce your annual rewards by ₹${Math.abs(impact).toLocaleString('en-IN')}`
        : impact > 0
        ? `Recent changes to ${newCard.name} increase your annual rewards by ₹${impact.toLocaleString('en-IN')}`
        : `${newCard.name} has been updated — review the changes to see if they affect your strategy`;

    await prisma.cardAlert.create({
      data: {
        sessionId: req.session.id,
        cardId: newCard.id,
        cardSlug: newCard.slug,
        cardName: newCard.name,
        change: changeSummary,
        impact,
        message,
      },
    });

    alertsCreated++;
  }

  // Fire analytics — single event with count as property
  if (alertsCreated > 0) {
    track({
      event: 'alert_generated',
      page: '/admin/cards',
      properties: {
        cardSlug: newCard.slug,
        alertsCreated,
        changeCount: significantChanges.length,
      },
    }).catch(() => {});
  }

  return alertsCreated;
}

// ─── 4. Session alert reader ──────────────────────────────────────────────────
//
// Fetches all unread alerts for the current session, marks them as read,
// and returns them. Fires alert_viewed analytics event.

export interface AlertsResult {
  alerts: DevaluationAlert[];
  message?: string;
}

export async function getAlertsForSession(sessionId: string): Promise<AlertsResult> {
  // Resolve cookie sessionId → DB session id
  const session = await prisma.session.findUnique({ where: { sessionId } });
  if (!session) return { alerts: [] };

  // Check feature flags — return UX message if not eligible
  if (!session.alertsEnabled) {
    return { alerts: [], message: 'Enable alerts to track changes in your card rewards.' };
  }
  if (!session.isPremium) {
    return { alerts: [], message: 'This feature is currently limited. Stay tuned for full access.' };
  }

  // Fetch unread alerts, newest first, with a reasonable cap
  const alerts = await prisma.cardAlert.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  if (alerts.length === 0) return { alerts: [] };

  // Mark all fetched alerts as read in a single update
  const unreadIds = alerts.filter((a) => !a.isRead).map((a) => a.id);
  if (unreadIds.length > 0) {
    await prisma.cardAlert.updateMany({
      where: { id: { in: unreadIds } },
      data: { isRead: true },
    });
  }

  // Fire analytics — non-blocking
  track({
    event: 'alert_viewed',
    sessionId,
    page: '/alerts',
    properties: { alertCount: alerts.length, unreadCount: unreadIds.length },
  }).catch(() => {});

  return {
    alerts: alerts.map((a) => ({
      id: a.id,
      cardSlug: a.cardSlug,
      card: a.cardName,
      change: a.change,
      impact: a.impact,
      message: a.message,
      isRead: true, // they are now read
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

// ─── 5. Unread count helper ───────────────────────────────────────────────────
//
// Lightweight check used by frontend polling — returns just the unread count
// without marking alerts as read or firing analytics.

export async function getUnreadAlertCount(sessionId: string): Promise<number> {
  const session = await prisma.session.findUnique({ where: { sessionId } });
  if (!session) return 0;

  return prisma.cardAlert.count({
    where: { sessionId: session.id, isRead: false },
  });
}
