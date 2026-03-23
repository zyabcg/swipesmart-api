/**
 * Cards service — manages the card catalog with Redis caching.
 * Admin writes invalidate the cache; public reads always check Redis first.
 */
import { prisma } from '../../lib/prisma';
import { redis, KEYS, getJson, setJson } from '../../lib/redis';
import { env } from '../../config/env';
import type { CardRecord } from '../../types';

function mapCard(raw: Record<string, unknown>): CardRecord {
  return raw as unknown as CardRecord;
}

// ─── Public reads ──────────────────────────────────────────────────────────────

export async function getAllCards(filters?: {
  bank?: string;
  maxFee?: number;
  minIncome?: number;
  intlTravel?: boolean;
  isActive?: boolean;
}): Promise<CardRecord[]> {
  // Try full-catalog cache only when no filters are applied
  const useCache = !filters || Object.keys(filters).length === 0;

  if (useCache) {
    const cached = await getJson<CardRecord[]>(KEYS.cardCatalog());
    if (cached) return cached;
  }

  const where: Record<string, unknown> = { isActive: filters?.isActive ?? true };
  if (filters?.bank) where.bank = filters.bank;
  if (filters?.maxFee !== undefined) where.annualFee = { lte: filters.maxFee };
  if (filters?.minIncome !== undefined) where.minIncome = { lte: filters.minIncome };
  if (filters?.intlTravel !== undefined) where.intlTravel = filters.intlTravel;

  const rows = await prisma.card.findMany({ where, orderBy: { bank: 'asc' } });
  const cards = rows.map(mapCard);

  if (useCache) {
    await setJson(KEYS.cardCatalog(), cards, env.CARD_CACHE_TTL);
  }

  return cards;
}

export async function getCardById(id: string): Promise<CardRecord | null> {
  const raw = await prisma.card.findUnique({ where: { id } });
  return raw ? mapCard(raw as Record<string, unknown>) : null;
}

export async function getCardBySlug(slug: string): Promise<CardRecord | null> {
  const cached = await getJson<CardRecord>(KEYS.cardBySlug(slug));
  if (cached) return cached;

  const raw = await prisma.card.findUnique({ where: { slug } });
  if (!raw) return null;

  const card = mapCard(raw as Record<string, unknown>);
  await setJson(KEYS.cardBySlug(slug), card, env.CARD_CACHE_TTL);
  return card;
}

export async function getCardsBySlugs(slugs: string[]): Promise<CardRecord[]> {
  const rows = await prisma.card.findMany({ where: { slug: { in: slugs }, isActive: true } });
  return rows.map(mapCard);
}

// ─── Admin writes ──────────────────────────────────────────────────────────────

export interface CreateCardInput {
  slug: string;
  name: string;
  bank: string;
  network: string;
  annualFee: number;
  feeWaiverRule?: string;
  minIncome?: number;
  rewardRates: Record<string, number>;
  perks: string[];
  bestFor: string[];
  categories: string[];
  intlTravel?: boolean;
  welcomeBonus?: number;
  isActive?: boolean;
  isInviteOnly?: boolean;
  imageUrl?: string;
  applyUrl?: string;
}

export async function createCard(input: CreateCardInput): Promise<CardRecord> {
  const raw = await prisma.card.create({ data: input });
  await invalidateCache();
  return mapCard(raw as Record<string, unknown>);
}

export async function updateCard(id: string, input: Partial<CreateCardInput>): Promise<CardRecord | null> {
  const exists = await prisma.card.findUnique({ where: { id } });
  if (!exists) return null;

  // Increment version whenever reward rates or fee fields change
  const hasSignificantChange =
    input.rewardRates !== undefined ||
    input.annualFee !== undefined ||
    input.feeWaiverRule !== undefined ||
    input.perks !== undefined;

  const raw = await prisma.card.update({
    where: { id },
    data: {
      ...input,
      ...(hasSignificantChange ? { version: { increment: 1 } } : {}),
    },
  });
  await invalidateCache(exists.slug);
  return mapCard(raw as Record<string, unknown>);
}

export async function updateRewardRates(id: string, rates: Record<string, number>): Promise<CardRecord | null> {
  const exists = await prisma.card.findUnique({ where: { id } });
  if (!exists) return null;

  const raw = await prisma.card.update({
    where: { id },
    data: { rewardRates: rates, version: { increment: 1 } },
  });
  await invalidateCache(exists.slug);
  return mapCard(raw as Record<string, unknown>);
}

export async function toggleCardAvailability(id: string): Promise<CardRecord | null> {
  const exists = await prisma.card.findUnique({ where: { id } });
  if (!exists) return null;

  const raw = await prisma.card.update({ where: { id }, data: { isActive: !exists.isActive } });
  await invalidateCache(exists.slug);
  return mapCard(raw as Record<string, unknown>);
}

export async function deleteCard(id: string): Promise<boolean> {
  const exists = await prisma.card.findUnique({ where: { id } });
  if (!exists) return false;

  // Soft delete
  await prisma.card.update({ where: { id }, data: { isActive: false } });
  await invalidateCache(exists.slug);
  return true;
}

// ─── Cache management ──────────────────────────────────────────────────────────

export async function invalidateCache(slug?: string): Promise<void> {
  const keys = [KEYS.cardCatalog()];
  if (slug) keys.push(KEYS.cardBySlug(slug));
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
