const fastify = require('fastify')({ logger: true });
const { createClient } = require('redis');

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || 6379;

const redisClient = createClient({
  url: `redis://${redisHost}:${redisPort}`
});

redisClient.on('error', (err) => fastify.log.error('Redis Client Error', err));

fastify.get('/livez', async (request, reply) => {
  return { status: 'alive' };
});

fastify.get('/readyz', async (request, reply) => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    await redisClient.ping();
    return { status: 'ready' };
  } catch (error) {
    reply.code(503).send({ status: 'not_ready', detail: error.message });
  }
});

const start = async () => {
  try {
    const port = process.env.PORT || 8080;
    await fastify.listen({ port: port, host: '0.0.0.0' });
    fastify.log.info(`Server listening on ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();