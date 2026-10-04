import Fastify, { FastifyInstance } from 'fastify';
import { createClient, RedisClientType } from 'redis';
import voiceRoutes from './modules/voice/voice.routes';

const READYZ_TIMEOUT_MS = 2000;

export interface LiveKitConfig {
  apiKey: string;
  apiSecret: string;
  publicUrl: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClientType;
    livekit: LiveKitConfig;
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
  const publicUrl = process.env.LIVEKIT_PUBLIC_URL;

  if (!apiKey || !apiSecret || !publicUrl) {
    throw new Error('LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_PUBLIC_URL must be set');
  }

  return { apiKey, apiSecret, publicUrl };
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

  app.get('/livez', async () => {
    return { status: 'alive' };
  });

  app.register(voiceRoutes);

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