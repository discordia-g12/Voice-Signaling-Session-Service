import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import buildApp from '../src/app';

const livekit = {
  apiKey: 'test-key',
  apiSecret: 'test-secret-at-least-32-chars-long',
  url: 'ws://livekit.test:7880',
  publicUrl: 'ws://livekit.test:7880',
};

const redis = {
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: process.env.REDIS_PORT || 6379,
};

afterEach(() => mock.restoreAll());

test('/livez responde sin consultar dependencias', async (t) => {
  const fetchMock = mock.method(global, 'fetch', async () => {
    throw new Error('no debería llamarse');
  });
  const app = buildApp({ ...redis, livekit });
  await app.ready();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/livez' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'alive' });
  assert.strictEqual(fetchMock.mock.callCount(), 0);
});

test('/readyz está listo si Redis y LiveKit responden', async (t) => {
  const fetchMock = mock.method(global, 'fetch', async () => ({ ok: true, status: 200 }));
  const app = buildApp({ ...redis, livekit });
  await app.ready();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 200);
  // Consulta LiveKit por HTTP en la URL interna
  assert.strictEqual(fetchMock.mock.calls[0].arguments[0], 'http://livekit.test:7880');
});

test('/readyz no está listo si LiveKit no responde', async (t) => {
  mock.method(global, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const app = buildApp({ ...redis, livekit });
  await app.ready();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 503);
  assert.match(res.json().detail, /^livekit: fetch failed$/);
});

test('/readyz no está listo si Redis no responde', async (t) => {
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200 }));
  const app = buildApp({ ...redis, livekit });
  await app.ready();
  t.after(() => app.close());
  // Redis se cae con el servicio ya arrancado
  mock.method(app.redis, 'ping', async () => {
    throw new Error('connection lost');
  });

  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.json().detail, 'redis: connection lost');
});
