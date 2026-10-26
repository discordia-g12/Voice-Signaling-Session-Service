import { test, mock } from 'node:test';
import assert from 'node:assert';
import buildApp from '../src/app';

const livekit = {
  apiKey: 'test-key',
  apiSecret: 'test-secret-at-least-32-chars-long',
  url: 'http://livekit.test:7880',
  publicUrl: 'ws://livekit.test:7880',
};

test('buildApp falla si faltan las credenciales de LiveKit', () => {
  const saved = process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_API_SECRET;
  try {
    assert.throws(() => buildApp(), /LIVEKIT_API_SECRET/);
  } finally {
    if (saved !== undefined) process.env.LIVEKIT_API_SECRET = saved;
  }
});

test('Voice Routes', async (t) => {
  const app = buildApp({
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: process.env.REDIS_PORT || 6379,
    livekit,
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
    assert.strictEqual(body.url, livekit.publicUrl);

    mock.restoreAll();
  });

  await t.test('POST /join - guarda el servidor de la llamada, levanta el bloqueo y emite un token corto', async () => {
    mock.method(global, 'fetch', async () => {
      return { ok: true, status: 200, json: async () => ({ can_connect: true, server_id: 'srv-join' }) };
    });
    await app.redis.set('voice:blocked:srv-join:user-join', '1', { EX: 60 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/rooms/chan-join/join',
      headers: { 'x-user-id': 'user-join' },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(await app.redis.get('user:user-join:voice_server'), 'srv-join');
    assert.strictEqual(await app.redis.get('channel:chan-join:server'), 'srv-join');
    assert.strictEqual(await app.redis.exists('voice:blocked:srv-join:user-join'), 0);

    const payload = JSON.parse(Buffer.from(res.json().token.split('.')[1], 'base64url').toString());
    const secondsLeft = payload.exp - Math.floor(Date.now() / 1000);
    assert.ok(secondsLeft > 0 && secondsLeft <= 600, 'el token dura como mucho 10 minutos');

    await app.redis.del([
      'user:user-join:voice_channel',
      'user:user-join:voice_server',
      'channel:chan-join:users',
      'channel:chan-join:server',
    ]);
    mock.restoreAll();
  });

  await t.test('POST /join - 503 si Server-Roles no responde', async () => {
    mock.method(global, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/rooms/fake-channel/join',
      headers: { 'x-user-id': 'user-123' },
    });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().error, 'Permission service unavailable');
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