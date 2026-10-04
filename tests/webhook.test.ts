import { test, mock } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import buildApp from '../src/app';

const livekit = {
  apiKey: 'test-key',
  apiSecret: 'test-secret-at-least-32-chars-long',
  url: 'http://livekit.test:7880',
  publicUrl: 'ws://livekit.test:7880',
};

// Firma el body igual que LiveKit: JWT con el sha256 (base64) del body crudo
async function signedWebhook(event: object, secret = livekit.apiSecret) {
  const body = JSON.stringify(event);
  const at = new AccessToken(livekit.apiKey, secret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return { body, authorization: await at.toJwt() };
}

test('Webhooks de LiveKit', async (t) => {
  const app = buildApp({
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: process.env.REDIS_PORT || 6379,
    livekit,
  });

  await app.ready();
  t.after(async () => {
    mock.restoreAll();
    await app.close();
  });

  const participantsInRoom: Record<string, string[]> = {};
  mock.method(RoomServiceClient.prototype, 'listParticipants', async (room: string) => {
    if (!participantsInRoom[room]) throw new Error('room not found');
    return participantsInRoom[room].map((identity) => ({ identity }));
  });

  const send = async (event: object, secret?: string) => {
    const { body, authorization } = await signedWebhook(event, secret);
    return app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json', authorization },
      payload: body,
    });
  };

  const seedSession = async (userId: string, channelId: string) => {
    await app.redis.set(`user:${userId}:voice_channel`, channelId);
    await app.redis.sAdd(`channel:${channelId}:users`, userId);
  };

  await t.test('rechaza webhooks con firma inválida', async () => {
    const res = await send({ event: 'participant_left' }, 'otro-secret-que-no-coincide-32-chars');
    assert.strictEqual(res.statusCode, 401);
  });

  await t.test('rechaza webhooks sin header de autorización', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json' },
      payload: JSON.stringify({ event: 'participant_left' }),
    });
    assert.strictEqual(res.statusCode, 401);
  });

  await t.test('participant_left saca al usuario del canal (p. ej. cerró la pestaña)', async () => {
    await seedSession('wh-user-1', 'wh-chan-1');

    const res = await send({
      event: 'participant_left',
      room: { name: 'wh-chan-1' },
      participant: { identity: 'wh-user-1' },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(await app.redis.sMembers('channel:wh-chan-1:users'), []);
    assert.strictEqual(await app.redis.get('user:wh-user-1:voice_channel'), null);
  });

  await t.test('participant_left no saca al usuario si sigue en la sala (recargó la página)', async () => {
    await seedSession('wh-user-2', 'wh-chan-2');
    participantsInRoom['wh-chan-2'] = ['wh-user-2'];

    await send({
      event: 'participant_left',
      room: { name: 'wh-chan-2' },
      participant: { identity: 'wh-user-2' },
    });

    assert.deepStrictEqual(await app.redis.sMembers('channel:wh-chan-2:users'), ['wh-user-2']);
    assert.strictEqual(await app.redis.get('user:wh-user-2:voice_channel'), 'wh-chan-2');
    delete participantsInRoom['wh-chan-2'];
    await app.redis.del(['channel:wh-chan-2:users', 'user:wh-user-2:voice_channel']);
  });

  await t.test('participant_left del canal anterior no borra la sesión del canal nuevo', async () => {
    await seedSession('wh-user-3', 'wh-chan-new');
    await app.redis.sAdd('channel:wh-chan-old:users', 'wh-user-3');

    await send({
      event: 'participant_left',
      room: { name: 'wh-chan-old' },
      participant: { identity: 'wh-user-3' },
    });

    assert.deepStrictEqual(await app.redis.sMembers('channel:wh-chan-old:users'), []);
    assert.strictEqual(await app.redis.get('user:wh-user-3:voice_channel'), 'wh-chan-new');
    await app.redis.del(['channel:wh-chan-new:users', 'user:wh-user-3:voice_channel']);
  });

  await t.test('participant_connection_aborted limpia una sesión que nunca llegó a conectarse', async () => {
    await seedSession('wh-user-4', 'wh-chan-4');

    await send({
      event: 'participant_connection_aborted',
      room: { name: 'wh-chan-4' },
      participant: { identity: 'wh-user-4' },
    });

    assert.deepStrictEqual(await app.redis.sMembers('channel:wh-chan-4:users'), []);
    assert.strictEqual(await app.redis.get('user:wh-user-4:voice_channel'), null);
  });

  await t.test('room_finished deja el canal vacío', async () => {
    await seedSession('wh-user-5', 'wh-chan-5');
    await seedSession('wh-user-6', 'wh-chan-5');

    const res = await send({ event: 'room_finished', room: { name: 'wh-chan-5' } });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(await app.redis.sMembers('channel:wh-chan-5:users'), []);
    assert.strictEqual(await app.redis.get('user:wh-user-5:voice_channel'), null);
    assert.strictEqual(await app.redis.get('user:wh-user-6:voice_channel'), null);
  });

  await t.test('ignora otros eventos', async () => {
    const res = await send({ event: 'track_published', room: { name: 'wh-chan-7' } });
    assert.strictEqual(res.statusCode, 200);
  });
});
