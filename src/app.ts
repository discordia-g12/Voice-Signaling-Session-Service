import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { createClient, RedisClientType } from 'redis';
import voiceRoutes from './modules/voice/voice.routes';
import webhookRoutes from './modules/voice/webhook.routes';
import presenceRoutes from './modules/voice/presence.routes';
import { VoicePresence } from './modules/voice/presence';

const READYZ_TIMEOUT_MS = 2000;

export interface LiveKitConfig {
  apiKey: string;
  apiSecret: string;
  /** URL interna (red de Docker) para la API de servidor de LiveKit. */
  url: string;
  /** URL que se le devuelve al browser para conectarse a LiveKit. */
  publicUrl: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClientType;
    livekit: LiveKitConfig;
    voicePresence: VoicePresence;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

interface BuildAppOptions {
  redisHost?: string;
  redisPort?: string | number;
  livekit?: LiveKitConfig;
}

// Sin defaults: si faltan las credenciales, el servicio no arranca en vez de firmar tokens con un secret conocido
function loadLiveKitConfig(): LiveKitConfig {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  const publicUrl = process.env.LIVEKIT_PUBLIC_URL;

  if (!apiKey || !apiSecret || !url || !publicUrl) {
    throw new Error('LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL and LIVEKIT_PUBLIC_URL must be set');
  }

  return { apiKey, apiSecret, url, publicUrl };
}

function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const livekitConfig = options.livekit || loadLiveKitConfig();
  const app = Fastify({ logger: true });

  const redisHost = options.redisHost || process.env.REDIS_HOST || '127.0.0.1';
  const redisPort = options.redisPort || process.env.REDIS_PORT || 6379;

  const redisClient: RedisClientType = createClient({
    url: `redis://${redisHost}:${redisPort}`,
    socket: {
      connectTimeout: READYZ_TIMEOUT_MS,
      reconnectStrategy: false,
    },
  });

  redisClient.on('error', (err) => app.log.error('Redis Client Error', err));

  app.decorate('redis', redisClient);
  app.decorate('livekit', livekitConfig);
  app.decorate('voicePresence', new VoicePresence(app));

  app.get('/livez', async () => {
    return { status: 'alive' };
  });

  app.register(fastifyWebsocket);
  app.register(voiceRoutes);
  app.register(webhookRoutes);
  app.register(presenceRoutes);

  app.get('/readyz', async (_request, reply) => {
    try {
      if (!redisClient.isOpen) {
        await withTimeout(redisClient.connect(), READYZ_TIMEOUT_MS);
      }
      await withTimeout(redisClient.ping(), READYZ_TIMEOUT_MS);
      return { status: 'ready' };
    } catch (error) {
      reply.code(503).send({ status: 'not_ready', detail: (error as Error).message });
    }
  });

  app.addHook('onReady', async () => {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
  });

  app.addHook('onClose', async () => {
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  });

  return app;
}

export default buildApp;