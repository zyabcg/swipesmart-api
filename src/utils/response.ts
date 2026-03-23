import type { FastifyReply } from 'fastify';
import type { ApiResponse } from '../types';

export function ok<T>(reply: FastifyReply, data: T, statusCode = 200): void {
  const response: ApiResponse<T> = { success: true, data };
  reply.code(statusCode).send(response);
}

export function created<T>(reply: FastifyReply, data: T): void {
  ok(reply, data, 201);
}

export function fail(reply: FastifyReply, message: string, statusCode = 400, details?: unknown): void {
  const response: ApiResponse = { success: false, error: message, details };
  reply.code(statusCode).send(response);
}

export function notFound(reply: FastifyReply, message = 'Not found'): void {
  fail(reply, message, 404);
}

export function serverError(reply: FastifyReply, message = 'Internal server error'): void {
  fail(reply, message, 500);
}

export function validationError(reply: FastifyReply, details: unknown): void {
  fail(reply, 'Validation failed', 422, details);
}
