import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CallError } from './calls.service';
import { ChatServiceUnavailableError } from './chat';

interface CallParams {
  callId: string;
}

const TITLES = new Map<number, string>([
  [400, 'Bad Request'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [409, 'Conflict'],
  [500, 'Internal Server Error'],
  [503, 'Service Unavailable'],
]);

const MAX_CONVERSATION_ID_LENGTH = 200;

/** RFC 7807 con `code`: el `ApiError` del cliente lee el código para distinguir el caso. */
function sendProblem(reply: FastifyReply, request: FastifyRequest, status: number, code: string, detail: string) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title: TITLES.get(status) ?? 'Error', status, detail, instance: request.url, code });
}

/**
 * Llamadas privadas 1 a 1 (historia #50). Mismo prefijo que el resto de Voice: Kong las rutea sin cambios y
 * pone `X-User-Id`. Los errores van en Problem Details; las rutas de canales no cambian.
 */
export default async function callsRoutes(app: FastifyInstance) {
  /** Corre `action` con el `X-User-Id` y traduce los errores a Problem Details. */
  async function handle<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    action: (userId: string) => Promise<T>,
  ): Promise<T | FastifyReply> {
    const userId = request.headers['x-user-id'];
    if (typeof userId !== 'string' || userId === '') {
      return sendProblem(reply, request, 400, 'MISSING_USER_ID', 'x-user-id header is required');
    }
    try {
      return await action(userId);
    } catch (error) {
      if (error instanceof CallError) {
        return sendProblem(reply, request, error.status, error.code, error.message);
      }
      if (error instanceof ChatServiceUnavailableError) {
        request.log.error({ err: error }, 'Chat-Engine no responde');
        return sendProblem(reply, request, 503, 'CHAT_UNAVAILABLE', 'Chat service unavailable');
      }
      request.log.error({ err: error }, 'Falló una operación de llamada');
      return sendProblem(reply, request, 500, 'INTERNAL_ERROR', 'Internal Server Error');
    }
  }

  app.post('/api/v1/voice/calls', (request, reply) =>
    handle(request, reply, async (userId) => {
      const { conversationId } = (request.body ?? {}) as { conversationId?: unknown };
      if (typeof conversationId !== 'string' || conversationId.trim() === '' || conversationId.length > MAX_CONVERSATION_ID_LENGTH) {
        return sendProblem(reply, request, 400, 'VALIDATION_ERROR', "'conversationId' is required");
      }
      const join = await app.calls.start(userId, conversationId);
      return reply.code(201).send(join);
    }),
  );

  app.post<{ Params: CallParams }>('/api/v1/voice/calls/:callId/accept', (request, reply) =>
    handle(request, reply, (userId) => app.calls.accept(userId, request.params.callId)),
  );

  app.post<{ Params: CallParams }>('/api/v1/voice/calls/:callId/decline', (request, reply) =>
    handle(request, reply, async (userId) => {
      await app.calls.decline(userId, request.params.callId);
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: CallParams }>('/api/v1/voice/calls/:callId/end', (request, reply) =>
    handle(request, reply, async (userId) => {
      await app.calls.end(userId, request.params.callId);
      return reply.code(204).send();
    }),
  );

  app.get('/api/v1/voice/calls/current', (request, reply) =>
    handle(request, reply, async (userId) => ({ call: await app.calls.current(userId) })),
  );
}
