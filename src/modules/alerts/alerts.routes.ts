/**
 * Alerts routes
 * Prefix: /api/v1
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAlertsForSession, getUnreadAlertCount, type AlertsResult } from './alerts.service';
import { ok } from '../../utils/response';

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/alerts
   *
   * Returns all alerts for the current anonymous session, newest first.
   * Automatically marks returned alerts as read.
   *
   * Response:
   * {
   *   "success": true,
   *   "data": {
   *     "alerts": [
   *       {
   *         "id": "clx...",
   *         "cardSlug": "hdfc_millennia",
   *         "card": "Millennia",
   *         "change": "Online Shopping reward rate reduced from 5% to 3%",
   *         "impact": -2400,
   *         "message": "Recent changes to Millennia reduce your annual rewards by ₹2,400",
   *         "isRead": true,
   *         "createdAt": "2026-03-23T10:00:00.000Z"
   *       }
   *     ],
   *     "total": 1
   *   }
   * }
   */
  app.get('/alerts', async (request: FastifyRequest, reply) => {
    const result: AlertsResult = await getAlertsForSession(request.sessionData.sessionId);
    const payload: Record<string, unknown> = { alerts: result.alerts, total: result.alerts.length };
    if (result.message) payload.message = result.message;
    ok(reply, payload);
  });

  /**
   * GET /api/v1/alerts/count
   *
   * Lightweight unread count for badge/notification polling.
   * Does NOT mark alerts as read, does NOT fire analytics.
   *
   * Response: { "success": true, "data": { "unread": 2 } }
   */
  app.get('/alerts/count', async (request: FastifyRequest, reply) => {
    const unread = await getUnreadAlertCount(request.sessionData.sessionId);
    ok(reply, { unread });
  });
}
