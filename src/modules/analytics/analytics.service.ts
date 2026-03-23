/**
 * Analytics service — lightweight event tracking.
 *
 * Events are written to DB asynchronously (fire-and-forget) so they never
 * block the main request path. For high-volume production, swap the DB write
 * with a Redis queue (e.g. BullMQ) consumed by a background worker.
 */
import { prisma } from '../../lib/prisma';

export type EventName =
  | 'page_view'
  | 'button_click'
  | 'card_view'
  | 'optimize_request'
  | 'recommend_request'
  | 'chat_message'
  | 'affiliate_click'
  // AI cost-tracking events (emitted by chat.service)
  | 'ai_called'       // Claude API was invoked (cache miss on an AI-intent message)
  | 'ai_cache_hit'    // Claude was NOT called — response served from Redis
  | 'ai_cache_miss'   // Redis had no entry; Claude will be called next
  | 'ai_skipped'       // Intent classified as "calculation/template/faq" — backend logic used, no Claude
  | 'ai_blocked'       // Per-session AI limit reached — Claude call suppressed
  | 'dashboard_view'        // User loaded the opportunity-loss dashboard
  | 'loss_calculated'       // Opportunity loss computation completed
  | 'strategy_generated'    // Card stack strategy was generated
  | 'cheatsheet_downloaded' // Wallet cheatsheet was requested
  | 'alert_generated'       // Devaluation alert created for a session after card update
  | 'alert_viewed'          // User fetched their alerts (GET /alerts)
  | 'alerts_enabled'        // User opted in to devaluation alerts
  | 'alerts_disabled';      // User opted out of devaluation alerts

export interface TrackInput {
  event: EventName | string;
  sessionId?: string;
  page?: string;
  properties?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function track(input: TrackInput): Promise<void> {
  let dbSessionId: string | null = null;

  if (input.sessionId) {
    const session = await prisma.session.findUnique({ where: { sessionId: input.sessionId } });
    dbSessionId = session?.id ?? null;
  }

  await prisma.analyticsEvent.create({
    data: {
      event: input.event,
      sessionId: dbSessionId,
      page: input.page ?? null,
      properties: ((input.properties ?? {}) as object),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

// ─── Admin stats ───────────────────────────────────────────────────────────────

export async function getEventCounts(days = 30): Promise<Record<string, number>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.analyticsEvent.groupBy({
    by: ['event'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });

  return Object.fromEntries(rows.map((r) => [r.event, r._count._all]));
}

export async function getDailyVolume(days = 30): Promise<Array<{ date: string; count: number }>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Raw query for date truncation (Prisma doesn't natively support groupBy date parts)
  const rows = await prisma.$queryRaw<Array<{ date: Date; count: bigint }>>`
    SELECT DATE_TRUNC('day', "createdAt") AS date, COUNT(*) AS count
    FROM "AnalyticsEvent"
    WHERE "createdAt" >= ${since}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  return rows.map((r) => ({
    date: r.date.toISOString().split('T')[0],
    count: Number(r.count),
  }));
}

export async function getTopCards(days = 30): Promise<Array<{ cardSlug: string; views: number }>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.analyticsEvent.findMany({
    where: {
      event: 'card_view',
      createdAt: { gte: since },
      properties: { path: ['cardSlug'], not: undefined },
    },
    select: { properties: true },
  });

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const props = row.properties as Record<string, unknown> | null;
    const slug = props?.cardSlug as string | undefined;
    if (slug) counts[slug] = (counts[slug] ?? 0) + 1;
  }

  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([cardSlug, views]) => ({ cardSlug, views }));
}

export async function getUniqueSessionCount(days = 30): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await prisma.analyticsEvent.findMany({
    where: { createdAt: { gte: since }, sessionId: { not: null } },
    select: { sessionId: true },
    distinct: ['sessionId'],
  });

  return result.length;
}
