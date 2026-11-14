import { test, mock } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import buildApp from '../src/app';
import { handleMemberEvent } from '../src/modules/voice/moderation';
import { callKeys, CallState } from '../src/modules/calls/state';

const livekit = {
  apiKey: 'test-key',
  apiSecret: 'test-secret-at-least-32-chars-long',
  url: 'http://livekit.test:7880',
  publicUrl: 'ws://livekit.test:7880',
};

const CHAT_URL = 'http://chat.test:3000';

// ── Chat de mentira: conversaciones, alias, bloqueos y el inbox ─────────────────────────────────────

interface Conversation {
  participants: [string, string];
  /** Respuesta 403 de call-access (bloqueo, pending). */
  forbiddenCode?: string;
  /** Si está, `forbiddenCode` aplica solo a ese participante (p. ej. `pending` para uno solo). */
  forbiddenFor?: string;
}

const chat = {
  conversations: new Map<string, Conversation>(),
  /** X-User-Id crudo → id canónico (alias federados). */
  aliases: new Map<string, string>(),
  down: false,
  /** Chat anterior a las llamadas: no tiene las rutas internas (404 de ruta, sin código). */
  legacy: false,
  inboxDown: false,
  events: [] as { userIds: string[]; event: { type: string; call: CallState } }[],
  requests: [] as string[],
};

const canonicalOf = (raw: string) => chat.aliases.get(raw) ?? raw;
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function fakeChat(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  chat.requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (url.origin !== CHAT_URL) throw new TypeError(`unexpected fetch ${url}`);

  if (url.pathname === '/internal/inbox/events') {
    if (chat.inboxDown) throw new TypeError('fetch failed');
    chat.events.push(JSON.parse(String(init?.body)));
    return json(202);
  }
  if (chat.down) throw new TypeError('fetch failed');
  if (chat.legacy) return json(404, { title: 'Not Found', status: 404, detail: `Route GET ${url.pathname} not found` });

  const access = url.pathname.match(/^\/internal\/conversations\/([^/]+)\/call-access$/);
  if (access) {
    const conversationId = decodeURIComponent(access[1]);
    const conversation = chat.conversations.get(conversationId);
    if (!conversation) return json(404, { title: 'Not Found', status: 404, code: 'CONVERSATION_NOT_FOUND' });
    const userId = canonicalOf(url.searchParams.get('user_id') ?? '');
    if (!conversation.participants.includes(userId)) return json(403, { title: 'Forbidden', status: 403 });
    if (conversation.forbiddenCode && (!conversation.forbiddenFor || conversation.forbiddenFor === userId)) {
      return json(403, { status: 403, code: conversation.forbiddenCode });
    }
    const otherUserId = conversation.participants.find((id) => id !== userId);
    return json(200, { conversationId, userId, otherUserId });
  }

  const canonical = url.pathname.match(/^\/internal\/users\/([^/]+)\/canonical$/);
  if (canonical) {
    const raw = decodeURIComponent(canonical[1]);
    if (raw.startsWith('ghost')) return json(404, { status: 404, code: 'USER_NOT_FOUND' });
    return json(200, { userId: canonicalOf(raw), suspended: false });
  }
  return json(404, {});
}

// ── LiveKit de mentira ───────────────────────────────────────────────────────────────────────────

const rooms = {
  created: [] as { name: string; maxParticipants?: number; emptyTimeout?: number }[],
  deleted: [] as string[],
  removed: [] as [string, string][],
  participants: new Map<string, string[]>(),
  createError: null as Error | null,
};

let counter = 0;
/** Conversación nueva con dos usuarios nuevos: cada test usa ids propios (los archivos corren en paralelo). */
function pair(prefix = 'c') {
  counter += 1;
  const tag = `${prefix}${counter}-${Date.now().toString(36)}`;
  const a = `${tag}-alice`;
  const b = `${tag}-bob`;
  const conversationId = `dm-${tag}`;
  chat.conversations.set(conversationId, { participants: [a, b] });
  return { a, b, conversationId };
}

const decodeToken = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

async function signedWebhook(event: object) {
  const body = JSON.stringify(event);
  const at = new AccessToken(livekit.apiKey, livekit.apiSecret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return { body, authorization: await at.toJwt() };
}

function newApp(ringTimeoutMs?: number) {
  return buildApp({
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: process.env.REDIS_PORT || 6379,
    livekit,
    calls: { chat: { baseUrl: CHAT_URL, baseDelayMs: 1, timeoutMs: 200 }, ringTimeoutMs },
  });
}

test('Llamadas privadas', async (t) => {
  const app = newApp();
  await app.ready();

  mock.method(global, 'fetch', fakeChat);
  mock.method(RoomServiceClient.prototype, 'createRoom', async (options: { name: string }) => {
    if (rooms.createError) throw rooms.createError;
    rooms.created.push(options);
    return { name: options.name };
  });
  mock.method(RoomServiceClient.prototype, 'deleteRoom', async (room: string) => {
    rooms.deleted.push(room);
  });
  mock.method(RoomServiceClient.prototype, 'removeParticipant', async (room: string, identity: string) => {
    rooms.removed.push([room, identity]);
  });
  mock.method(RoomServiceClient.prototype, 'listParticipants', async (room: string) => {
    const identities = rooms.participants.get(room);
    if (!identities) throw new Error('room not found');
    return identities.map((identity) => ({ identity }));
  });

  t.after(async () => {
    mock.restoreAll();
    await app.close();
  });

  t.beforeEach(() => {
    chat.down = false;
    chat.legacy = false;
    chat.inboxDown = false;
    chat.events.length = 0;
    chat.requests.length = 0;
    rooms.created.length = 0;
    rooms.deleted.length = 0;
    rooms.removed.length = 0;
    rooms.createError = null;
  });

  const start = (userId: string, conversationId: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/voice/calls',
      headers: { 'x-user-id': userId },
      payload: { conversationId },
    });
  const action = (userId: string, callId: string, verb: 'accept' | 'decline' | 'end') =>
    app.inject({ method: 'POST', url: `/api/v1/voice/calls/${callId}/${verb}`, headers: { 'x-user-id': userId } });
  const current = (userId: string) =>
    app.inject({ method: 'GET', url: '/api/v1/voice/calls/current', headers: { 'x-user-id': userId } });
  const stateOf = async (callId: string) => JSON.parse((await app.redis.get(callKeys.call(callId))) ?? 'null') as CallState;
  const webhook = async (event: object) => {
    const { body, authorization } = await signedWebhook(event);
    return app.inject({
      method: 'POST',
      url: '/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json', authorization },
      payload: body,
    });
  };

  /** Llamada sonando de a hacia b. */
  const ringing = async () => {
    const p = pair();
    const res = await start(p.a, p.conversationId);
    assert.strictEqual(res.statusCode, 201, res.body);
    chat.events.length = 0;
    rooms.created.length = 0;
    return { ...p, callId: res.json().call.id as string, res };
  };

  /** Llamada activa entre a y b. */
  const active = async () => {
    const call = await ringing();
    const res = await action(call.b, call.callId, 'accept');
    assert.strictEqual(res.statusCode, 200, res.body);
    chat.events.length = 0;
    return call;
  };

  // ── Iniciar ──

  await t.test('iniciar: crea la sala de 2, da token de micrófono y avisa CALL_RINGING a los dos', async () => {
    const p = pair();
    const res = await start(p.a, p.conversationId);

    assert.strictEqual(res.statusCode, 201);
    const body = res.json();
    assert.strictEqual(body.call.status, 'ringing');
    assert.strictEqual(body.call.conversationId, p.conversationId);
    assert.strictEqual(body.call.callerId, p.a);
    assert.strictEqual(body.call.calleeId, p.b);
    assert.strictEqual(body.call.callerIdentity, undefined, 'el cliente no ve las identidades crudas');
    assert.strictEqual(Date.parse(body.call.expiresAt) - Date.parse(body.call.createdAt), 30_000);
    assert.strictEqual(body.url, livekit.publicUrl);
    assert.deepStrictEqual(body.permissions, { canSpeak: true, canVideo: true, canScreenShare: false });

    const room = `call-${body.call.id}`;
    assert.deepStrictEqual(rooms.created, [{ name: room, maxParticipants: 2, emptyTimeout: 60 }]);

    const token = decodeToken(body.token);
    assert.strictEqual(token.sub, p.a);
    assert.strictEqual(token.video.room, room);
    assert.deepStrictEqual(token.video.canPublishSources, ['microphone', 'camera']);
    assert.strictEqual(token.video.canSubscribe, true);
    assert.ok(token.exp - Math.floor(Date.now() / 1000) <= 600);

    assert.deepStrictEqual(chat.events, [{ userIds: [p.a, p.b], event: { type: 'CALL_RINGING', call: body.call } }]);
    assert.strictEqual(await app.redis.get(callKeys.user(p.a)), body.call.id);
    assert.strictEqual(await app.redis.get(callKeys.user(p.b)), body.call.id);
    const ttl = await app.redis.ttl(callKeys.call(body.call.id));
    assert.ok(ttl > 30 && ttl <= 45, `TTL mientras suena: ${ttl}`);
  });

  await t.test('iniciar: con alias guarda el id canónico y usa el X-User-Id crudo en LiveKit', async () => {
    const p = pair();
    const alias = `${p.a}-google`;
    chat.aliases.set(alias, p.a);

    const res = await start(alias, p.conversationId);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.json().call.callerId, p.a);
    assert.strictEqual(decodeToken(res.json().token).sub, alias);
    assert.strictEqual(await app.redis.get(callKeys.identity(alias)), p.a);
    assert.strictEqual(await app.redis.get(callKeys.user(p.a)), res.json().call.id);
  });

  await t.test('iniciar: 400 sin X-User-Id o sin conversationId', async () => {
    const noUser = await app.inject({ method: 'POST', url: '/api/v1/voice/calls', payload: { conversationId: 'dm-x' } });
    assert.strictEqual(noUser.statusCode, 400);
    assert.strictEqual(noUser.json().code, 'MISSING_USER_ID');

    const noConversation = await start('someone', '');
    assert.strictEqual(noConversation.statusCode, 400);
    assert.match(noConversation.headers['content-type'] as string, /application\/problem\+json/);
    assert.strictEqual(noConversation.json().code, 'VALIDATION_ERROR');
    assert.strictEqual((await start('someone', 42)).statusCode, 400);
  });

  await t.test('iniciar: bloqueo (403 de Chat) responde DM_NOT_DELIVERABLE sin crear nada', async () => {
    const p = pair();
    chat.conversations.get(p.conversationId)!.forbiddenCode = 'DM_NOT_DELIVERABLE';

    const res = await start(p.a, p.conversationId);

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().code, 'DM_NOT_DELIVERABLE');
    assert.strictEqual(res.json().status, 403);
    assert.deepStrictEqual(rooms.created, []);
    assert.deepStrictEqual(chat.events, []);
    assert.strictEqual(await app.redis.exists([callKeys.user(p.a), callKeys.user(p.b)]), 0);
  });

  await t.test('iniciar: DM_PENDING si falta aceptar la conversación', async () => {
    const p = pair();
    chat.conversations.get(p.conversationId)!.forbiddenCode = 'DM_PENDING';
    const res = await start(p.a, p.conversationId);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().code, 'DM_PENDING');
  });

  await t.test('iniciar: 404 si la conversación no existe o no participa', async () => {
    const missing = await start('someone', 'dm-does-not-exist');
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(missing.json().code, 'CONVERSATION_NOT_FOUND');

    const p = pair();
    const outsider = await start(`${p.a}-outsider`, p.conversationId);
    assert.strictEqual(outsider.statusCode, 404);
    assert.strictEqual(outsider.json().code, 'CONVERSATION_NOT_FOUND');
  });

  await t.test('iniciar: 503 si Chat todavía no tiene las rutas de llamadas (404 sin código)', async () => {
    const p = pair();
    chat.legacy = true;
    const res = await start(p.a, p.conversationId);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().code, 'CHAT_UNAVAILABLE');
    assert.strictEqual(chat.events.length, 0);
  });

  await t.test('iniciar: 503 si Chat no responde, sin crear nada', async () => {
    const p = pair();
    chat.down = true;

    const res = await start(p.a, p.conversationId);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().code, 'CHAT_UNAVAILABLE');
    assert.deepStrictEqual(rooms.created, []);
    assert.strictEqual(await app.redis.exists([callKeys.user(p.a), callKeys.user(p.b)]), 0);
    assert.strictEqual(chat.requests.length, 3, 'las lecturas se reintentan');
  });

  await t.test('iniciar: 503 si no se puede avisar por el inbox; se deshace la reserva y la sala', async () => {
    const p = pair();
    chat.inboxDown = true;

    const res = await start(p.a, p.conversationId);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().code, 'CHAT_UNAVAILABLE');
    assert.strictEqual(rooms.deleted.length, 1);
    assert.strictEqual(await app.redis.exists([callKeys.user(p.a), callKeys.user(p.b)]), 0);
    assert.strictEqual(chat.requests.filter((r) => r.startsWith('POST')).length, 1, 'publicar no se reintenta');

    chat.inboxDown = false;
    assert.strictEqual((await start(p.a, p.conversationId)).statusCode, 201, 'no quedó ocupado');
  });

  await t.test('iniciar: 503 si LiveKit no crea la sala; no queda ocupado', async () => {
    const p = pair();
    rooms.createError = new Error('connect ECONNREFUSED');

    const res = await start(p.a, p.conversationId);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().code, 'LIVEKIT_UNAVAILABLE');
    assert.deepStrictEqual(chat.events, []);
    assert.strictEqual(await app.redis.exists([callKeys.user(p.a), callKeys.user(p.b)]), 0);
  });

  // ── Ocupado ──

  await t.test('ocupado: 409 CALL_BUSY si quien recibe o quien llama ya está en una llamada', async () => {
    const call = await ringing();
    const other = pair();
    chat.conversations.set(`dm-${other.a}-busy`, { participants: [other.a, call.b] });
    chat.conversations.set(`dm-${call.a}-busy`, { participants: [call.a, other.b] });

    const calleeBusy = await start(other.a, `dm-${other.a}-busy`);
    assert.strictEqual(calleeBusy.statusCode, 409);
    assert.strictEqual(calleeBusy.json().code, 'CALL_BUSY');
    assert.strictEqual(await app.redis.exists(callKeys.user(other.a)), 0, 'no deja reservado a quien llamó');

    const callerBusy = await start(call.a, `dm-${call.a}-busy`);
    assert.strictEqual(callerBusy.statusCode, 409);
    assert.strictEqual(await app.redis.exists(callKeys.user(other.b)), 0);
    assert.deepStrictEqual(rooms.created, []);
  });

  await t.test('ocupado: dos llamadas a la vez a la misma persona, solo una suena', async () => {
    const p = pair();
    const c = `${p.a}-carol`;
    chat.conversations.set(`dm-${c}`, { participants: [c, p.b] });

    const results = await Promise.all([start(p.a, p.conversationId), start(c, `dm-${c}`)]);

    assert.deepStrictEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  });

  // ── Aceptar ──

  await t.test('aceptar: token para quien recibe y CALL_ACCEPTED a los dos', async () => {
    const call = await ringing();

    const res = await action(call.b, call.callId, 'accept');

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.call.status, 'active');
    assert.ok(body.call.answeredAt);
    const token = decodeToken(body.token);
    assert.strictEqual(token.sub, call.b);
    assert.strictEqual(token.video.room, `call-${call.callId}`);
    assert.deepStrictEqual(token.video.canPublishSources, ['microphone', 'camera']);
    assert.deepStrictEqual(chat.events, [{ userIds: [call.a, call.b], event: { type: 'CALL_ACCEPTED', call: body.call } }]);
    assert.ok((await app.redis.ttl(callKeys.user(call.a))) > 45, 'activa: el ocupado dura lo que la llamada');
    assert.strictEqual((await stateOf(call.callId)).calleeIdentity, call.b);
  });

  await t.test('aceptar: bloqueo mientras sonaba → 403 y la llamada termina unavailable', async () => {
    const call = await ringing();
    chat.conversations.get(call.conversationId)!.forbiddenCode = 'DM_NOT_DELIVERABLE';

    const res = await action(call.b, call.callId, 'accept');

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().code, 'DM_NOT_DELIVERABLE');
    const state = await stateOf(call.callId);
    assert.strictEqual(state.status, 'ended');
    assert.strictEqual(state.endReason, 'unavailable');
    assert.deepStrictEqual(rooms.deleted, [`call-${call.callId}`]);
    assert.strictEqual(chat.events[0].event.type, 'CALL_ENDED');
    assert.strictEqual(chat.events[0].event.call.endReason, 'unavailable');
  });

  await t.test('aceptar: conversación sin aceptar para quien recibe (llama quien la rechazó) → atiende igual', async () => {
    // Chat deja llamar a quien rechazó la solicitud, pero para quien la mandó sigue pendiente
    const call = await ringing();
    const conversation = chat.conversations.get(call.conversationId)!;
    conversation.forbiddenCode = 'DM_PENDING';
    conversation.forbiddenFor = call.b;

    const res = await action(call.b, call.callId, 'accept');

    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(res.json().call.status, 'active');
    assert.strictEqual(decodeToken(res.json().token).sub, call.b);
    assert.strictEqual((await stateOf(call.callId)).status, 'active');
    assert.deepStrictEqual(rooms.deleted, []);
    assert.strictEqual(chat.events[0].event.type, 'CALL_ACCEPTED');
  });

  await t.test('aceptar: la conversación desapareció → 404 y termina unavailable', async () => {
    const call = await ringing();
    chat.conversations.delete(call.conversationId);
    const res = await action(call.b, call.callId, 'accept');
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((await stateOf(call.callId)).endReason, 'unavailable');
  });

  await t.test('aceptar: con Chat caído responde 503 y sigue sonando', async () => {
    const call = await ringing();
    chat.down = true;
    const res = await action(call.b, call.callId, 'accept');
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual((await stateOf(call.callId)).status, 'ringing');
  });

  await t.test('aceptar: solo quien recibe, solo sonando, solo si existe', async () => {
    const call = await ringing();

    const byCaller = await action(call.a, call.callId, 'accept');
    assert.strictEqual(byCaller.statusCode, 403);
    assert.strictEqual(byCaller.json().code, 'CALL_NOT_CALLEE');

    const byStranger = await action(`${call.a}-stranger`, call.callId, 'accept');
    assert.strictEqual(byStranger.statusCode, 404);
    assert.strictEqual(byStranger.json().code, 'CALL_NOT_FOUND');

    assert.strictEqual((await action(call.b, call.callId, 'accept')).statusCode, 200);
    const twice = await action(call.b, call.callId, 'accept');
    assert.strictEqual(twice.statusCode, 409);
    assert.strictEqual(twice.json().code, 'CALL_NOT_RINGING');

    assert.strictEqual((await action(call.b, '00000000-0000-4000-8000-000000000000', 'accept')).statusCode, 404);
    assert.strictEqual((await action(call.b, 'not-a-uuid', 'accept')).statusCode, 404);
  });

  await t.test('aceptar desde dos dispositivos a la vez: gana uno', async () => {
    const call = await ringing();
    const results = await Promise.all([action(call.b, call.callId, 'accept'), action(call.b, call.callId, 'accept')]);
    assert.deepStrictEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  });

  // ── Rechazar ──

  await t.test('rechazar: CALL_ENDED declined a los dos, borra la sala y libera el ocupado', async () => {
    const call = await ringing();

    const res = await action(call.b, call.callId, 'decline');

    assert.strictEqual(res.statusCode, 204);
    const state = await stateOf(call.callId);
    assert.strictEqual(state.status, 'ended');
    assert.strictEqual(state.endReason, 'declined');
    assert.ok(state.endedAt);
    assert.deepStrictEqual(rooms.deleted, [`call-${call.callId}`]);
    assert.strictEqual(chat.events.length, 1);
    assert.deepStrictEqual(chat.events[0].userIds, [call.a, call.b]);
    assert.strictEqual(chat.events[0].event.type, 'CALL_ENDED');
    assert.strictEqual(chat.events[0].event.call.endReason, 'declined');
    assert.strictEqual(await app.redis.exists([callKeys.user(call.a), callKeys.user(call.b)]), 0);
    const ttl = await app.redis.ttl(callKeys.call(call.callId));
    assert.ok(ttl > 45 && ttl <= 300, `terminada se guarda 5 min: ${ttl}`);
  });

  await t.test('rechazar: solo quien recibe y solo sonando', async () => {
    const call = await ringing();
    assert.strictEqual((await action(call.a, call.callId, 'decline')).statusCode, 403);
    assert.strictEqual((await action(call.b, call.callId, 'accept')).statusCode, 200);
    const res = await action(call.b, call.callId, 'decline');
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.json().code, 'CALL_NOT_RINGING');
  });

  // ── Cortar ──

  await t.test('cortar sonando: quien llama → canceled, quien recibe → declined', async () => {
    const byCaller = await ringing();
    assert.strictEqual((await action(byCaller.a, byCaller.callId, 'end')).statusCode, 204);
    assert.strictEqual((await stateOf(byCaller.callId)).endReason, 'canceled');

    const byCallee = await ringing();
    assert.strictEqual((await action(byCallee.b, byCallee.callId, 'end')).statusCode, 204);
    assert.strictEqual((await stateOf(byCallee.callId)).endReason, 'declined');
  });

  await t.test('cortar activa (cualquiera): deleteRoom y CALL_ENDED ended; idempotente', async () => {
    const call = await active();

    const res = await action(call.b, call.callId, 'end');

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual((await stateOf(call.callId)).endReason, 'ended');
    assert.deepStrictEqual(rooms.deleted, [`call-${call.callId}`]);
    assert.strictEqual(chat.events.length, 1);
    assert.strictEqual(chat.events[0].event.type, 'CALL_ENDED');

    assert.strictEqual((await action(call.a, call.callId, 'end')).statusCode, 204);
    assert.strictEqual(chat.events.length, 1, 'el segundo end no vuelve a avisar');
    assert.strictEqual(rooms.deleted.length, 1);
  });

  await t.test('cortar con Chat caído: funciona con la identidad cruda guardada', async () => {
    const call = await active();
    chat.down = true;
    chat.inboxDown = true;

    const res = await action(call.a, call.callId, 'end');

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual((await stateOf(call.callId)).endReason, 'ended');
    assert.deepStrictEqual(rooms.deleted, [`call-${call.callId}`], 'un fallo al avisar no frena el corte');
    assert.strictEqual(await app.redis.exists([callKeys.user(call.a), callKeys.user(call.b)]), 0);
  });

  await t.test('cortar con Chat caído desde una identidad desconocida → 503', async () => {
    const call = await ringing();
    chat.down = true;
    const res = await action(`${call.b}-unknown-alias`, call.callId, 'end');
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual((await stateOf(call.callId)).status, 'ringing');
  });

  await t.test('cortar: 404 si no participa', async () => {
    const call = await ringing();
    const res = await action(`${call.a}-intruder`, call.callId, 'end');
    assert.strictEqual(res.statusCode, 404);
  });

  // ── Llamada actual ──

  await t.test('current: la llamada sonando o activa de cada uno, null al terminar', async () => {
    const call = await ringing();

    const forCaller = await current(call.a);
    assert.strictEqual(forCaller.statusCode, 200);
    assert.strictEqual(forCaller.json().call.id, call.callId);
    assert.strictEqual(forCaller.json().call.callerIdentity, undefined);
    assert.strictEqual((await current(call.b)).json().call.status, 'ringing');

    await action(call.a, call.callId, 'end');
    assert.deepStrictEqual((await current(call.a)).json(), { call: null });
    assert.deepStrictEqual((await current('ghost-user')).json(), { call: null });
  });

  await t.test('current: 503 si Chat no responde y no se conoce la identidad', async () => {
    chat.down = true;
    const res = await current(`nobody-${Date.now()}`);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual((await current('')).statusCode, 400);
  });

  // ── Carreras ──

  await t.test('carrera aceptar vs vencer el timbre: gana uno solo', async () => {
    for (let i = 0; i < 5; i++) {
      const call = await ringing();
      const [accepted, missed] = await Promise.all([
        action(call.b, call.callId, 'accept'),
        app.calls.finish(call.callId, (state) => (state.status === 'ringing' ? 'missed' : null)),
      ]);
      const state = await stateOf(call.callId);
      if (accepted.statusCode === 200) {
        assert.strictEqual(missed, null);
        assert.strictEqual(state.status, 'active');
      } else {
        assert.strictEqual(accepted.statusCode, 409);
        assert.strictEqual(missed?.endReason, 'missed');
        assert.strictEqual(state.endReason, 'missed');
      }
    }
  });

  await t.test('la transición es compare-and-set: la segunda con el mismo estado leído pierde', async () => {
    const call = await ringing();
    const stored = await app.calls.store.get(call.callId);
    assert.ok(stored);
    const next = { ...stored.state, status: 'active' as const };
    assert.strictEqual(await app.calls.store.transition(stored, next), true);
    assert.strictEqual(await app.calls.store.transition(stored, { ...stored.state, status: 'ended' as const }), false);
  });

  // ── Webhooks de salas call- ──

  await t.test('webhook: quien llama se va mientras suena → canceled', async () => {
    const call = await ringing();
    const res = await webhook({
      event: 'participant_left',
      room: { name: `call-${call.callId}` },
      participant: { identity: call.a },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((await stateOf(call.callId)).endReason, 'canceled');
    assert.strictEqual(chat.events[0].event.type, 'CALL_ENDED');
  });

  await t.test('webhook: si sigue en la sala (recargó) no termina', async () => {
    const call = await active();
    const room = `call-${call.callId}`;
    rooms.participants.set(room, [call.a, call.b]);

    await webhook({ event: 'participant_connection_aborted', room: { name: room }, participant: { identity: call.a } });

    assert.strictEqual((await stateOf(call.callId)).status, 'active');
    rooms.participants.delete(room);
  });

  await t.test('webhook: cualquiera se va de una llamada activa → ended', async () => {
    const call = await active();
    await webhook({
      event: 'participant_connection_aborted',
      room: { name: `call-${call.callId}` },
      participant: { identity: call.b },
    });
    assert.strictEqual((await stateOf(call.callId)).endReason, 'ended');
  });

  await t.test('webhook: alguien que no es quien llama se va mientras suena → sigue sonando', async () => {
    const call = await ringing();
    await webhook({ event: 'participant_left', room: { name: `call-${call.callId}` }, participant: { identity: call.b } });
    assert.strictEqual((await stateOf(call.callId)).status, 'ringing');
  });

  await t.test('webhook: room_finished → canceled sonando, ended activa', async () => {
    const ringingCall = await ringing();
    await webhook({ event: 'room_finished', room: { name: `call-${ringingCall.callId}` } });
    assert.strictEqual((await stateOf(ringingCall.callId)).endReason, 'canceled');

    const activeCall = await active();
    await webhook({ event: 'room_finished', room: { name: `call-${activeCall.callId}` } });
    assert.strictEqual((await stateOf(activeCall.callId)).endReason, 'ended');
  });

  await t.test('webhook: participant_joined saca a quien entra a una llamada terminada o ajena', async () => {
    const call = await active();
    const room = `call-${call.callId}`;

    await webhook({ event: 'participant_joined', room: { name: room }, participant: { identity: call.b } });
    assert.deepStrictEqual(rooms.removed, [], 'los participantes entran');

    await webhook({ event: 'participant_joined', room: { name: room }, participant: { identity: 'intruder' } });
    assert.deepStrictEqual(rooms.removed, [[room, 'intruder']]);

    await action(call.a, call.callId, 'end');
    rooms.removed.length = 0;
    await webhook({ event: 'participant_joined', room: { name: room }, participant: { identity: call.a } });
    assert.deepStrictEqual(rooms.removed, [[room, call.a]]);
  });

  await t.test('webhook: salas call- con id inválido o sin identidad se ignoran', async () => {
    assert.strictEqual((await webhook({ event: 'room_finished', room: { name: 'call-nope' } })).statusCode, 200);
    const call = await ringing();
    await webhook({ event: 'participant_left', room: { name: `call-${call.callId}` } });
    await webhook({ event: 'participant_joined', room: { name: `call-${call.callId}` } });
    await webhook({ event: 'track_published', room: { name: `call-${call.callId}` } });
    assert.strictEqual((await stateOf(call.callId)).status, 'ringing');
  });

  await t.test('webhook: una llamada no toca las claves ni la presencia de los canales', async () => {
    const call = await active();
    await app.redis.set(`user:${call.a}:voice_channel`, 'chan-of-alice');
    await app.redis.sAdd('channel:chan-of-alice:users', call.a);
    const published = mock.method(app.voicePresence, 'publish', async () => {});

    await webhook({ event: 'participant_left', room: { name: `call-${call.callId}` }, participant: { identity: call.a } });
    await webhook({ event: 'room_finished', room: { name: `call-${call.callId}` } });

    assert.strictEqual((await stateOf(call.callId)).endReason, 'ended');
    assert.strictEqual(await app.redis.get(`user:${call.a}:voice_channel`), 'chan-of-alice');
    assert.deepStrictEqual(await app.redis.sMembers('channel:chan-of-alice:users'), [call.a]);
    assert.strictEqual(await app.redis.exists(`channel:call-${call.callId}:users`), 0);
    assert.strictEqual(published.mock.callCount(), 0);
    published.mock.restore();
    await app.redis.del([`user:${call.a}:voice_channel`, 'channel:chan-of-alice:users']);
  });

  // ── Cuenta suspendida ──

  await t.test('user.suspended termina la llamada de cualquiera de sus identidades (unavailable)', async () => {
    const p = pair();
    const alias = `${p.b}-github`;
    chat.aliases.set(alias, p.b);
    const res = await start(p.a, p.conversationId);
    const callId = res.json().call.id;
    assert.strictEqual((await action(alias, callId, 'accept')).statusCode, 200);
    chat.events.length = 0;

    // El evento trae solo el alias: el canónico sale de call:identity
    await handleMemberEvent(app)('user.suspended', { user_id: alias, identities: [alias] });

    const state = await stateOf(callId);
    assert.strictEqual(state.endReason, 'unavailable');
    assert.strictEqual(chat.events[0].event.call.endReason, 'unavailable');
    assert.ok(rooms.deleted.includes(`call-${callId}`));
    await app.redis.del([`voice:suspended:${alias}`]);
  });

  await t.test('user.suspended sin llamada no hace nada', async () => {
    assert.strictEqual(await app.calls.endForIdentities([`nobody-${Date.now()}`]), 0);
  });

  await t.test('un fallo de Redis en una ruta responde 500 en Problem Details', async () => {
    const failing = mock.method(app.calls.store, 'getIdentity', async () => {
      throw new Error('redis down');
    });
    const res = await current('anyone');
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.json().code, 'INTERNAL_ERROR');
    failing.mock.restore();
  });
});

test('Llamada sin respuesta: el timer termina missed', async (t) => {
  const app = newApp(150);
  await app.ready();
  mock.method(global, 'fetch', fakeChat);
  mock.method(RoomServiceClient.prototype, 'createRoom', async (options: { name: string }) => ({ name: options.name }));
  const deleted: string[] = [];
  mock.method(RoomServiceClient.prototype, 'deleteRoom', async (room: string) => {
    deleted.push(room);
  });
  t.after(async () => {
    mock.restoreAll();
    await app.close();
  });
  chat.events.length = 0;

  const p = pair('timer');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/voice/calls',
    headers: { 'x-user-id': p.a },
    payload: { conversationId: p.conversationId },
  });
  const callId = res.json().call.id;

  await new Promise((resolve) => setTimeout(resolve, 400));

  const state = JSON.parse((await app.redis.get(callKeys.call(callId))) ?? 'null') as CallState;
  assert.strictEqual(state.status, 'ended');
  assert.strictEqual(state.endReason, 'missed');
  assert.deepStrictEqual(deleted, [`call-${callId}`]);
  const ended = chat.events.find((e) => e.event.type === 'CALL_ENDED');
  assert.strictEqual(ended?.event.call.endReason, 'missed');
  assert.deepStrictEqual(ended?.userIds, [p.a, p.b]);

  // Aceptar después de vencer: ya no suena
  const late = await app.inject({
    method: 'POST',
    url: `/api/v1/voice/calls/${callId}/accept`,
    headers: { 'x-user-id': p.b },
  });
  assert.strictEqual(late.statusCode, 409);
});

test('Aceptar cancela el timer: no termina missed después', async (t) => {
  const app = newApp(150);
  await app.ready();
  mock.method(global, 'fetch', fakeChat);
  mock.method(RoomServiceClient.prototype, 'createRoom', async (options: { name: string }) => ({ name: options.name }));
  mock.method(RoomServiceClient.prototype, 'deleteRoom', async () => {});
  t.after(async () => {
    mock.restoreAll();
    await app.close();
  });

  const p = pair('timer');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/voice/calls',
    headers: { 'x-user-id': p.a },
    payload: { conversationId: p.conversationId },
  });
  const callId = res.json().call.id;
  await app.inject({ method: 'POST', url: `/api/v1/voice/calls/${callId}/accept`, headers: { 'x-user-id': p.b } });

  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = JSON.parse((await app.redis.get(callKeys.call(callId))) ?? 'null') as CallState;
  assert.strictEqual(state.status, 'active');
});
