import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as affiliateService from './affiliate.service';
import { adminAuth } from '../../middleware/adminAuth';
import { ok, created, notFound, validationError, fail } from '../../utils/response';

export async function affiliateRoutes(app: FastifyInstance): Promise<void> {
  // ─── Public — redirect endpoint (called by frontend "Apply Now" buttons) ──

  /**
   * GET /api/v1/affiliate/redirect/:linkId
   * Tracks the click and returns the affiliate URL (or redirects directly).
   * Clients can choose to redirect using this URL or handle it themselves.
   *
   * Response:
   * { "success": true, "data": { "url": "https://bank.com/apply?utm_source=swipesmart..." } }
   */
  app.get<{ Params: { linkId: string } }>(
    '/redirect/:linkId',
    async (request: FastifyRequest<{ Params: { linkId: string } }>, reply) => {
      const ipAddress = (request.headers['x-forwarded-for'] as string)?.split(',')[0] ?? request.ip;

      const url = await affiliateService.trackClick({
        affiliateLinkId: request.params.linkId,
        sessionId: request.sessionData.sessionId,
        ipAddress,
        userAgent: request.headers['user-agent'],
        referrer: request.headers['referer'],
      });

      if (!url) return notFound(reply, 'Affiliate link not found or inactive');

      // Return URL instead of hard redirect so frontend controls navigation
      ok(reply, { url });
    }
  );

  // ─── Admin — all routes below require admin key ───────────────────────────

  // POST /api/v1/affiliate/links — create a new affiliate link
  app.post(
    '/links',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply) => {
      const schema = z.object({
        cardId: z.string().min(1),
        url: z.string().url(),
        utmSource: z.string().optional(),
        utmMedium: z.string().optional(),
        utmCampaign: z.string().optional(),
      });

      const result = schema.safeParse(request.body);
      if (!result.success) return validationError(reply, result.error.issues);

      try {
        const link = await affiliateService.createLink(result.data);
        created(reply, { link });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create link';
        fail(reply, message, 400);
      }
    }
  );

  // GET /api/v1/affiliate/links?cardId=... — list links
  app.get(
    '/links',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply) => {
      const { cardId } = request.query as { cardId?: string };
      if (!cardId) return validationError(reply, [{ message: 'cardId query param is required' }]);

      const links = await affiliateService.getLinksByCard(cardId);
      ok(reply, { links });
    }
  );

  // DELETE /api/v1/affiliate/links/:id — deactivate a link
  app.delete<{ Params: { id: string } }>(
    '/links/:id',
    { preHandler: adminAuth },
    async (request, reply) => {
      const deactivated = await affiliateService.deactivateLink(request.params.id);
      if (!deactivated) return notFound(reply, 'Link not found');
      ok(reply, { deactivated: true });
    }
  );

  // POST /api/v1/affiliate/conversions — webhook from bank/affiliate network
  app.post(
    '/conversions',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply) => {
      const schema = z.object({
        affiliateLinkId: z.string().min(1),
        clickId: z.string().optional(),
        value: z.number().positive().optional(),
        metadata: z.record(z.unknown()).optional(),
      });

      const result = schema.safeParse(request.body);
      if (!result.success) return validationError(reply, result.error.issues);

      const conversion = await affiliateService.recordConversion(result.data);
      created(reply, { conversion });
    }
  );

  // PATCH /api/v1/affiliate/conversions/:id/status — confirm or reject
  app.patch<{ Params: { id: string } }>(
    '/conversions/:id/status',
    { preHandler: adminAuth },
    async (request, reply) => {
      const schema = z.object({ status: z.enum(['confirmed', 'rejected']) });
      const result = schema.safeParse(request.body);
      if (!result.success) return validationError(reply, result.error.issues);

      const updated = await affiliateService.updateConversionStatus(
        request.params.id,
        result.data.status
      );
      if (!updated) return notFound(reply, 'Conversion not found');
      ok(reply, { updated: true });
    }
  );

  // GET /api/v1/affiliate/stats — performance summary
  app.get(
    '/stats',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply) => {
      const { cardId } = request.query as { cardId?: string };
      const stats = await affiliateService.getAffiliateStats(cardId);
      ok(reply, { stats });
    }
  );
}
