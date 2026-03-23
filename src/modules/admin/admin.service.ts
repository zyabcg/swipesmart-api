/**
 * Admin service — wraps cards service with admin-specific operations and
 * provides a query interface for monitoring and management.
 */
import { prisma } from '../../lib/prisma';
import * as cardsService from '../cards/cards.service';
import type { CreateCardInput } from '../cards/cards.service';
import { detectCardChanges, generateDevaluationAlerts } from '../alerts/alerts.service';
import type { CardRecord } from '../../types';

// Re-export card CRUD for admin routes
export { createCard, updateCard, updateRewardRates, toggleCardAvailability, deleteCard } from '../cards/cards.service';

// ─── Card management ──────────────────────────────────────────────────────────

/**
 * Update a card and automatically trigger change detection + alert generation.
 *
 * Flow:
 *   1. Fetch the card BEFORE the update (old snapshot)
 *   2. Apply the update via the cards service (increments version if significant)
 *   3. Diff old vs new with detectCardChanges
 *   4. Fire generateDevaluationAlerts in the background (fire-and-forget)
 *
 * Alert generation is async and never blocks the admin response.
 */
export async function updateCardWithChangeDetection(
  id: string,
  input: Partial<CreateCardInput>
): Promise<CardRecord | null> {
  // Snapshot old card before update
  const oldRaw = await prisma.card.findUnique({ where: { id } });
  if (!oldRaw) return null;
  const oldCard = oldRaw as unknown as CardRecord;

  // Apply update (version is incremented inside updateCard when rates/fee change)
  const newCard = await cardsService.updateCard(id, input);
  if (!newCard) return null;

  // Detect changes and dispatch alerts asynchronously
  const changes = detectCardChanges(oldCard, newCard);
  if (changes.length > 0) {
    generateDevaluationAlerts(oldCard, newCard, changes).catch(() => {});
  }

  return newCard;
}

/**
 * Update only reward rates with automatic change detection.
 * Used by PATCH /admin/cards/:id/reward-rates.
 */
export async function updateRewardRatesWithChangeDetection(
  id: string,
  rates: Record<string, number>
): Promise<CardRecord | null> {
  const oldRaw = await prisma.card.findUnique({ where: { id } });
  if (!oldRaw) return null;
  const oldCard = oldRaw as unknown as CardRecord;

  const newCard = await cardsService.updateRewardRates(id, rates);
  if (!newCard) return null;

  const changes = detectCardChanges(oldCard, newCard);
  if (changes.length > 0) {
    generateDevaluationAlerts(oldCard, newCard, changes).catch(() => {});
  }

  return newCard;
}

export async function getAllCardsAdmin(): Promise<CardRecord[]> {
  // Admin sees all cards including inactive ones
  const rows = await prisma.card.findMany({ orderBy: { bank: 'asc' } });
  return rows as unknown as CardRecord[];
}

export async function bulkToggleBank(bank: string, isActive: boolean): Promise<number> {
  const result = await prisma.card.updateMany({
    where: { bank },
    data: { isActive },
  });
  await cardsService.invalidateCache();
  return result.count;
}

// ─── System stats ─────────────────────────────────────────────────────────────

export interface SystemStats {
  cards: { total: number; active: number; inactive: number };
  sessions: { total: number; last7Days: number };
  requests: { optimizations: number; recommendations: number; chats: number };
  affiliates: { links: number; clicks: number; conversions: number; confirmedRevenue: number };
}

export async function getSystemStats(): Promise<SystemStats> {
  const since7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalCards,
    activeCards,
    totalSessions,
    recentSessions,
    totalOptimizations,
    totalRecommendations,
    totalChats,
    totalAffiliateLinks,
    totalClicks,
    conversions,
  ] = await Promise.all([
    prisma.card.count(),
    prisma.card.count({ where: { isActive: true } }),
    prisma.session.count(),
    prisma.session.count({ where: { createdAt: { gte: since7Days } } }),
    prisma.optimizationRequest.count(),
    prisma.recommendationRequest.count(),
    prisma.chatConversation.count(),
    prisma.affiliateLink.count({ where: { isActive: true } }),
    prisma.affiliateClick.count(),
    prisma.affiliateConversion.findMany({
      where: { status: 'confirmed' },
      select: { value: true },
    }),
  ]);

  const confirmedRevenue = conversions.reduce((sum, c) => sum + (c.value ?? 0), 0);

  return {
    cards: { total: totalCards, active: activeCards, inactive: totalCards - activeCards },
    sessions: { total: totalSessions, last7Days: recentSessions },
    requests: {
      optimizations: totalOptimizations,
      recommendations: totalRecommendations,
      chats: totalChats,
    },
    affiliates: {
      links: totalAffiliateLinks,
      clicks: totalClicks,
      conversions: conversions.length,
      confirmedRevenue: Math.round(confirmedRevenue),
    },
  };
}

// ─── Search / filter for admin ────────────────────────────────────────────────

export async function searchCards(query: string): Promise<CardRecord[]> {
  const rows = await prisma.card.findMany({
    where: {
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { bank: { contains: query, mode: 'insensitive' } },
        { slug: { contains: query, mode: 'insensitive' } },
      ],
    },
    orderBy: { bank: 'asc' },
  });
  return rows as unknown as CardRecord[];
}
