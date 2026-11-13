import { FastifyInstance } from 'fastify';
import { BLOCK_TTL_SECONDS, clearVoiceSession, keys } from './sessions';

/** Eventos de Server-Roles que sacan al usuario de las llamadas de ese servidor. */
export const REMOVAL_EVENTS = ['member.banned', 'member.kicked', 'member.left'] as const;

/** Eventos de Auth-User (exchange user.events): cuenta suspendida o reactivada por la plataforma. */
export const ACCOUNT_EVENTS = ['user.suspended', 'user.reactivated'] as const;

/** Eventos de Server-Roles (exchange server.events): servidor suspendido, reactivado o eliminado. */
export const SERVER_EVENTS = ['server.suspended', 'server.unsuspended', 'server.deleted'] as const;

export interface MemberEvent {
  server_id?: string;
  user_id?: string;
  /** user.suspended / user.reactivated: la identidad principal y sus alias federados. */
  identities?: unknown;
  [key: string]: unknown;
}

/** user_id más las identidades del evento, sin repetir y solo strings no vacíos. */
export function accountIdentities(event: MemberEvent): string[] {
  const ids = new Set<string>();
  if (typeof event?.user_id === 'string' && event.user_id) ids.add(event.user_id);
  if (Array.isArray(event?.identities)) {
    for (const id of event.identities) {
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return [...ids];
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

/**
 * Cuenta suspendida por la plataforma (CA 2 de "Suspender usuario"): la saca de la llamada en la que esté,
 * en cualquier servidor, y la marca como suspendida para que el webhook la saque si entra con un token de
 * LiveKit que ya tenía. Lo hace para cada identidad de la cuenta.
 *
 * @returns cuántas de sus identidades estaban en una llamada
 */
export async function removeSuspendedAccount(app: FastifyInstance, userIds: string[]): Promise<number> {
  if (!app.redis.isOpen) {
    await app.redis.connect();
  }

  let removedFromCalls = 0;
  for (const userId of userIds) {
    // Primero la marca: si entra justo ahora con un token viejo, el webhook participant_joined lo saca
    await app.redis.set(keys.suspended(userId), '1', { EX: BLOCK_TTL_SECONDS });
    // También se le cierra el WebSocket de presencia: queda desconectado del todo
    app.voicePresence.disconnectUser(userId);

    const channelId = await app.redis.get(keys.userChannel(userId));
    if (!channelId) continue;

    await removeParticipant(app, channelId, userId);
    if (await clearVoiceSession(app.redis, channelId, userId)) {
      await app.voicePresence.publish(channelId);
    }
    removedFromCalls += 1;
    app.log.info({ userId, channelId }, 'Cuenta suspendida: sacada de la llamada');
  }
  return removedFromCalls;
}

/** Cuenta reactivada: puede volver a entrar a las llamadas. */
export async function clearSuspendedAccount(app: FastifyInstance, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  if (!app.redis.isOpen) {
    await app.redis.connect();
  }
  await app.redis.del(userIds.map((userId) => keys.suspended(userId)));
}

async function closeServerCalls(
  app: FastifyInstance,
  serverId: string,
  voiceChannelIds: string[],
  logMessage: string,
): Promise<number> {
  if (!app.redis.isOpen) {
    await app.redis.connect();
  }

  // Primero la marca: si alguien entra justo ahora con un token anterior, el webhook participant_joined lo saca
  await app.redis.set(keys.serverSuspended(serverId), '1', { EX: BLOCK_TTL_SECONDS });

  let removed = 0;
  for (const channelId of voiceChannelIds) {
    const userIds = await app.redis.sMembers(keys.channelUsers(channelId));
    let changed = false;
    for (const userId of userIds) {
      await removeParticipant(app, channelId, userId);
      if (await clearVoiceSession(app.redis, channelId, userId)) changed = true;
      removed += 1;
    }
    if (changed) await app.voicePresence.publish(channelId);
  }
  app.log.info({ serverId, removed }, logMessage);
  return removed;
}

/**
 * Servidor suspendido por la plataforma (CA 1 de "Suspender servidor completo"): saca a todos de las llamadas de
 * sus canales de voz y marca el servidor, para que el webhook saque a quien entre con un token de LiveKit anterior.
 *
 * @returns cuántos participantes sacó
 */
export async function removeSuspendedServer(
  app: FastifyInstance,
  serverId: string,
  voiceChannelIds: string[],
): Promise<number> {
  return closeServerCalls(app, serverId, voiceChannelIds, 'Servidor suspendido: llamadas cerradas');
}

/**
 * Servidor eliminado: saca a todos de las llamadas de sus canales de voz y bloquea tokens previos en el webhook.
 */
export async function removeDeletedServer(
  app: FastifyInstance,
  serverId: string,
  voiceChannelIds: string[],
): Promise<number> {
  return closeServerCalls(app, serverId, voiceChannelIds, 'Servidor eliminado: llamadas cerradas');
}

/** Se levantó la suspensión del servidor: sus llamadas vuelven a estar disponibles. */
export async function clearSuspendedServer(app: FastifyInstance, serverId: string): Promise<void> {
  if (!app.redis.isOpen) {
    await app.redis.connect();
  }
  await app.redis.del(keys.serverSuspended(serverId));
}

/** Solo strings no vacíos: el evento viene de otro servicio. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

/** Handler para el consumidor de RabbitMQ: ignora eventos desconocidos o sin usuario. */
export function handleMemberEvent(app: FastifyInstance) {
  return async (routingKey: string, event: MemberEvent): Promise<void> => {
    if (routingKey === 'server.suspended' || routingKey === 'server.unsuspended' || routingKey === 'server.deleted') {
      if (typeof event?.server_id !== 'string' || !event.server_id) return;
      if (routingKey === 'server.suspended') {
        await removeSuspendedServer(app, event.server_id, stringList(event.voice_channel_ids));
      } else if (routingKey === 'server.deleted') {
        const voiceChannels = stringList(event.voice_channel_ids);
        await removeDeletedServer(
          app,
          event.server_id,
          voiceChannels.length > 0 ? voiceChannels : stringList(event.channel_ids),
        );
      } else {
        await clearSuspendedServer(app, event.server_id);
      }
      return;
    }
    if (routingKey === 'user.suspended') {
      await removeSuspendedAccount(app, accountIdentities(event));
      return;
    }
    if (routingKey === 'user.reactivated') {
      await clearSuspendedAccount(app, accountIdentities(event));
      return;
    }
    if (!(REMOVAL_EVENTS as readonly string[]).includes(routingKey)) return;
    if (typeof event?.server_id !== 'string' || typeof event?.user_id !== 'string') return;
    await removeFromServerVoice(app, event.server_id, event.user_id);
  };
}
