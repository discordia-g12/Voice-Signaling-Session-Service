import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { createClient, RedisClientType } from 'redis';
import { RoomServiceClient } from 'livekit-server-sdk';
import voiceRoutes from './modules/voice/voice.routes';
import webhookRoutes from './modules/voice/webhook.routes';
import presenceRoutes from './modules/voice/presence.routes';
import { VoicePresence } from './modules/voice/presence';
import callsRoutes from './modules/calls/calls.routes';
import { CallService } from './modules/calls/calls.service';
import { ChatClient, ChatClientOptions } from './modules/calls/chat';

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
    /** API de servidor de LiveKit (listar y sacar participantes). */
    roomService: RoomServiceClient;
    voicePresence: VoicePresence;
    /** Llamadas privadas 1 a 1 (salas `call-<id>`). */
    calls: CallService;
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
  /** Cada cuánto se pinguea el WebSocket de presencia (/ws/voice). */
  wsPingIntervalMs?: number;
  /** Llamadas privadas: cliente de Chat (URL, timeouts, reintentos) y cuánto suena. */
  calls?: { chat?: ChatClientOptions; ringTimeoutMs?: number };
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
  const roomService = new RoomServiceClient(livekitConfig.url, livekitConfig.apiKey, livekitConfig.apiSecret);
  app.decorate('roomService', roomService);
  app.decorate('voicePresence', new VoicePresence(app));
  const calls = new CallService({
    redis: redisClient,
    roomService,
    livekit: livekitConfig,
    chat: new ChatClient(options.calls?.chat),
    log: app.log,
    ringTimeoutMs: options.calls?.ringTimeoutMs,
  });
  app.decorate('calls', calls);

  app.get('/livez', async () => {
    return { status: 'alive' };
  });

  app.register(fastifyWebsocket);
  app.register(voiceRoutes);
  app.register(webhookRoutes);
  app.register(callsRoutes);
  app.register(presenceRoutes, { pingIntervalMs: options.wsPingIntervalMs });

  // Dependencias críticas: sin Redis no hay sesiones de voz y sin LiveKit no hay audio
  const checkRedis = async () => {
    if (!redisClient.isOpen) {
      await withTimeout(redisClient.connect(), READYZ_TIMEOUT_MS);
    }
    await withTimeout(redisClient.ping(), READYZ_TIMEOUT_MS);
  };

  const checkLiveKit = async () => {
    // LiveKit responde "OK" en la raíz de su API HTTP (misma URL interna que el SDK, en http)
    const httpUrl = livekitConfig.url.replace(/^ws/, 'http');
    const response = await fetch(httpUrl, { signal: AbortSignal.timeout(READYZ_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`respondió ${response.status}`);
  };

  app.get('/readyz', async (_request, reply) => {
    const checks: [string, () => Promise<void>][] = [
      ['redis', checkRedis],
      ['livekit', checkLiveKit],
    ];
    const results = await Promise.all(
      checks.map(async ([name, check]) => {
        try {
          await check();
          return null;
        } catch (error) {
          return `${name}: ${(error as Error).message}`;
        }
      })
    );
    const failures = results.filter((failure): failure is string => failure !== null);

    if (failures.length > 0) {
      return reply.code(503).send({ status: 'not_ready', detail: failures.join('; ') });
    }
    return { status: 'ready' };
  });

  app.addHook('onReady', async () => {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
  });

  app.addHook('onClose', async () => {
    calls.close();
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  });

  return app;
}

export default buildApp;