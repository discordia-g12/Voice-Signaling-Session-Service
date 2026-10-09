import { FastifyInstance } from 'fastify';
import { checkCanConnect } from './permissions';

const MAX_CHANNELS_PER_SUBSCRIPTION = 100;

interface SubscribeMessage {
  type: 'subscribe';
  channelIds: string[];
}

function parseSubscribe(raw: string): SubscribeMessage | null {
  try {
    const data = JSON.parse(raw);
    if (
      data?.type === 'subscribe' &&
      Array.isArray(data.channelIds) &&
      data.channelIds.length <= MAX_CHANNELS_PER_SUBSCRIPTION &&
      data.channelIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
    ) {
      return data;
    }
  } catch {
    // mensaje inválido
  }
  return null;
}

/**
 * WebSocket de presencia: el cliente manda `{ type: 'subscribe', channelIds }` con los canales de
 * voz que está mirando y recibe `{ type: 'presence', channelId, userIds }` con el estado inicial y
 * cada cambio. Solo se siguen los canales a los que el usuario tiene acceso.
 * Pasa por el Gateway (/ws/voice), que valida el token y agrega X-User-Id.
 */
export default async function presenceRoutes(app: FastifyInstance) {
  app.get('/ws/voice', { websocket: true }, (socket, request) => {
    const userId = request.headers['x-user-id'] as string | undefined;
    if (!userId) {
      socket.close(1008, 'x-user-id header is required');
      return;
    }

    // Si llegan dos subscribe seguidos, solo vale el último
    let lastSubscription = 0;

    socket.on('message', async (raw) => {
      const message = parseSubscribe(raw.toString());
      if (!message) {
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid message' }));
        return;
      }

      const subscription = ++lastSubscription;
      const uniqueIds = Array.from(new Set(message.channelIds));
      const permissions = await Promise.all(
        uniqueIds.map((channelId) =>
          checkCanConnect(userId, channelId).catch((error) => {
            request.log.error(error);
            return 'forbidden' as const;
          })
        )
      );
      if (subscription !== lastSubscription) return;

      const allowed = uniqueIds.filter((_, i) => permissions[i] === 'allowed');
      await app.voicePresence.subscribe(socket, allowed);
    });

    socket.on('close', () => app.voicePresence.unsubscribe(socket));
  });
}
