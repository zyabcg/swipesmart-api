import type { FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { logger } from '../lib/logger';

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  // Log the error with context
  logger.error(
    {
      err: error,
      method: request.method,
      url: request.url,
      sessionId: request.sessionData?.sessionId,
    },
    'Unhandled error'
  );

  // Fastify's built-in validation errors
  if (error.statusCode === 400 && error.validation) {
    reply.code(422).send({
      success: false,
      error: 'Validation failed',
      details: error.validation,
    });
    return;
  }

  const statusCode = error.statusCode ?? 500;
  const message = statusCode < 500 ? error.message : 'Internal server error';

  reply.code(statusCode).send({ success: false, error: message });
}
