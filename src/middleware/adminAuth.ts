/**
 * Admin auth middleware — validates x-admin-api-key header.
 * Upgrade to JWT in a future iteration when multi-admin support is needed.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env';

export async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.headers['x-admin-api-key'];
  if (!key || key !== env.ADMIN_API_KEY) {
    reply.code(401).send({ success: false, error: 'Unauthorized' });
  }
}
