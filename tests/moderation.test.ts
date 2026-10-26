import { test, mock } from 'node:test';
import assert from 'node:assert';
import { RoomServiceClient } from 'livekit-server-sdk';
import buildApp from '../src/app';
import { handleMemberEvent, removeFromServerVoice } from '../src/modules/voice/moderation';
import { keys } from '../src/modules/voice/sessions';

const livekit = {
  apiKey: 'test-key',
  apiSecret: 'test-secret-at-least-32-chars-long',
  url: 'http://livekit.test:7880',
  publicUrl: 'ws://livekit.test:7880',
};

test('Sacar de la llamada al baneado o expulsado', async (t) => {
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

  let removeError: unknown = null;
  const removed: [string, string][] = [];
  mock.method(RoomServiceClient.prototype, 'removeParticipant', async (room: string, identity: string) => {
    if (removeError) throw removeError;
    removed.push([room, identity]);
  });

  const seedCall = async (userId: string, channelId: string, serverId: string) => {
    await app.redis.set(keys.userChannel(userId), channelId);
    await app.redis.set(keys.userServer(userId), serverId);
    await app.redis.set(keys.channelServer(channelId), serverId);
    await app.redis.sAdd(keys.channelUsers(channelId), userId);
  };

  t.beforeEach(() => {
    removed.length = 0;
    removeError = null;
  });

  await t.test('saca al usuario de la llamada del servidor y lo bloquea', async () => {
    await seedCall('mod-u1', 'mod-chan-1', 'mod-srv-1');

    assert.strictEqual(await removeFromServerVoice(app, 'mod-srv-1', 'mod-u1'), true);

    assert.deepStrictEqual(removed, [['mod-chan-1', 'mod-u1']]);
    assert.deepStrictEqual(await app.redis.sMembers(keys.channelUsers('mod-chan-1')), []);
    assert.strictEqual(await app.redis.get(keys.userChannel('mod-u1')), null);
    assert.strictEqual(await app.redis.get(keys.userServer('mod-u1')), null);
    assert.strictEqual(await app.redis.exists(keys.blocked('mod-srv-1', 'mod-u1')), 1);
    assert.ok((await app.redis.ttl(keys.blocked('mod-srv-1', 'mod-u1'))) > 0, 'el bloqueo vence solo');
  });

  await t.test('no lo saca de una llamada de otro servidor, pero lo bloquea en el suyo', async () => {
    await seedCall('mod-u2', 'mod-chan-2', 'mod-srv-other');

    assert.strictEqual(await removeFromServerVoice(app, 'mod-srv-2', 'mod-u2'), false);

    assert.deepStrictEqual(removed, []);
    assert.strictEqual(await app.redis.get(keys.userChannel('mod-u2')), 'mod-chan-2');
    assert.deepStrictEqual(await app.redis.sMembers(keys.channelUsers('mod-chan-2')), ['mod-u2']);
    assert.strictEqual(await app.redis.exists(keys.blocked('mod-srv-2', 'mod-u2')), 1);
  });

  await t.test('si no está en ninguna llamada solo lo bloquea', async () => {
    assert.strictEqual(await removeFromServerVoice(app, 'mod-srv-3', 'mod-u3'), false);

    assert.deepStrictEqual(removed, []);
    assert.strictEqual(await app.redis.exists(keys.blocked('mod-srv-3', 'mod-u3')), 1);
  });

  await t.test('si LiveKit dice que ya no está en la sala, igual limpia la sesión', async () => {
    await seedCall('mod-u4', 'mod-chan-4', 'mod-srv-4');
    removeError = Object.assign(new Error('participant not found'), { status: 404, code: 'not_found' });

    assert.strictEqual(await removeFromServerVoice(app, 'mod-srv-4', 'mod-u4'), true);
    assert.strictEqual(await app.redis.get(keys.userChannel('mod-u4')), null);
  });

  await t.test('si LiveKit falla por otra cosa, propaga el error (el consumidor lo registra)', async () => {
    await seedCall('mod-u5', 'mod-chan-5', 'mod-srv-5');
    removeError = new Error('connect ECONNREFUSED');

    await assert.rejects(removeFromServerVoice(app, 'mod-srv-5', 'mod-u5'), /ECONNREFUSED/);
    // El bloqueo ya quedó guardado: si vuelve a entrar con su token, el webhook lo saca
    assert.strictEqual(await app.redis.exists(keys.blocked('mod-srv-5', 'mod-u5')), 1);
  });

  await t.test('el handler aplica ban, kick y salida, e ignora el resto', async () => {
    const handler = handleMemberEvent(app);

    for (const [i, routingKey] of ['member.banned', 'member.kicked', 'member.left'].entries()) {
      await seedCall(`mod-h${i}`, `mod-hchan-${i}`, 'mod-hsrv');
      await handler(routingKey, { server_id: 'mod-hsrv', user_id: `mod-h${i}` });
    }
    assert.deepStrictEqual(removed, [
      ['mod-hchan-0', 'mod-h0'],
      ['mod-hchan-1', 'mod-h1'],
      ['mod-hchan-2', 'mod-h2'],
    ]);

    await seedCall('mod-h9', 'mod-hchan-9', 'mod-hsrv');
    await handler('member.muted', { server_id: 'mod-hsrv', user_id: 'mod-h9' });
    await handler('member.banned', { user_id: 'mod-h9' });
    await handler('member.banned', { server_id: 'mod-hsrv' });
    assert.strictEqual(removed.length, 3);
    assert.strictEqual(await app.redis.get(keys.userChannel('mod-h9')), 'mod-hchan-9');
  });
});
