/**
 * Admin routes — all protected by x-admin-api-key header middleware.
 * Prefix: /api/v1/admin
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as adminService from './admin.service';
import { adminAuth } from '../../middleware/adminAuth';
import { ok, created, notFound, validationError, fail } from '../../utils/response';

const cardWriteSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9_]+$/, 'Slug must be lowercase alphanumeric with underscores'),
  name: z.string().min(1),
  bank: z.string().min(1),
  network: z.string().min(1),
  annualFee: z.number().min(0),
  feeWaiverRule: z.string().optional(),
  minIncome: z.number().min(0).optional(),
  rewardRates: z.object({
    travel: z.number().min(0),
    dining: z.number().min(0),
    online: z.number().min(0),
    groceries: z.number().min(0),
    fuel: z.number().min(0),
    utility: z.number().min(0),
    default: z.number().min(0),
  }),
  perks: z.array(z.string()),
  bestFor: z.array(z.enum(['travel_perks', 'cashback', 'rewards_points', 'low_fee'])),
  categories: z.array(z.string()),
  intlTravel: z.boolean().optional(),
  welcomeBonus: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
  isInviteOnly: z.boolean().optional(),
  imageUrl: z.string().url().optional(),
  applyUrl: z.string().url().optional(),
});

const rewardRatesSchema = z.object({
  travel: z.number().min(0),
  dining: z.number().min(0),
  online: z.number().min(0),
  groceries: z.number().min(0),
  fuel: z.number().min(0),
  utility: z.number().min(0),
  default: z.number().min(0),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Apply admin auth to all routes in this plugin
  app.addHook('preHandler', adminAuth);

  // ─── Cards ────────────────────────────────────────────────────────────────

  // GET /api/v1/admin/cards — all cards (including inactive)
  app.get('/cards', async (request: FastifyRequest, reply) => {
    const { q } = request.query as { q?: string };
    const cards = q ? await adminService.searchCards(q) : await adminService.getAllCardsAdmin();
    ok(reply, { cards, total: cards.length });
  });

  // POST /api/v1/admin/cards — create a new card
  app.post('/cards', async (request: FastifyRequest, reply) => {
    const result = cardWriteSchema.safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    try {
      const card = await adminService.createCard(result.data);
      created(reply, { card });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create card';
      fail(reply, message, 409); // Likely unique constraint on slug
    }
  });

  // PATCH /api/v1/admin/cards/:id — update a card (triggers change detection)
  app.patch<{ Params: { id: string } }>('/cards/:id', async (request, reply) => {
    const result = cardWriteSchema.partial().safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    const card = await adminService.updateCardWithChangeDetection(request.params.id, result.data);
    if (!card) return notFound(reply, 'Card not found');
    ok(reply, { card });
  });

  // PATCH /api/v1/admin/cards/:id/reward-rates — update only reward rates (triggers change detection)
  app.patch<{ Params: { id: string } }>('/cards/:id/reward-rates', async (request, reply) => {
    const result = rewardRatesSchema.safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    const card = await adminService.updateRewardRatesWithChangeDetection(request.params.id, result.data);
    if (!card) return notFound(reply, 'Card not found');
    ok(reply, { card });
  });

  // PATCH /api/v1/admin/cards/:id/toggle — toggle isActive
  app.patch<{ Params: { id: string } }>('/cards/:id/toggle', async (request, reply) => {
    const card = await adminService.toggleCardAvailability(request.params.id);
    if (!card) return notFound(reply, 'Card not found');
    ok(reply, { card });
  });

  // DELETE /api/v1/admin/cards/:id — soft delete
  app.delete<{ Params: { id: string } }>('/cards/:id', async (request, reply) => {
    const deleted = await adminService.deleteCard(request.params.id);
    if (!deleted) return notFound(reply, 'Card not found');
    ok(reply, { deleted: true });
  });

  // PATCH /api/v1/admin/banks/:bank/toggle — toggle all cards for a bank
  app.patch<{ Params: { bank: string } }>('/banks/:bank/toggle', async (request, reply) => {
    const { isActive } = request.body as { isActive: boolean };
    if (typeof isActive !== 'boolean') return validationError(reply, [{ message: 'isActive must be a boolean' }]);

    const count = await adminService.bulkToggleBank(
      decodeURIComponent(request.params.bank),
      isActive
    );
    ok(reply, { updatedCount: count });
  });

  // ─── System stats ─────────────────────────────────────────────────────────

  // GET /api/v1/admin/stats — system overview
  app.get('/stats', async (_request, reply) => {
    const stats = await adminService.getSystemStats();
    ok(reply, stats);
  });
}
