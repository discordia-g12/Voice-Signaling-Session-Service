import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { ACCOUNT_EVENTS, MemberEvent, REMOVAL_EVENTS, SERVER_EVENTS } from './moderation';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Logger mínimo, con las dos firmas del de Fastify (app.log) para que sea asignable. */
export interface ConsumerLogger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
}

export type MemberEventHandler = (routingKey: string, event: MemberEvent) => Promise<void>;

export interface VoiceEventConsumerOptions {
  url: string;
  exchange?: string;
  /** Exchange de Auth-User: user.suspended y user.reactivated. */
  userExchange?: string;
  queue?: string;
  logger?: ConsumerLogger;
  /** Para tests: reemplaza amqplib.connect. */
  connect?: (url: string) => Promise<ChannelModel>;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Consume los eventos member.banned / kicked / left de Server-Roles (exchange `server.events`) y
 * user.suspended / user.reactivated de Auth-User (exchange `user.events`), en la misma cola.
 *
 * Igual que el consumidor del chat: no bloquea el arranque (RabbitMQ está en otro nodo), reintenta
 * para siempre con backoff exponencial y vuelve a conectar si la conexión se cae. La cola es propia
 * (`voice_signaling_events`) y durable: los eventos que llegan mientras Voice está caído se aplican
 * al volver.
 */
export class VoiceEventConsumer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private stopped = true;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private wakeRetry: (() => void) | null = null;
  private readonly opts: Required<Omit<VoiceEventConsumerOptions, 'connect'>> & Pick<VoiceEventConsumerOptions, 'connect'>;

  constructor(
    private readonly handler: MemberEventHandler,
    options: VoiceEventConsumerOptions
  ) {
    this.opts = {
      url: options.url,
      exchange: options.exchange || 'server.events',
      userExchange: options.userExchange || 'user.events',
      queue: options.queue || 'voice_signaling_events',
      logger: options.logger || console,
      connect: options.connect,
      baseDelayMs: options.baseDelayMs ?? RECONNECT_BASE_MS,
      maxDelayMs: options.maxDelayMs ?? RECONNECT_MAX_MS,
    };
  }

  /** true mientras haya una conexión activa consumiendo eventos. */
  get isConnected(): boolean {
    return this.channel !== null;
  }

  start(): void {
    this.stopped = false;
    this.attempts = 0;
    void this.connectLoop();
  }

  private async connectLoop(): Promise<void> {
    const opts = this.opts;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.attempts = 0;
        opts.logger.info({ exchange: opts.exchange, queue: opts.queue }, 'Event consumer connected to RabbitMQ');
        return;
      } catch (err) {
        const delayMs = Math.min(opts.baseDelayMs * 2 ** this.attempts, opts.maxDelayMs);
        this.attempts += 1;
        opts.logger.warn({ err, attempt: this.attempts, delayMs }, 'RabbitMQ unavailable, retrying');
        await new Promise<void>((resolve) => {
          this.wakeRetry = resolve;
          this.retryTimer = setTimeout(resolve, delayMs);
        });
        this.retryTimer = null;
        this.wakeRetry = null;
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const opts = this.opts;
    const connect = opts.connect || (await import('amqplib')).connect;
    const conn = await connect(opts.url);

    conn.on('error', (err: Error) => opts.logger.error({ err }, 'RabbitMQ connection error'));
    conn.on('close', () => {
      this.connection = null;
      this.channel = null;
      if (this.stopped) return;
      opts.logger.warn('RabbitMQ connection closed, reconnecting');
      void this.connectLoop();
    });

    try {
      const channel = await conn.createChannel();
      // Mismas opciones con las que lo declara Auth-User (topic, durable): si no coinciden, RabbitMQ cierra el canal
      await channel.assertExchange(opts.userExchange, 'topic', { durable: true });
      await channel.assertExchange(opts.exchange, 'topic', { durable: true });
      const q = await channel.assertQueue(opts.queue, { durable: true });
      for (const routingKey of [...REMOVAL_EVENTS, ...SERVER_EVENTS]) {
        await channel.bindQueue(q.queue, opts.exchange, routingKey);
      }
      for (const routingKey of ACCOUNT_EVENTS) {
        await channel.bindQueue(q.queue, opts.userExchange, routingKey);
      }

      await channel.consume(q.queue, (msg: ConsumeMessage | null) => {
        if (msg) void this.handleMessage(channel, msg);
      });

      this.connection = conn;
      this.channel = channel;
    } catch (err) {
      // Falló el armado del canal: cerrar sin disparar la reconexión del handler de close
      conn.removeAllListeners('close');
      await conn.close().catch(() => undefined);
      throw err;
    }
  }

  private async handleMessage(channel: Channel, msg: ConsumeMessage): Promise<void> {
    const routingKey = msg.fields.routingKey;
    let event: MemberEvent;
    try {
      event = JSON.parse(msg.content.toString());
    } catch (err) {
      // Mensaje mal formado: no se reencola (se volvería a romper en loop)
      this.opts.logger.error({ err, routingKey }, 'Invalid event discarded');
      this.settle(() => channel.nack(msg, false, false));
      return;
    }

    try {
      await this.handler(routingKey, event);
      this.settle(() => channel.ack(msg));
    } catch (err) {
      // Redis o LiveKit fallaron. No se reencola para no entrar en loop mientras sigan caídos; el
      // bloqueo (si llegó a guardarse) igual le impide volver a entrar con un token viejo.
      this.opts.logger.error({ err, routingKey }, 'Failed to apply event, discarded');
      this.settle(() => channel.nack(msg, false, false));
    }
  }

  /** ack / nack: si el canal se cerró mientras se procesaba, RabbitMQ lo vuelve a entregar solo. */
  private settle(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.logger.warn({ err }, 'Could not ack event (channel closed)');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.wakeRetry?.();
    if (this.channel) {
      try {
        await this.channel.close();
      } catch {
        // ya estaba cerrado
      }
      this.channel = null;
    }
    if (this.connection) {
      try {
        await this.connection.close();
      } catch {
        // ya estaba cerrada
      }
      this.connection = null;
    }
  }
}
