import { test, mock } from 'node:test';
import assert from 'node:assert';
import { ChatClient, ChatServiceUnavailableError } from '../src/modules/calls/chat';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const fastRetry = { baseUrl: 'http://chat.test:3000/', baseDelayMs: 1, timeoutMs: 100 };

test('Cliente de Chat (llamadas privadas)', async (t) => {
  t.afterEach(() => mock.restoreAll());

  await t.test('usa CHAT_SERVICE_URL o el nombre del contenedor por defecto', async () => {
    const urls: string[] = [];
    mock.method(global, 'fetch', async (url: string) => {
      urls.push(String(url));
      return json(404, { code: 'USER_NOT_FOUND' });
    });

    const saved = process.env.CHAT_SERVICE_URL;
    delete process.env.CHAT_SERVICE_URL;
    await new ChatClient().getCanonical('u1');
    process.env.CHAT_SERVICE_URL = 'http://from-env:4000';
    await new ChatClient().getCanonical('u 2');
    if (saved === undefined) delete process.env.CHAT_SERVICE_URL;
    else process.env.CHAT_SERVICE_URL = saved;

    assert.deepStrictEqual(urls, [
      'http://chat-engine-service:3000/internal/users/u1/canonical',
      'http://from-env:4000/internal/users/u%202/canonical',
    ]);
  });

  await t.test('call-access: reintenta 5xx y timeouts, después responde', async () => {
    let calls = 0;
    mock.method(global, 'fetch', async () => {
      calls += 1;
      if (calls === 1) throw new DOMException('timeout', 'TimeoutError');
      if (calls === 2) return json(502);
      return json(200, { conversationId: 'dm-1', userId: 'a', otherUserId: 'b' });
    });

    const access = await new ChatClient(fastRetry).getCallAccess('dm-1', 'a');

    assert.deepStrictEqual(access, { result: 'allowed', conversationId: 'dm-1', userId: 'a', otherUserId: 'b' });
    assert.strictEqual(calls, 3);
  });

  await t.test('call-access: agota los reintentos → ChatServiceUnavailableError', async () => {
    const fetchMock = mock.method(global, 'fetch', async () => json(503));
    await assert.rejects(new ChatClient(fastRetry).getCallAccess('dm-1', 'a'), ChatServiceUnavailableError);
    assert.strictEqual(fetchMock.mock.callCount(), 3);
  });

  await t.test('call-access: un 4xx fuera de contrato no se reintenta', async () => {
    const fetchMock = mock.method(global, 'fetch', async () => json(400, { status: 400 }));
    await assert.rejects(new ChatClient(fastRetry).getCallAccess('dm-1', 'a'), ChatServiceUnavailableError);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  await t.test('call-access: 403 con y sin código, 404 con código', async () => {
    const responses = [json(403, { code: 'DM_PENDING' }), json(403, 'no json object'), json(404, { code: 'CONVERSATION_NOT_FOUND' })];
    mock.method(global, 'fetch', async () => responses.shift());
    const client = new ChatClient(fastRetry);

    assert.deepStrictEqual(await client.getCallAccess('dm-1', 'a'), { result: 'forbidden', code: 'DM_PENDING' });
    assert.deepStrictEqual(await client.getCallAccess('dm-1', 'a'), { result: 'forbidden' });
    assert.deepStrictEqual(await client.getCallAccess('dm-1', 'a'), { result: 'not_found' });
  });

  await t.test('404 sin código (Chat sin las rutas de llamadas) → no disponible, sin reintentar', async () => {
    const fetchMock = mock.method(global, 'fetch', async () => json(404, { detail: 'Route GET /internal/x not found' }));
    const client = new ChatClient(fastRetry);

    await assert.rejects(client.getCallAccess('dm-1', 'a'), ChatServiceUnavailableError);
    await assert.rejects(client.getCanonical('alias'), ChatServiceUnavailableError);
    assert.strictEqual(fetchMock.mock.callCount(), 2);
  });

  await t.test('call-access: body 200 fuera de contrato → no disponible', async () => {
    mock.method(global, 'fetch', async () => new Response('not json', { status: 200 }));
    await assert.rejects(new ChatClient(fastRetry).getCallAccess('dm-1', 'a'), ChatServiceUnavailableError);
  });

  await t.test('canonical: usuario, 404 → null, 403 o body inválido → no disponible', async () => {
    const responses = [json(200, { userId: 'canon', suspended: true }), json(404, { code: 'USER_NOT_FOUND' }), json(403), json(200, {})];
    mock.method(global, 'fetch', async () => responses.shift());
    const client = new ChatClient(fastRetry);

    assert.deepStrictEqual(await client.getCanonical('alias'), { userId: 'canon', suspended: true });
    assert.strictEqual(await client.getCanonical('alias'), null);
    await assert.rejects(client.getCanonical('alias'), ChatServiceUnavailableError);
    await assert.rejects(client.getCanonical('alias'), ChatServiceUnavailableError);
  });

  await t.test('inbox: POST con los usuarios y el evento, un solo intento', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const responses = [json(202), json(500)];
    mock.method(global, 'fetch', async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return responses.shift();
    });
    const client = new ChatClient(fastRetry);

    await client.publishInboxEvent(['a', 'b'], { type: 'CALL_RINGING', call: { id: 'x' } });
    await assert.rejects(client.publishInboxEvent(['a'], { type: 'CALL_ENDED' }), ChatServiceUnavailableError);

    assert.strictEqual(requests.length, 2, 'el 500 no se reintenta');
    assert.strictEqual(requests[0].url, 'http://chat.test:3000/internal/inbox/events');
    assert.strictEqual(requests[0].init.method, 'POST');
    assert.deepStrictEqual(JSON.parse(String(requests[0].init.body)), {
      userIds: ['a', 'b'],
      event: { type: 'CALL_RINGING', call: { id: 'x' } },
    });
    assert.strictEqual((requests[0].init.headers as Record<string, string>)['x-user-id'], undefined);
  });

  await t.test('inbox: manda X-Internal-Token si hay uno configurado, y no si no', async () => {
    const headers: Record<string, string>[] = [];
    mock.method(global, 'fetch', async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return json(202);
    });

    await new ChatClient({ ...fastRetry, internalToken: 'secreto' }).publishInboxEvent(['a'], { type: 'CALL_ENDED' });
    await new ChatClient({ ...fastRetry, internalToken: '' }).publishInboxEvent(['a'], { type: 'CALL_ENDED' });

    assert.strictEqual(headers[0]['x-internal-token'], 'secreto');
    assert.strictEqual('x-internal-token' in headers[1], false);
  });

  await t.test('inbox: error de red → no disponible', async () => {
    mock.method(global, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(new ChatClient(fastRetry).publishInboxEvent(['a'], { type: 'CALL_ENDED' }), ChatServiceUnavailableError);
  });
});
