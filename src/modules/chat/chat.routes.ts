import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as chatService from './chat.service';
import { ok, created, notFound, fail, validationError } from '../../utils/response';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/chat/conversations
   * Start a new conversation. Returns a conversationId that the client stores.
   *
   * Response:
   * { "success": true, "data": { "conversationId": "cuid..." } }
   */
  app.post('/chat/conversations', async (request: FastifyRequest, reply) => {
    try {
      const conversationId = await chatService.createConversation(request.sessionData.sessionId);
      created(reply, { conversationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create conversation';
      fail(reply, message, 400);
    }
  });

  /**
   * GET /api/v1/chat/conversations/:id
   * Fetch a conversation and its full message history.
   */
  app.get<{ Params: { id: string } }>('/chat/conversations/:id', async (request, reply) => {
    const conversation = await chatService.getConversation(request.params.id);
    if (!conversation) return notFound(reply, 'Conversation not found');
    ok(reply, { conversation });
  });

  /**
   * POST /api/v1/chat/conversations/:id/messages
   * Send a message and receive the assistant's reply.
   *
   * Request body:
   * { "message": "I spend about ₹30,000/month and love to travel" }
   *
   * Response:
   * {
   *   "success": true,
   *   "data": {
   *     "conversationId": "cuid...",
   *     "message": "Based on your travel focus and ₹30k monthly spend...",
   *     "role": "assistant"
   *   }
   * }
   */
  app.post<{ Params: { id: string } }>('/chat/conversations/:id/messages', async (request, reply) => {
    const schema = z.object({ message: z.string().min(1).max(2000) });
    const result = schema.safeParse(request.body);
    if (!result.success) return validationError(reply, result.error.issues);

    try {
      const response = await chatService.chat(request.params.id, result.data.message);
      ok(reply, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chat failed';
      // Distinguish between "not found" and other errors
      if (message === 'Conversation not found') return notFound(reply, message);
      fail(reply, message, 500);
    }
  });

  /**
   * DELETE /api/v1/chat/conversations/:id
   * Reset a conversation (clear messages, keep conversationId).
   * Useful for "Start over" UI action.
   */
  app.delete<{ Params: { id: string } }>('/chat/conversations/:id', async (request, reply) => {
    try {
      await chatService.resetConversation(request.params.id);
      ok(reply, { reset: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reset failed';
      fail(reply, message, 400);
    }
  });
}
