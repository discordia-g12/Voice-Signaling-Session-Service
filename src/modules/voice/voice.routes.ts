import { FastifyInstance } from 'fastify';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { checkConnectAccess, PermissionServiceUnavailableError, type PublishPermissions } from './permissions';
import { keys, TOKEN_TTL } from './sessions';

interface JoinVoiceParams {
  channelId: string;
}

/** Fuentes que el token deja publicar: LiveKit rechaza las demás aunque el cliente lo intente. */
export function publishSources({ canSpeak, canVideo, canScreenShare }: PublishPermissions): TrackSource[] {
  const sources: TrackSource[] = [];
  if (canSpeak) sources.push(TrackSource.MICROPHONE);
  if (canVideo) sources.push(TrackSource.CAMERA);
  if (canScreenShare) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return sources;
}

export default async function voiceRoutes(app: FastifyInstance) {
  
  app.post<{ Params: JoinVoiceParams }>('/api/v1/voice/rooms/:channelId/join', async (request, reply) => {
    const { channelId } = request.params;
    const userId = request.headers['x-user-id'] as string;

    if (!userId) {
      return reply.code(400).send({ error: 'x-user-id header is required' });
    }

    try {
      const { permission, serverId, publish } = await checkConnectAccess(userId, channelId);
      if (permission === 'not_found') return reply.code(404).send({ error: 'Channel not found' });
      if (permission === 'forbidden') return reply.code(403).send({ error: 'User does not have permission' });

      if (!app.redis.isOpen) {
        await app.redis.connect();
      }

      const previousChannel = await app.redis.get(keys.userChannel(userId));
      if (previousChannel && previousChannel !== channelId) {
        await app.redis.sRem(keys.channelUsers(previousChannel), userId);
      }

      await app.redis.set(keys.userChannel(userId), channelId);
      await app.redis.sAdd(keys.channelUsers(channelId), userId);
      if (serverId) {
        // De qué servidor es la llamada: un ban saca al usuario solo de las llamadas de ese servidor
        await app.redis.set(keys.userServer(userId), serverId);
        await app.redis.set(keys.channelServer(channelId), serverId);
        // Pasó can-connect: si estaba bloqueado (lo habían expulsado y volvió a entrar), ya no
        await app.redis.del(keys.blocked(serverId, userId));
      } else {
        await app.redis.del(keys.userServer(userId));
      }

      if (previousChannel && previousChannel !== channelId) {
        await app.voicePresence.publish(previousChannel);
      }
      await app.voicePresence.publish(channelId);

      // TTL corto: el token solo sirve para entrar; LiveKit se lo renueva a quien ya está en la sala
      const at = new AccessToken(app.livekit.apiKey, app.livekit.apiSecret, {
        identity: userId,
        name: `User-${userId}`,
        ttl: TOKEN_TTL,
      });
      
      // Solo puede publicar lo que le permiten sus roles (hablar, cámara, pantalla); escuchar, siempre.
      // Si le cambian los permisos durante la llamada, aplican al volver a entrar
      const permissions = publish ?? { canSpeak: true, canVideo: true, canScreenShare: true };
      const sources = publishSources(permissions);
      at.addGrant({
        roomJoin: true,
        room: channelId,
        canPublish: sources.length > 0,
        canPublishSources: sources,
        canSubscribe: true,
      });

      const token = await at.toJwt();

      // URL pública: el browser se conecta directo a LiveKit (LIVEKIT_URL es la interna de Docker).
      // permissions: el cliente deshabilita el micrófono o la cámara si no puede usarlos
      return reply.code(200).send({
        token,
        url: app.livekit.publicUrl,
        permissions,
      });

    } catch (error) {
      app.log.error(error);
      if (error instanceof PermissionServiceUnavailableError) {
        return reply.code(503).send({ error: 'Permission service unavailable' });
      }
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });


  app.post('/api/v1/voice/rooms/leave', async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;

    if (!userId) {
      return reply.code(400).send({ error: 'x-user-id header is required' });
    }

    try {
      if (!app.redis.isOpen) {
        await app.redis.connect();
      }

      const previousChannel = await app.redis.get(keys.userChannel(userId));

      if (previousChannel) {
        await app.redis.sRem(keys.channelUsers(previousChannel), userId);
        await app.redis.del([keys.userChannel(userId), keys.userServer(userId)]);
        await app.voicePresence.publish(previousChannel);
      }

      return reply.code(200).send({ message: 'Desconectado exitosamente' });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });

}