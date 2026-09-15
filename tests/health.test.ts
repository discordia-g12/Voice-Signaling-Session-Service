import { test } from 'node:test';
import assert from 'node:assert';
import buildApp from '../src/app';

test('GET /livez returns alive', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/livez' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'alive' });
  await app.close();
});

test('GET /readyz returns ready when Redis is reachable', async () => {
  const app = buildApp({
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: process.env.REDIS_PORT || 6379,
  });
  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'ready' });
  await app.close();
});

test('GET /readyz returns 503 when Redis is unreachable', async () => {
  const app = buildApp({ redisHost: '169.254.0.1' });

  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.json().status, 'not_ready');

  await app.close();
});

test('buildApp falls back to default Redis host/port when not provided', async () => {
  const app = buildApp();
  await app.close();
});
