import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as analyticsService from './analytics.service';
import { adminAuth } from '../../middleware/adminAuth';
import { ok, validationError } from '../../utils/response';

const trackSchema = z.object({
  event: z.string().min(1).max(100),
  page: z.string().max(200).optional(),
  properties: z.record(z.unknown()).optional(),
});

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/track
   * Client-side event tracking. Fire-and-forget from the frontend.
   *
   * Request body:
   * {
   *   "event": "page_view",
   *   "page": "/optimizer",
   *   "properties": { "cardSlug": "hdfc_regalia" }
   * }
   */
  app.post('/track', async (request: FastifyRequest, reply) => {
    const result = trackSchema.safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    const ipAddress =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0] ?? request.ip;

    // Fire-and-forget — don't await
    analyticsService
      .track({
        event: result.data.event,
        sessionId: request.sessionData?.sessionId,
        page: result.data.page,
        properties: result.data.properties,
        ipAddress,
        userAgent: request.headers['user-agent'],
      })
      .catch(() => {}); // swallow errors — analytics must never break user flow

    // Respond immediately (204 No Content)
    reply.code(204).send();
  });

  // ─── Admin stats endpoints ────────────────────────────────────────────────

  /**
   * GET /api/v1/analytics/stats
   * Returns event counts, daily volume, top cards, and unique session count.
   * Requires x-admin-api-key header.
   */
  app.get(
    '/analytics/stats',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply) => {
      const { days = '30' } = request.query as { days?: string };
      const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);

      const [eventCounts, dailyVolume, topCards, uniqueSessions] = await Promise.all([
        analyticsService.getEventCounts(d),
        analyticsService.getDailyVolume(d),
        analyticsService.getTopCards(d),
        analyticsService.getUniqueSessionCount(d),
      ]);

      ok(reply, { days: d, eventCounts, dailyVolume, topCards, uniqueSessions });
    }
  );
}
