/**
 * Affiliate service — manages affiliate links and tracks clicks/conversions.
 *
 * Flow:
 *  1. Admin creates an AffiliateLink for a card (bank's apply URL + UTM params)
 *  2. Frontend calls GET /affiliate/redirect/:linkId which:
 *     a. Records a click (sessionId, userId, IP, referrer)
 *     b. Redirects the user to the affiliate URL
 *  3. Conversion webhook (from bank/affiliate network) hits POST /affiliate/conversions
 *
 * Monetization note:
 *  Each card application via SwipeSmart that gets approved generates a
 *  commission from the bank (typically ₹500–₹3,000 per approval).
 */
import { prisma } from '../../lib/prisma';

// ─── Link management ───────────────────────────────────────────────────────────

export interface CreateLinkInput {
  cardId: string;
  url: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

export async function createLink(input: CreateLinkInput) {
  return prisma.affiliateLink.create({ data: input, include: { card: true } });
}

export async function getLinksByCard(cardId: string) {
  return prisma.affiliateLink.findMany({
    where: { cardId, isActive: true },
    include: {
      _count: { select: { clicks: true, conversions: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getLinkById(linkId: string) {
  return prisma.affiliateLink.findUnique({
    where: { id: linkId },
    include: { card: { select: { name: true, bank: true } } },
  });
}

export async function deactivateLink(linkId: string): Promise<boolean> {
  const link = await prisma.affiliateLink.findUnique({ where: { id: linkId } });
  if (!link) return false;
  await prisma.affiliateLink.update({ where: { id: linkId }, data: { isActive: false } });
  return true;
}

// ─── Click tracking ────────────────────────────────────────────────────────────

export interface TrackClickInput {
  affiliateLinkId: string;
  sessionId: string;     // the session.sessionId string (not the DB id)
  userId?: string;       // the user.id (DB primary key), if logged in
  ipAddress?: string;
  userAgent?: string;
  referrer?: string;
}

/**
 * Records a click and returns the affiliate URL to redirect to.
 * Returns null if the link is not found or inactive.
 */
export async function trackClick(input: TrackClickInput): Promise<string | null> {
  const link = await prisma.affiliateLink.findUnique({ where: { id: input.affiliateLinkId } });
  if (!link || !link.isActive) return null;

  const session = await prisma.session.findUnique({ where: { sessionId: input.sessionId } });
  if (!session) return null;

  // Build the affiliate URL with any UTM params
  const url = buildAffiliateUrl(link.url, {
    utmSource: link.utmSource ?? 'swipesmart',
    utmMedium: link.utmMedium ?? 'recommendation',
    utmCampaign: link.utmCampaign ?? link.id,
  });

  await prisma.affiliateClick.create({
    data: {
      affiliateLinkId: input.affiliateLinkId,
      sessionId: session.id,
      userId: input.userId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      referrer: input.referrer ?? null,
    },
  });

  return url;
}

function buildAffiliateUrl(
  baseUrl: string,
  params: { utmSource?: string; utmMedium?: string; utmCampaign?: string }
): string {
  try {
    const url = new URL(baseUrl);
    if (params.utmSource) url.searchParams.set('utm_source', params.utmSource);
    if (params.utmMedium) url.searchParams.set('utm_medium', params.utmMedium);
    if (params.utmCampaign) url.searchParams.set('utm_campaign', params.utmCampaign);
    return url.toString();
  } catch {
    return baseUrl;
  }
}

// ─── Conversion tracking ───────────────────────────────────────────────────────

export interface RecordConversionInput {
  affiliateLinkId: string;
  clickId?: string;
  value?: number;
  metadata?: Record<string, unknown>;
}

export async function recordConversion(input: RecordConversionInput) {
  return prisma.affiliateConversion.create({
    data: {
      affiliateLinkId: input.affiliateLinkId,
      clickId: input.clickId ?? null,
      value: input.value ?? null,
      status: 'pending',
      metadata: input.metadata ? (input.metadata as object) : undefined,
    },
  });
}

export async function updateConversionStatus(
  conversionId: string,
  status: 'confirmed' | 'rejected'
): Promise<boolean> {
  const exists = await prisma.affiliateConversion.findUnique({ where: { id: conversionId } });
  if (!exists) return false;
  await prisma.affiliateConversion.update({ where: { id: conversionId }, data: { status } });
  return true;
}

// ─── Stats ─────────────────────────────────────────────────────────────────────

export interface AffiliateSummary {
  linkId: string;
  cardName: string;
  bank: string;
  totalClicks: number;
  totalConversions: number;
  confirmedConversions: number;
  totalRevenue: number;
  conversionRate: number;
}

export async function getAffiliateStats(cardId?: string): Promise<AffiliateSummary[]> {
  const where = cardId ? { cardId } : {};

  const links = await prisma.affiliateLink.findMany({
    where,
    include: {
      card: { select: { name: true, bank: true } },
      _count: { select: { clicks: true } },
      conversions: { select: { status: true, value: true } },
    },
  });

  return links.map((link) => {
    const confirmedConversions = link.conversions.filter((c) => c.status === 'confirmed');
    const totalRevenue = confirmedConversions.reduce((sum, c) => sum + (c.value ?? 0), 0);
    const totalClicks = link._count.clicks;
    const conversionRate =
      totalClicks > 0 ? (link.conversions.length / totalClicks) * 100 : 0;

    return {
      linkId: link.id,
      cardName: link.card.name,
      bank: link.card.bank,
      totalClicks,
      totalConversions: link.conversions.length,
      confirmedConversions: confirmedConversions.length,
      totalRevenue: Math.round(totalRevenue),
      conversionRate: Math.round(conversionRate * 100) / 100,
    };
  });
}
