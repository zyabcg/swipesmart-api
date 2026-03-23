/**
 * Dashboard routes — "What Am I Losing?" opportunity cost analysis.
 *
 * POST /api/v1/dashboard/loss
 *   Takes the user's card stack and monthly spend.
 *   Returns how much they could earn vs. how much they are earning now,
 *   broken down by category, with no DB writes.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { calculateOpportunityLoss } from '../optimizer/optimizer.service';
import { track } from '../analytics/analytics.service';
import { ok, fail, validationError } from '../../utils/response';

const lossSchema = z.object({
  selectedCards: z
    .array(z.string().min(1))
    .min(1, 'Select at least one card you currently hold')
    .max(20, 'Maximum 20 cards'),
  monthlySpend: z
    .object({
      groceries: z.number().min(0).optional(),
      dining:    z.number().min(0).optional(),
      travel:    z.number().min(0).optional(),
      online:    z.number().min(0).optional(),
      fuel:      z.number().min(0).optional(),
      utility:   z.number().min(0).optional(),
    })
    .refine(
      (spend) => Object.values(spend).some((v) => v !== undefined && v > 0),
      'At least one spending category must be greater than 0'
    ),
});

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/dashboard/loss
   *
   * Request body:
   * {
   *   "selectedCards": ["hdfc_regalia", "axis_ace"],
   *   "monthlySpend": {
   *     "groceries": 8000,
   *     "dining": 5000,
   *     "travel": 10000,
   *     "online": 6000,
   *     "fuel": 2000,
   *     "utility": 3000
   *   }
   * }
   *
   * Response:
   * {
   *   "success": true,
   *   "data": {
   *     "currentRewards": 28400,
   *     "optimalRewards": 47200,
   *     "opportunityLoss": 18800,
   *     "monthlyLoss": 1566,
   *     "breakdown": [
   *       { "category": "travel", "current": 6000, "optimal": 12000, "loss": 6000 },
   *       { "category": "dining", "current": 2400, "optimal": 4800, "loss": 2400 },
   *       ...
   *     ],
   *     "lossMessage": "You're currently leaving ₹18,800/year on the table."
   *   }
   * }
   */
  app.post('/dashboard/loss', async (request: FastifyRequest, reply) => {
    // Fire dashboard_view immediately — non-blocking
    track({
      event: 'dashboard_view',
      sessionId: request.sessionData.sessionId,
      page: '/dashboard/loss',
    }).catch(() => {});

    const result = lossSchema.safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    try {
      const lossData = await calculateOpportunityLoss(
        result.data.selectedCards,
        result.data.monthlySpend
      );

      // Fire loss_calculated with summary properties — non-blocking
      track({
        event: 'loss_calculated',
        sessionId: request.sessionData.sessionId,
        page: '/dashboard/loss',
        properties: {
          opportunityLoss: lossData.opportunityLoss,
          currentRewards: lossData.currentRewards,
          optimalRewards: lossData.optimalRewards,
          cardCount: result.data.selectedCards.length,
        },
      }).catch(() => {});

      ok(reply, lossData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not calculate opportunity loss';
      fail(reply, message, 400);
    }
  });
}
