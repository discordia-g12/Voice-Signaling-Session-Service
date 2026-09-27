import { FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';

interface JoinVoiceParams {
  channelId: string;
}

export default async function voiceRoutes(app: FastifyInstance) {
  
  app.post<{ Params: JoinVoiceParams }>('/api/v1/voice/rooms/:channelId/join', async (request, reply) => {
    const { channelId } = request.params;
    const userId = request.headers['x-user-id'] as string;

    if (!userId) {
      return reply.code(400).send({ error: 'x-user-id header is required' });
    }

    try {
      const coreServiceUrl = process.env.CORE_SERVICE_URL || 'http://server-roles-service:8080';
      const response = await fetch(`${coreServiceUrl}/internal/channels/${channelId}/can-connect?user_id=${userId}`);
      
      if (response.status === 404) return reply.code(404).send({ error: 'Channel not found' });
      if (response.status === 403) return reply.code(403).send({ error: 'User does not have permission' });
      if (!response.ok) throw new Error(`Error en el servicio de roles: ${response.status}`);

      const previousChannel = await app.redis.get(`user:${userId}:voice_channel`);
      if (previousChannel && previousChannel !== channelId) {
        await app.redis.sRem(`channel:${previousChannel}:users`, userId);
      }
      
      await app.redis.set(`user:${userId}:voice_channel`, channelId);
      await app.redis.sAdd(`channel:${channelId}:users`, userId);

      const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
      const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
      
      const at = new AccessToken(apiKey, apiSecret, {
        identity: userId,
        name: `User-${userId}`,
      });
      
      at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: true });
      
      const token = await at.toJwt();
      const livekitUrl = process.env.LIVEKIT_URL || 'ws://localhost:7880';

      return reply.code(200).send({ 
        token, 
        url: livekitUrl
      });

    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
}