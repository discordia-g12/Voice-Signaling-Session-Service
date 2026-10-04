import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

export interface PresenceMessage {
  type: 'presence';
  channelId: string;
  userIds: string[];
}

/**
 * Quién está en cada canal de voz, empujado en vivo a los clientes suscriptos por WebSocket.
 *
 * La fuente de verdad es Redis (`channel:{id}:users`); cada vez que cambia un canal (join, leave o
 * webhook de LiveKit) se llama a `publish` y se manda la lista completa de ese canal.
 * Las suscripciones viven en memoria: alcanza mientras haya una sola instancia del servicio
 * (con varias habría que repartir los avisos con Redis pub/sub).
 */
export class VoicePresence {
  private readonly socketsByChannel = new Map<string, Set<WebSocket>>();
  private readonly channelsBySocket = new Map<WebSocket, Set<string>>();

  constructor(private readonly app: FastifyInstance) {}

  /** Reemplaza los canales que sigue el socket y le manda el estado actual de cada uno. */
  async subscribe(socket: WebSocket, channelIds: string[]) {
    this.unsubscribe(socket);
    const channels = new Set(channelIds);
    this.channelsBySocket.set(socket, channels);
    for (const channelId of channels) {
      if (!this.socketsByChannel.has(channelId)) this.socketsByChannel.set(channelId, new Set());
      this.socketsByChannel.get(channelId)!.add(socket);
    }

    for (const channelId of channels) {
      send(socket, await this.snapshot(channelId));
    }
  }

  unsubscribe(socket: WebSocket) {
    const channels = this.channelsBySocket.get(socket);
    if (!channels) return;
    for (const channelId of channels) {
      const sockets = this.socketsByChannel.get(channelId);
      sockets?.delete(socket);
      if (sockets?.size === 0) this.socketsByChannel.delete(channelId);
    }
    this.channelsBySocket.delete(socket);
  }

  /** Avisa a quienes siguen el canal que cambió su lista de participantes. */
  async publish(channelId: string) {
    const sockets = this.socketsByChannel.get(channelId);
    if (!sockets?.size) return;
    try {
      const message = await this.snapshot(channelId);
      sockets.forEach((socket) => send(socket, message));
    } catch (error) {
      // Un aviso perdido no debe romper el join/leave que lo disparó
      this.app.log.error(error);
    }
  }

  private async snapshot(channelId: string): Promise<PresenceMessage> {
    if (!this.app.redis.isOpen) {
      await this.app.redis.connect();
    }
    const userIds = await this.app.redis.sMembers(`channel:${channelId}:users`);
    return { type: 'presence', channelId, userIds: userIds.sort() };
  }
}

function send(socket: WebSocket, message: PresenceMessage) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
