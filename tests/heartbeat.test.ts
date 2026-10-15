import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { startHeartbeat } from '../src/modules/voice/heartbeat';

/** Socket mínimo: registra pings y terminate; `pong()` simula la respuesta automática del cliente. */
class FakeSocket extends EventEmitter {
  pings = 0;
  terminated = false;
  ping() {
    this.pings += 1;
  }
  terminate() {
    this.terminated = true;
  }
  pong() {
    this.emit('pong');
  }
}

describe('startHeartbeat', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
  afterEach(() => mock.timers.reset());

  it('pinguea en cada intervalo mientras el cliente responde', () => {
    const socket = new FakeSocket();
    startHeartbeat(socket as unknown as WebSocket, 1000);

    for (let i = 0; i < 3; i++) {
      mock.timers.tick(1000);
      socket.pong();
    }

    assert.strictEqual(socket.pings, 3);
    assert.strictEqual(socket.terminated, false);
  });

  it('termina la conexión si el cliente no respondió el ping anterior', () => {
    const socket = new FakeSocket();
    startHeartbeat(socket as unknown as WebSocket, 1000);

    mock.timers.tick(1000); // ping sin respuesta
    mock.timers.tick(1000);

    assert.strictEqual(socket.pings, 1);
    assert.strictEqual(socket.terminated, true);
  });

  it('deja de pinguear al frenarlo (conexión cerrada)', () => {
    const socket = new FakeSocket();
    const stop = startHeartbeat(socket as unknown as WebSocket, 1000);

    stop();
    mock.timers.tick(5000);

    assert.strictEqual(socket.pings, 0);
    assert.strictEqual(socket.listenerCount('pong'), 0);
  });
});
