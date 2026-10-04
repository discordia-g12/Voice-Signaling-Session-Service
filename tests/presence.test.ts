import { test, mock } from 'node:test';
import assert from 'node:assert';
import type { WebSocket } from 'ws';
import buildApp from '../src/app';

const livekit = {
  apiKey: 'test-key',
  apiSecret: 'test-secret-at-least-32-chars-long',
  url: 'http://livekit.test:7880',
  publicUrl: 'ws://livekit.test:7880',
};

// Cola de mensajes recibidos por el socket, para esperarlos en orden
function messageQueue(socket: WebSocket) {
  const received: any[] = [];
  const waiters: ((msg: any) => void)[] = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else received.push(msg);
  });
  return {
    next: () =>
      new Promise<any>((resolve, reject) => {
        if (received.length) return resolve(received.shift());
        const timer = setTimeout(() => reject(new Error('timeout esperando mensaje')), 2000);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      }),
  };
}

test('Presencia de canales de voz por WebSocket', async (t) => {
  const app = buildApp({
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: process.env.REDIS_PORT || 6379,
    livekit,
  });
  await app.ready();
  await app.redis.del(['channel:pr-chan-1:users', 'channel:pr-chan-2:users', 'user:pr-user-1:voice_channel']);

  // server-roles: pr-forbidden es el único canal sin acceso
  mock.method(global, 'fetch', async (url: string) => ({
    ok: !url.includes('pr-forbidden'),
    status: url.includes('pr-forbidden') ? 403 : 200,
  }));

  t.after(async () => {
    mock.restoreAll();
    await app.redis.del(['channel:pr-chan-1:users', 'channel:pr-chan-2:users', 'user:pr-user-1:voice_channel']);
    await app.close();
  });

  await t.test('cierra la conexión si no viene X-User-Id', async () => {
    const socket = await app.injectWS('/ws/voice');
    const code = await new Promise<number>((resolve) => socket.on('close', (c) => resolve(c)));
    assert.strictEqual(code, 1008);
  });

  await t.test('rechaza mensajes inválidos', async () => {
    const socket = await app.injectWS('/ws/voice', { headers: { 'x-user-id': 'pr-viewer' } });
    const messages = messageQueue(socket);
    socket.send('no es json');
    assert.deepStrictEqual(await messages.next(), { type: 'error', error: 'Invalid message' });
    socket.terminate();
  });

  await t.test('manda el estado inicial solo de los canales con acceso y luego cada cambio', async () => {
    await app.redis.sAdd('channel:pr-chan-2:users', 'pr-someone');

    const socket = await app.injectWS('/ws/voice', { headers: { 'x-user-id': 'pr-viewer' } });
    const messages = messageQueue(socket);
    socket.send(JSON.stringify({ type: 'subscribe', channelIds: ['pr-chan-1', 'pr-chan-2', 'pr-forbidden'] }));

    assert.deepStrictEqual(await messages.next(), { type: 'presence', channelId: 'pr-chan-1', userIds: [] });
    assert.deepStrictEqual(await messages.next(), {
      type: 'presence',
      channelId: 'pr-chan-2',
      userIds: ['pr-someone'],
    });

    // Alguien entra a pr-chan-1
    const join = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/rooms/pr-chan-1/join',
      headers: { 'x-user-id': 'pr-user-1' },
    });
    assert.strictEqual(join.statusCode, 200);
    assert.deepStrictEqual(await messages.next(), {
      type: 'presence',
      channelId: 'pr-chan-1',
      userIds: ['pr-user-1'],
    });

    // Se cambia a pr-chan-2: avisa la salida de uno y la entrada al otro
    await app.inject({
      method: 'POST',
      url: '/api/v1/voice/rooms/pr-chan-2/join',
      headers: { 'x-user-id': 'pr-user-1' },
    });
    assert.deepStrictEqual(await messages.next(), { type: 'presence', channelId: 'pr-chan-1', userIds: [] });
    assert.deepStrictEqual(await messages.next(), {
      type: 'presence',
      channelId: 'pr-chan-2',
      userIds: ['pr-someone', 'pr-user-1'],
    });

    // Sale
    await app.inject({
      method: 'POST',
      url: '/api/v1/voice/rooms/leave',
      headers: { 'x-user-id': 'pr-user-1' },
    });
    assert.deepStrictEqual(await messages.next(), {
      type: 'presence',
      channelId: 'pr-chan-2',
      userIds: ['pr-someone'],
    });

    socket.terminate();
  });

  await t.test('un nuevo subscribe reemplaza al anterior', async () => {
    const socket = await app.injectWS('/ws/voice', { headers: { 'x-user-id': 'pr-viewer' } });
    const messages = messageQueue(socket);
    socket.send(JSON.stringify({ type: 'subscribe', channelIds: ['pr-chan-1'] }));
    await messages.next();
    socket.send(JSON.stringify({ type: 'subscribe', channelIds: ['pr-chan-2'] }));
    assert.strictEqual((await messages.next()).channelId, 'pr-chan-2');

    // Un cambio en pr-chan-1 ya no le llega; el próximo mensaje es el de pr-chan-2
    await app.inject({ method: 'POST', url: '/api/v1/voice/rooms/pr-chan-1/join', headers: { 'x-user-id': 'pr-user-1' } });
    await app.inject({ method: 'POST', url: '/api/v1/voice/rooms/pr-chan-2/join', headers: { 'x-user-id': 'pr-user-1' } });
    assert.deepStrictEqual(await messages.next(), {
      type: 'presence',
      channelId: 'pr-chan-2',
      userIds: ['pr-someone', 'pr-user-1'],
    });

    socket.terminate();
  });
});
