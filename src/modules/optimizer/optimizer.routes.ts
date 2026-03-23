import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { optimize } from './optimizer.service';
import { generateCardStackStrategy, generateCheatsheet } from './strategy.service';
import { track } from '../analytics/analytics.service';
import { ok, fail, validationError } from '../../utils/response';

const optimizeSchema = z.object({
  selectedCards: z
    .array(z.string().min(1))
    .min(1, 'Select at least one card')
    .max(20, 'Maximum 20 cards'),
  monthlySpend: z
    .object({
      groceries: z.number().min(0).optional(),
      dining: z.number().min(0).optional(),
      travel: z.number().min(0).optional(),
      online: z.number().min(0).optional(),
      fuel: z.number().min(0).optional(),
      utility: z.number().min(0).optional(),
    })
    .refine(
      (spend) => Object.values(spend).some((v) => v !== undefined && v > 0),
      'At least one spending category must have a value greater than 0'
    ),
});

export async function optimizerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/optimize
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
   *     "bestPerCategory": {
   *       "travel": {
   *         "card": { "name": "Regalia Gold", "bank": "HDFC Bank", ... },
   *         "rate": 5,
   *         "monthlySpend": 10000,
   *         "monthlyReward": 500,
   *         "annualReward": 6000
   *       },
   *       "utility": {
   *         "card": { "name": "Ace", "bank": "Axis Bank", ... },
   *         "rate": 5,
   *         "monthlySpend": 3000,
   *         "monthlyReward": 150,
   *         "annualReward": 1800
   *       },
   *       ...
   *     },
   *     "totalOptimizedAnnualRewards": 24800,
   *     "totalBaselineAnnualRewards": 14256,
   *     "optimizationDelta": 10544,
   *     "tips": ["Your travel spend is high..."]
   *   }
   * }
   */
  app.post('/optimize', async (request: FastifyRequest, reply) => {
    const result = optimizeSchema.safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    try {
      const optimization = await optimize(result.data, request.sessionData.sessionId);
      ok(reply, optimization);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Optimization failed';
      fail(reply, message, 400);
    }
  });

  /**
   * POST /api/v1/optimizer/strategy
   *
   * Runs the optimizer then wraps output in a UX-ready card stack strategy.
   * Each category entry includes a label ("Best for Travel"), the winning card,
   * rate, and a short reason. Items are sorted by annual reward value.
   *
   * Request body: same shape as POST /optimize
   *
   * Response:
   * {
   *   "success": true,
   *   "data": {
   *     "totalCardsUsed": 2,
   *     "annualRewards": 24800,
   *     "strategy": [
   *       {
   *         "category": "travel",
   *         "label": "Best for Travel",
   *         "card": "Atlas",
   *         "bank": "Axis Bank",
   *         "rewardRate": 5,
   *         "reason": "5% on travel — strong category-specific rate",
   *         "annualReward": 6000
   *       },
   *       ...
   *     ],
   *     "tips": [...]
   *   }
   * }
   */
  app.post('/optimizer/strategy', async (request: FastifyRequest, reply) => {
    const result = optimizeSchema.safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    try {
      const optimizerOutput = await optimize(result.data, request.sessionData.sessionId);
      const strategy = generateCardStackStrategy(optimizerOutput);

      track({
        event: 'strategy_generated',
        sessionId: request.sessionData.sessionId,
        page: '/optimizer/strategy',
        properties: {
          totalCardsUsed: strategy.totalCardsUsed,
          annualRewards: strategy.annualRewards,
          categoryCount: strategy.strategy.length,
        },
      }).catch(() => {});

      ok(reply, strategy);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Strategy generation failed';
      fail(reply, message, 400);
    }
  });

  /**
   * POST /api/v1/optimizer/cheatsheet
   *
   * Runs the full optimizer → strategy → cheatsheet pipeline.
   * Returns a wallet-ready cheatsheet in JSON, or plain text if ?format=text.
   *
   * Request body: same shape as POST /optimize
   * Query param:  ?format=text  → returns plain text (Content-Type: text/plain)
   *               (default)     → returns JSON
   *
   * JSON response:
   * {
   *   "success": true,
   *   "data": {
   *     "title": "Your Swipe Strategy",
   *     "summary": "2 cards · ₹24,800/year in rewards",
   *     "items": [
   *       "✈️  Travel → Atlas (5%)",
   *       "💡  Utilities → Ace (5%)",
   *       ...
   *     ],
   *     "text": "╔══... (full printable version)"
   *   }
   * }
   *
   * Text response (format=text): raw printable cheatsheet string
   */
  app.post(
    '/optimizer/cheatsheet',
    { schema: { querystring: { type: 'object', properties: { format: { type: 'string' } } } } },
    async (request: FastifyRequest<{ Querystring: { format?: string } }>, reply) => {
      const result = optimizeSchema.safeParse(request.body);
      if (!result.success) return validationError(reply, result.error.issues);

      try {
        const optimizerOutput = await optimize(result.data, request.sessionData.sessionId);
        const strategy = generateCardStackStrategy(optimizerOutput);
        const cheatsheet = generateCheatsheet(strategy);

        track({
          event: 'cheatsheet_downloaded',
          sessionId: request.sessionData.sessionId,
          page: '/optimizer/cheatsheet',
          properties: {
            format: request.query.format ?? 'json',
            totalCardsUsed: strategy.totalCardsUsed,
            annualRewards: strategy.annualRewards,
          },
        }).catch(() => {});

        if (request.query.format === 'text') {
          reply.header('Content-Type', 'text/plain; charset=utf-8');
          reply.header('Content-Disposition', 'attachment; filename="swipe-strategy.txt"');
          return reply.send(cheatsheet.text);
        }

        ok(reply, cheatsheet);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Cheatsheet generation failed';
        fail(reply, message, 400);
      }
    }
  );
}
