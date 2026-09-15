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
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'ready' });
  await app.close();
});

test('GET /readyz returns 503 when Redis is unreachable', async () => {
  const previousHost = process.env.REDIS_HOST;
  process.env.REDIS_HOST = '169.254.0.1';
  const app = buildApp();

  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.json().status, 'not_ready');

  await app.close();
  process.env.REDIS_HOST = previousHost;
});
