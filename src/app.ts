import Fastify, { FastifyInstance } from 'fastify';
import { createClient, RedisClientType } from 'redis';

const READYZ_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  const redisHost = process.env.REDIS_HOST || '127.0.0.1';
  const redisPort = process.env.REDIS_PORT || 6379;

  const redisClient: RedisClientType = createClient({
    url: `redis://${redisHost}:${redisPort}`,
  });

  redisClient.on('error', (err) => app.log.error('Redis Client Error', err));

  app.get('/livez', async () => {
    return { status: 'alive' };
  });

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

  app.addHook('onClose', async () => {
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  });

  return app;
}

export default buildApp;
