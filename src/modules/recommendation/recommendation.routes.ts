import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recommend } from './recommendation.service';
import { ok, validationError, fail } from '../../utils/response';

const recommendSchema = z.object({
  income: z.number().positive('Income must be a positive number'),
  totalSpend: z.number().positive('Total spend must be a positive number'),
  primaryCategory: z.enum(['groceries', 'dining', 'travel', 'online', 'fuel', 'utility', 'everything']),
  lifestylePreference: z.enum(['travel_perks', 'cashback', 'rewards_points', 'low_fee']),
  maxFee: z.number().min(0),
  intlTravel: z.enum(['no', 'occasionally', 'frequently']),
  limit: z.number().int().min(1).max(10).optional(),
});

export async function recommendationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/recommend
   *
   * Request body:
   * {
   *   "income": 75000,
   *   "totalSpend": 30000,
   *   "primaryCategory": "travel",
   *   "lifestylePreference": "travel_perks",
   *   "maxFee": 5000,
   *   "intlTravel": "occasionally",
   *   "limit": 5
   * }
   *
   * Response:
   * {
   *   "success": true,
   *   "data": {
   *     "recommendations": [
   *       {
   *         "rank": 1,
   *         "score": 42800,
   *         "card": { "name": "Regalia Gold", ... },
   *         "primaryRate": 5,
   *         "estimatedAnnualRewards": 18000,
   *         "netAnnualValue": 18000,
   *         "explanation": "Earns 5% on travel, worth ~₹18,000/year...",
   *         "highlights": ["5% on travel", "Priority Pass lounge", ...]
   *       },
   *       ...
   *     ],
   *     "totalMatched": 18,
   *     "totalEvaluated": 36
   *   }
   * }
   */
  app.post('/recommend', async (request: FastifyRequest, reply) => {
    const result = recommendSchema.safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    try {
      const { limit, ...input } = result.data;
      const output = await recommend(input, request.sessionData.sessionId, { limit });
      ok(reply, output);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Recommendation failed';
      fail(reply, message, 400);
    }
  });
}
