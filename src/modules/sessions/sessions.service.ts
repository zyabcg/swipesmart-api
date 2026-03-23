import { prisma } from '../../lib/prisma';
import { getJson, setJson, KEYS } from '../../lib/redis';
import { env } from '../../config/env';
import type { SessionData } from '../../types';

const SESSION_TTL_SECONDS = env.SESSION_TTL_DAYS * 24 * 60 * 60;

export async function getSessionProfile(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { sessionId },
    include: {
      optimizations: { orderBy: { createdAt: 'desc' }, take: 5 },
      recommendations: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  });

  return session;
}

export async function linkSessionToUser(sessionId: string, userId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { sessionId } });
  if (!session) return false;

  await prisma.session.update({ where: { id: session.id }, data: { userId } });
  return true;
}

export async function getSessionFromCache(sessionId: string): Promise<SessionData | null> {
  return getJson<SessionData>(KEYS.session(sessionId));
}

export async function setAlertPreference(sessionId: string, enabled: boolean): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { sessionId } });
  if (!session) return false;

  const updated = await prisma.session.update({
    where: { id: session.id },
    data: { alertsEnabled: enabled },
  });

  // Refresh Redis cache with updated flags
  const cached = await getJson<SessionData>(KEYS.session(sessionId));
  if (cached) {
    await setJson(
      KEYS.session(sessionId),
      { ...cached, alertsEnabled: updated.alertsEnabled },
      SESSION_TTL_SECONDS
    );
  }

  return true;
}
