/**
 * Session middleware — every request gets an anonymous session.
 * Uses a signed cookie to identify the browser, backed by Redis.
 * No login required; sessions are created on first visit and last SESSION_TTL_DAYS days.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { prisma } from '../lib/prisma';
import { redis, KEYS, getJson, setJson } from '../lib/redis';
import { env } from '../config/env';
import type { SessionData } from '../types';

const SESSION_COOKIE = 'swipesmart_sid';
const SESSION_TTL_SECONDS = env.SESSION_TTL_DAYS * 24 * 60 * 60;

export async function sessionMiddleware(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const cookieValue = request.cookies[SESSION_COOKIE];
  const unsignedResult = cookieValue ? request.unsignCookie(cookieValue) : null;
  const existingSessionId = unsignedResult?.valid ? unsignedResult.value : null;

  if (existingSessionId) {
    // Try Redis first
    const cached = await getJson<SessionData>(KEYS.session(existingSessionId));
    if (cached) {
      request.sessionData = cached;
      // Slide expiry
      await redis.expire(KEYS.session(existingSessionId), SESSION_TTL_SECONDS);
      return;
    }

    // Fall back to DB (Redis miss)
    const dbSession = await prisma.session.findUnique({ where: { sessionId: existingSessionId } });
    if (dbSession) {
      const sessionData: SessionData = {
        id: dbSession.id,
        sessionId: dbSession.sessionId,
        userId: dbSession.userId,
        ipAddress: dbSession.ipAddress,
        userAgent: dbSession.userAgent,
        createdAt: dbSession.createdAt.toISOString(),
        alertsEnabled: dbSession.alertsEnabled,
        isPremium: dbSession.isPremium,
      };
      await setJson(KEYS.session(existingSessionId), sessionData, SESSION_TTL_SECONDS);
      request.sessionData = sessionData;
      return;
    }
  }

  // Create new session
  const sessionId = nanoid(32);
  const ipAddress = (request.headers['x-forwarded-for'] as string)?.split(',')[0] ?? request.ip;
  const userAgent = request.headers['user-agent'] ?? null;

  const dbSession = await prisma.session.create({
    data: { sessionId, ipAddress, userAgent },
  });

  const sessionData: SessionData = {
    id: dbSession.id,
    sessionId,
    userId: null,
    ipAddress,
    userAgent,
    createdAt: dbSession.createdAt.toISOString(),
    alertsEnabled: false,
    isPremium: false,
  };

  await setJson(KEYS.session(sessionId), sessionData, SESSION_TTL_SECONDS);
  request.sessionData = sessionData;

  // Set cookie on the reply — we do this via a hook so the reply is available later
  _reply.setCookie(SESSION_COOKIE, sessionId, {
    signed: true,
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}
