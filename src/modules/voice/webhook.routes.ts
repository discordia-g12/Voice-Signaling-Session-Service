import { FastifyInstance } from 'fastify';
import { WebhookReceiver } from 'livekit-server-sdk';
import { clearVoiceSession, keys } from './sessions';
import { removeParticipant } from './moderation';

/**
 * Webhooks de LiveKit: mantienen la sesión de Redis alineada con lo que pasa en la sala, incluso
 * cuando el cliente se va sin llamar a /leave (cierra la pestaña, se queda sin red).
 * La sala de LiveKit se llama igual que el channelId y la identidad del participante es el userId.
 *
 * No pasa por el Gateway: LiveKit llama directo al servicio dentro de la red de Docker y el
 * request se autentica con la firma (JWT con el sha256 del body) usando las API keys compartidas.
 */
export default async function webhookRoutes(app: FastifyInstance) {
  const receiver = new WebhookReceiver(app.livekit.apiKey, app.livekit.apiSecret);

  // La firma se calcula sobre el body crudo, así que no hay que parsearlo antes de validarla
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  // Al recargar la página la conexión nueva puede entrar antes de que llegue el participant_left
  // de la vieja: solo se borra la sesión si el usuario ya no está en la sala
  async function isStillInRoom(channelId: string, userId: string): Promise<boolean> {
    try {
      const participants = await app.roomService.listParticipants(channelId);
      return participants.some((p) => p.identity === userId);
    } catch {
      // La sala ya no existe
      return false;
    }
  }

  const removeFromChannel = (channelId: string, userId: string) => clearVoiceSession(app.redis, channelId, userId);

  // Baneado, expulsado o fuera del servidor (ver moderation.ts): si entra con un token emitido antes, se lo saca
  async function isBlocked(channelId: string, userId: string): Promise<boolean> {
    const serverId = await app.redis.get(keys.channelServer(channelId));
    if (!serverId) return false;
    return (await app.redis.exists(keys.blocked(serverId, userId))) > 0;
  }

  app.post('/webhooks/livekit', async (request, reply) => {
    let event;
    try {
      event = await receiver.receive(request.body as string, request.headers.authorization);
    } catch (error) {
      request.log.warn({ err: error }, 'Webhook de LiveKit con firma inválida');
      return reply.code(401).send({ error: 'Invalid webhook signature' });
    }

    try {
      if (!app.redis.isOpen) {
        await app.redis.connect();
      }

      const channelId = event.room?.name;
      const userId = event.participant?.identity;

      switch (event.event) {
        case 'participant_joined':
          if (channelId && userId && (await isBlocked(channelId, userId))) {
            request.log.warn({ channelId, userId }, 'Usuario bloqueado entró con un token viejo: se lo saca');
            await removeParticipant(app, channelId, userId);
            if (await removeFromChannel(channelId, userId)) {
              await app.voicePresence.publish(channelId);
            }
          }
          break;

        case 'participant_left':
        case 'participant_connection_aborted':
          if (channelId && userId && !(await isStillInRoom(channelId, userId))) {
            if (await removeFromChannel(channelId, userId)) {
              await app.voicePresence.publish(channelId);
            }
          }
          break;

        case 'room_finished':
          if (channelId) {
            const users = await app.redis.sMembers(keys.channelUsers(channelId));
            for (const user of users) {
              await removeFromChannel(channelId, user);
            }
            if (users.length > 0) {
              await app.voicePresence.publish(channelId);
            }
          }
          break;
      }

      return reply.code(200).send({ received: true });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
}
