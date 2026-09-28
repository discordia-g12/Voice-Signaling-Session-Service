import { test, mock } from 'node:test';
import assert from 'node:assert';
import buildApp from '../src/app';

test('Voice Routes', async (t) => {
  const app = buildApp({
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: process.env.REDIS_PORT || 6379,
  });

  await app.ready();
  t.after(async () => {
    await app.close();
  });

  await t.test('POST /join - falla si no hay header x-user-id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/rooms/some-channel/join',
    });
    assert.strictEqual(res.statusCode, 400);
  });

  await t.test('POST /join - exitoso', async () => {
    mock.method(global, 'fetch', async () => {
      return { ok: true, status: 200 };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/rooms/fake-channel/join',
      headers: { 'x-user-id': 'user-123' },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    
    assert.ok(body.token !== undefined);
    assert.ok(body.url !== undefined);

    mock.restoreAll();
  });

  await t.test('POST /leave - exitoso', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/rooms/leave',
      headers: { 'x-user-id': 'user-123' },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().message, 'Desconectado exitosamente');
  });
});