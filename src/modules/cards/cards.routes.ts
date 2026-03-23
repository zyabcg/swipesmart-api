import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as cardsService from './cards.service';
import { ok, notFound, validationError } from '../../utils/response';

export async function cardRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/cards — list all active cards with optional filters
  app.get('/', async (request: FastifyRequest, reply) => {
    const querySchema = z.object({
      bank: z.string().optional(),
      maxFee: z.coerce.number().optional(),
      intlTravel: z
        .string()
        .optional()
        .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
    });

    const result = querySchema.safeParse(request.query);
    if (!result.success) return validationError(reply, result.error.issues);

    const cards = await cardsService.getAllCards(result.data as Parameters<typeof cardsService.getAllCards>[0]);
    ok(reply, { cards, total: cards.length });
  });

  // GET /api/v1/cards/banks — list unique banks
  // NOTE: must be declared before /:slug, otherwise Fastify matches 'banks' as a slug
  app.get('/banks', async (_request, reply) => {
    const cards = await cardsService.getAllCards();
    const banks = [...new Set(cards.map((c) => c.bank))].sort();
    ok(reply, { banks });
  });

  // GET /api/v1/cards/:slug — single card by slug
  app.get<{ Params: { slug: string } }>('/:slug', async (request, reply) => {
    const card = await cardsService.getCardBySlug(request.params.slug);
    if (!card) return notFound(reply, `Card '${request.params.slug}' not found`);
    ok(reply, { card });
  });
}

/*
  Sample requests:
  ───────────────
  GET /api/v1/cards
  GET /api/v1/cards?bank=HDFC+Bank&maxFee=2500
  GET /api/v1/cards?intlTravel=true
  GET /api/v1/cards/hdfc_regalia
  GET /api/v1/cards/banks

  Sample response (GET /api/v1/cards/hdfc_regalia):
  {
    "success": true,
    "data": {
      "card": {
        "id": "cuid...",
        "slug": "hdfc_regalia",
        "name": "Regalia Gold",
        "bank": "HDFC Bank",
        "annualFee": 2500,
        "rewardRates": { "travel": 5, "dining": 2.7, ... },
        ...
      }
    }
  }
*/
