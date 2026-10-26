import { FastifyInstance } from 'fastify';
import { BLOCK_TTL_SECONDS, clearVoiceSession, keys } from './sessions';

/** Eventos de Server-Roles que sacan al usuario de las llamadas de ese servidor. */
export const REMOVAL_EVENTS = ['member.banned', 'member.kicked', 'member.left'] as const;

export interface MemberEvent {
  server_id?: string;
  user_id?: string;
  [key: string]: unknown;
}

/** LiveKit responde "not found" si el usuario ya no está en la sala (o la sala ya no existe). */
function isNotFound(error: unknown): boolean {
  const { status, code, message } = (error ?? {}) as { status?: number; code?: string; message?: string };
  return status === 404 || code === 'not_found' || /not found|does not exist/i.test(String(message ?? ''));
}

/** Saca al participante de la sala de LiveKit. Que ya no esté no es un error. */
export async function removeParticipant(app: FastifyInstance, channelId: string, userId: string): Promise<void> {
  try {
    await app.roomService.removeParticipant(channelId, userId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * El usuario fue baneado, expulsado o salió del servidor: lo saca de la llamada en la que esté (solo si
 * es de ese servidor) y bloquea que vuelva a entrar con un token que ya tenga.
 *
 * @returns true si estaba en una llamada de ese servidor
 */
export async function removeFromServerVoice(app: FastifyInstance, serverId: string, userId: string): Promise<boolean> {
  if (!app.redis.isOpen) {
    await app.redis.connect();
  }

  // Primero el bloqueo: si entra justo ahora con un token viejo, el webhook participant_joined lo saca
  await app.redis.set(keys.blocked(serverId, userId), '1', { EX: BLOCK_TTL_SECONDS });

  const [channelId, callServerId] = await Promise.all([
    app.redis.get(keys.userChannel(userId)),
    app.redis.get(keys.userServer(userId)),
  ]);
  if (!channelId || callServerId !== serverId) {
    return false;
  }

  await removeParticipant(app, channelId, userId);
  if (await clearVoiceSession(app.redis, channelId, userId)) {
    await app.voicePresence.publish(channelId);
  }
  app.log.info({ serverId, userId, channelId }, 'Usuario sacado de la llamada');
  return true;
}

/** Handler para el consumidor de RabbitMQ: ignora eventos sin servidor o sin usuario. */
export function handleMemberEvent(app: FastifyInstance) {
  return async (routingKey: string, event: MemberEvent): Promise<void> => {
    if (!(REMOVAL_EVENTS as readonly string[]).includes(routingKey)) return;
    if (typeof event?.server_id !== 'string' || typeof event?.user_id !== 'string') return;
    await removeFromServerVoice(app, event.server_id, event.user_id);
  };
}
