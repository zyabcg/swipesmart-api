import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as sessionsService from './sessions.service';
import { ok, notFound, validationError } from '../../utils/response';
import { track } from '../analytics/analytics.service';

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/sessions/me
   * Returns the current session's profile including recent activity.
   */
  app.get('/me', async (request: FastifyRequest, reply) => {
    const session = await sessionsService.getSessionProfile(request.sessionData.sessionId);
    if (!session) return notFound(reply, 'Session not found');

    ok(reply, {
      session: {
        id: session.sessionId,
        createdAt: session.createdAt,
        recentOptimizations: session.optimizations.length,
        recentRecommendations: session.recommendations.length,
        alertsEnabled: session.alertsEnabled,
        isPremium: session.isPremium,
      },
    });
  });

  /**
   * PATCH /api/v1/sessions/alerts
   * Toggle alert opt-in for the current session.
   * Body: { enabled: boolean }
   */
  app.patch('/alerts', async (request: FastifyRequest, reply) => {
    const { enabled } = request.body as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      return validationError(reply, [{ message: 'enabled must be a boolean' }]);
    }

    const updated = await sessionsService.setAlertPreference(request.sessionData.sessionId, enabled);
    if (!updated) return notFound(reply, 'Session not found');

    track({
      event: enabled ? 'alerts_enabled' : 'alerts_disabled',
      sessionId: request.sessionData.sessionId,
      page: '/settings',
      properties: { alertsEnabled: enabled },
    }).catch(() => {});

    ok(reply, { alertsEnabled: enabled });
  });
}
