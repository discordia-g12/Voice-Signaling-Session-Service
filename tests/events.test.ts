import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { ChannelModel } from 'amqplib';
import { VoiceEventConsumer, type ConsumerLogger } from '../src/modules/voice/events';
import type { MemberEvent } from '../src/modules/voice/moderation';

const silentLogger: ConsumerLogger = { info: () => {}, warn: () => {}, error: () => {} };

type Handler = (msg: { content: Buffer; fields: { routingKey: string } } | null) => void;

/** Conexión de amqplib falsa: un canal que acepta todo y un close() que emite el evento. */
class FakeConnection extends EventEmitter {
  handler: Handler | null = null;
  acked = 0;
  nacked: boolean[] = []; // requeue de cada nack
  exchange: string | null = null;
  queue: string | null = null;
  bindings: string[] = [];

  async createChannel() {
    return {
      assertExchange: async (exchange: string) => {
        this.exchange = exchange;
      },
      assertQueue: async (queue: string) => {
        this.queue = queue;
        return { queue };
      },
      bindQueue: async (_queue: string, _exchange: string, routingKey: string) => {
        this.bindings.push(routingKey);
      },
      consume: async (_queue: string, handler: Handler) => {
        this.handler = handler;
      },
      ack: () => {
        this.acked += 1;
      },
      nack: (_msg: unknown, _allUpTo: boolean, requeue: boolean) => {
        this.nacked.push(requeue);
      },
      close: async () => undefined,
    };
  }

  async close() {
    this.emit('close');
  }

  deliver(routingKey: string, content: string) {
    this.handler?.({ content: Buffer.from(content), fields: { routingKey } });
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('VoiceEventConsumer', () => {
  let consumer: VoiceEventConsumer | null = null;

  afterEach(async () => {
    await consumer?.stop();
    consumer = null;
  });

  const startWith = (handler: (routingKey: string, event: MemberEvent) => Promise<void>, connections: FakeConnection[] = []) => {
    const connect = async () => {
      const conn = new FakeConnection();
      connections.push(conn);
      return conn as unknown as ChannelModel;
    };
    consumer = new VoiceEventConsumer(handler, { url: 'amqp://test', connect, logger: silentLogger, baseDelayMs: 5, maxDelayMs: 20 });
    consumer.start();
    return connections;
  };

  it('usa su propia cola y se suscribe a ban, kick y salida, y a suspensión y reactivación de cuentas', async () => {
    const connections = startWith(async () => {});
    await waitFor(() => consumer!.isConnected);

    assert.strictEqual(connections[0].exchange, 'server.events');
    assert.strictEqual(connections[0].queue, 'voice_signaling_events');
    assert.deepStrictEqual(connections[0].bindings.sort(), [
      'member.banned',
      'member.kicked',
      'member.left',
      'user.reactivated',
      'user.suspended',
    ]);
  });

  it('pasa el evento al handler y lo confirma cuando termina', async () => {
    const received: [string, MemberEvent][] = [];
    const connections = startWith(async (routingKey, event) => {
      received.push([routingKey, event]);
    });
    await waitFor(() => consumer!.isConnected);

    connections[0].deliver('member.banned', JSON.stringify({ server_id: 'srv-1', user_id: 'u-1' }));
    await waitFor(() => connections[0].acked === 1);

    assert.deepStrictEqual(received, [['member.banned', { server_id: 'srv-1', user_id: 'u-1' }]]);
  });

  it('descarta sin reencolar un mensaje mal formado', async () => {
    let calls = 0;
    const connections = startWith(async () => {
      calls += 1;
    });
    await waitFor(() => consumer!.isConnected);

    connections[0].deliver('member.banned', 'no es json');
    await waitFor(() => connections[0].nacked.length === 1);

    assert.deepStrictEqual(connections[0].nacked, [false]);
    assert.strictEqual(calls, 0);
  });

  it('descarta sin reencolar si el handler falla (no entra en loop con Redis caído)', async () => {
    const connections = startWith(async () => {
      throw new Error('redis down');
    });
    await waitFor(() => consumer!.isConnected);

    connections[0].deliver('member.kicked', JSON.stringify({ server_id: 'srv-1', user_id: 'u-1' }));
    await waitFor(() => connections[0].nacked.length === 1);

    assert.deepStrictEqual(connections[0].nacked, [false]);
    assert.strictEqual(connections[0].acked, 0);
  });

  it('reintenta hasta conectar y vuelve a conectar si la conexión se cae', async () => {
    let calls = 0;
    const connections: FakeConnection[] = [];
    const connect = async () => {
      calls += 1;
      if (calls < 2) throw new Error('ECONNREFUSED');
      const conn = new FakeConnection();
      connections.push(conn);
      return conn as unknown as ChannelModel;
    };
    consumer = new VoiceEventConsumer(async () => {}, { url: 'amqp://test', connect, logger: silentLogger, baseDelayMs: 5, maxDelayMs: 20 });
    consumer.start();

    await waitFor(() => consumer!.isConnected);
    connections[0].emit('close');
    assert.strictEqual(consumer.isConnected, false);

    await waitFor(() => connections.length === 2 && consumer!.isConnected);
  });

  it('stop corta los reintentos pendientes', async () => {
    let calls = 0;
    const connect = async () => {
      calls += 1;
      throw new Error('ECONNREFUSED');
    };
    consumer = new VoiceEventConsumer(async () => {}, { url: 'amqp://test', connect, logger: silentLogger, baseDelayMs: 50, maxDelayMs: 50 });
    consumer.start();
    await waitFor(() => calls === 1);

    await consumer.stop();
    await new Promise((r) => setTimeout(r, 120));

    assert.strictEqual(calls, 1);
    assert.strictEqual(consumer.isConnected, false);
  });
});
