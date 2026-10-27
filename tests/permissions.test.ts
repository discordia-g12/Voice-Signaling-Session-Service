import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  checkCanConnect,
  checkCanView,
  checkConnectAccess,
  PermissionServiceUnavailableError,
} from '../src/modules/voice/permissions';

// Reintentos rápidos para que los tests no esperen
const fast = { timeoutMs: 50, attempts: 3, baseDelayMs: 1 };

// Simula una secuencia de respuestas de Server-Roles, una por intento
function mockServerRoles(...responses: (number | 'network-error' | 'hang')[]) {
  let call = 0;
  return mock.method(global, 'fetch', async (_url: string, init?: RequestInit) => {
    const response = responses[Math.min(call++, responses.length - 1)];
    if (response === 'network-error') throw new TypeError('fetch failed');
    if (response === 'hang') {
      // No responde nunca: solo termina cuando vence el timeout del intento
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    return { ok: response >= 200 && response < 300, status: response };
  });
}

afterEach(() => mock.restoreAll());

test('devuelve allowed, forbidden y not_found sin reintentar', async () => {
  for (const [status, expected] of [
    [200, 'allowed'],
    [403, 'forbidden'],
    [404, 'not_found'],
  ] as const) {
    const fetchMock = mockServerRoles(status);
    assert.strictEqual(await checkCanConnect('auth0|u', 'chan', fast), expected);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
    mock.restoreAll();
  }
});

test('reintenta ante un 5xx y responde cuando Server-Roles se recupera', async () => {
  const fetchMock = mockServerRoles(503, 500, 200);
  assert.strictEqual(await checkCanConnect('auth0|u', 'chan', fast), 'allowed');
  assert.strictEqual(fetchMock.mock.callCount(), 3);
});

test('reintenta ante errores de red', async () => {
  const fetchMock = mockServerRoles('network-error', 200);
  assert.strictEqual(await checkCanConnect('auth0|u', 'chan', fast), 'allowed');
  assert.strictEqual(fetchMock.mock.callCount(), 2);
});

test('corta cada intento por timeout si Server-Roles no responde', async () => {
  // El timer de AbortSignal.timeout no mantiene vivo el proceso; en el servicio lo mantiene el
  // servidor HTTP, acá hay que hacerlo a mano para que el timeout llegue a dispararse
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const fetchMock = mockServerRoles('hang', 200);
    const start = Date.now();
    assert.strictEqual(await checkCanConnect('auth0|u', 'chan', fast), 'allowed');
    assert.strictEqual(fetchMock.mock.callCount(), 2);
    assert.ok(Date.now() - start < 1000, 'no debe quedar colgado');
  } finally {
    clearInterval(keepAlive);
  }
});

test('tira PermissionServiceUnavailableError al agotar los intentos', async () => {
  const fetchMock = mockServerRoles(503);
  await assert.rejects(checkCanConnect('auth0|u', 'chan', fast), PermissionServiceUnavailableError);
  assert.strictEqual(fetchMock.mock.callCount(), 3);
});

test('no reintenta respuestas 4xx inesperadas', async () => {
  const fetchMock = mockServerRoles(400);
  await assert.rejects(checkCanConnect('auth0|u', 'chan', fast), /respondió 400/);
  assert.strictEqual(fetchMock.mock.callCount(), 1);
});

test('checkConnectAccess devuelve el servidor del canal', async () => {
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ can_connect: true, server_id: 'srv-1' }),
  }));
  const access = await checkConnectAccess('auth0|u', 'chan', fast);
  assert.strictEqual(access.permission, 'allowed');
  assert.strictEqual(access.serverId, 'srv-1');
});

test('checkConnectAccess devuelve qué puede publicar', async () => {
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ server_id: 'srv-1', can_speak: false, can_video: true, can_screen_share: false }),
  }));
  const access = await checkConnectAccess('auth0|u', 'chan', fast);
  assert.deepStrictEqual(access.publish, { canSpeak: false, canVideo: true, canScreenShare: false });
});

test('checkConnectAccess no falla si la respuesta no trae el servidor; sin permisos de voz puede publicar todo', async () => {
  mockServerRoles(200); // sin body (Server-Roles anterior)
  assert.deepStrictEqual(await checkConnectAccess('auth0|u', 'chan', fast), {
    permission: 'allowed',
    serverId: undefined,
    publish: { canSpeak: true, canVideo: true, canScreenShare: true },
  });
});

test('checkCanView pregunta por /access (VIEW_CHANNELS) y no reintenta 403 ni 404', async () => {
  const fetchMock = mockServerRoles(200);
  assert.strictEqual(await checkCanView('auth0|u', 'chan', fast), 'allowed');
  assert.match(String(fetchMock.mock.calls[0].arguments[0]), /\/internal\/channels\/chan\/access\?user_id=/);
  mock.restoreAll();

  for (const [status, expected] of [
    [403, 'forbidden'],
    [404, 'not_found'],
  ] as const) {
    const viewMock = mockServerRoles(status);
    assert.strictEqual(await checkCanView('auth0|u', 'chan', fast), expected);
    assert.strictEqual(viewMock.mock.callCount(), 1);
    mock.restoreAll();
  }
});

test('checkCanView reintenta las fallas transitorias como can-connect', async () => {
  const fetchMock = mockServerRoles(503, 200);
  assert.strictEqual(await checkCanView('auth0|u', 'chan', fast), 'allowed');
  assert.strictEqual(fetchMock.mock.callCount(), 2);
});

test('checkConnectAccess no informa servidor si no tiene permiso', async () => {
  mockServerRoles(403);
  assert.deepStrictEqual(await checkConnectAccess('auth0|u', 'chan', fast), { permission: 'forbidden' });
});

test('codifica el user_id en la URL', async () => {
  const fetchMock = mockServerRoles(200);
  await checkCanConnect('auth0|abc', 'chan', fast);
  assert.match(String(fetchMock.mock.calls[0].arguments[0]), /user_id=auth0%7Cabc/);
});
