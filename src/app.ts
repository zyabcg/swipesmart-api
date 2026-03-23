/**
 * App factory — builds and configures the Fastify instance.
 * Separating app creation from server.listen() makes it easy to test.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';

import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler } from './middleware/errorHandler';
import { sessionMiddleware } from './middleware/session';

import { cardRoutes } from './modules/cards/cards.routes';
import { optimizerRoutes } from './modules/optimizer/optimizer.routes';
import { recommendationRoutes } from './modules/recommendation/recommendation.routes';
import { chatRoutes } from './modules/chat/chat.routes';
import { analyticsRoutes } from './modules/analytics/analytics.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { affiliateRoutes } from './modules/affiliate/affiliate.routes';
import { sessionRoutes } from './modules/sessions/sessions.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { alertRoutes } from './modules/alerts/alerts.routes';

export async function buildApp() {
  const app = Fastify({
    logger: logger as Parameters<typeof Fastify>[0]['logger'],
    trustProxy: true,
    // Let our errorHandler handle validation errors too
    ajv: { customOptions: { allErrors: true } },
  });

  // ── Security headers ──────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: false, // API-only, no HTML served
  });

  // ── CORS ──────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // ── Cookie support (needed for signed session cookies) ────────────────────
  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
    hook: 'onRequest',
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Conservative limits — tighten per-route for expensive endpoints
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      success: false,
      error: 'Too many requests. Please slow down.',
    }),
  });

  // ── Session middleware ────────────────────────────────────────────────────
  // Runs before every route handler; attaches request.sessionData
  app.addHook('preHandler', sessionMiddleware);

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', { config: { rateLimit: { max: 600 } } }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
  }));

  // ── Routes ────────────────────────────────────────────────────────────────
  const API = '/api/v1';

  await app.register(cardRoutes, { prefix: `${API}/cards` });
  await app.register(optimizerRoutes, { prefix: API });
  await app.register(recommendationRoutes, { prefix: API });
  await app.register(chatRoutes, { prefix: API });
  await app.register(analyticsRoutes, { prefix: API });
  await app.register(adminRoutes, { prefix: `${API}/admin` });
  await app.register(affiliateRoutes, { prefix: `${API}/affiliate` });
  await app.register(sessionRoutes, { prefix: `${API}/sessions` });
  await app.register(dashboardRoutes, { prefix: API });
  await app.register(alertRoutes, { prefix: API });

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ success: false, error: 'Route not found' });
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  app.setErrorHandler(errorHandler);

  return app;
}
