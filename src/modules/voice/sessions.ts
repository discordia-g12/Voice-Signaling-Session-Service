import type { RedisClientType } from 'redis';

/**
 * Claves de Redis de las sesiones de voz. La sala de LiveKit se llama igual que el channelId y la
 * identidad del participante es el userId.
 */
export const keys = {
  /** Canal de voz donde está el usuario. */
  userChannel: (userId: string) => `user:${userId}:voice_channel`,
  /** Servidor de ese canal: para que un ban en un servidor no saque al usuario de una llamada de otro. */
  userServer: (userId: string) => `user:${userId}:voice_server`,
  /** Quiénes están en el canal (presencia). */
  channelUsers: (channelId: string) => `channel:${channelId}:users`,
  /** Servidor del canal: lo necesita el webhook, que solo recibe la sala y el usuario. */
  channelServer: (channelId: string) => `channel:${channelId}:server`,
  /**
   * El usuario fue baneado, expulsado o salió del servidor. Mientras exista, si entra a una sala de
   * ese servidor con un token emitido antes, el webhook lo saca. Se borra cuando vuelve a pasar por
   * /join (que chequea can-connect).
   */
  blocked: (serverId: string, userId: string) => `voice:blocked:${serverId}:${userId}`,
  /**
   * La cuenta fue suspendida por la plataforma (user.suspended de Auth-User): no puede estar en ninguna
   * llamada. Cubre el token de LiveKit que ya tenga, que no pasa por el validador de Kong. Se borra con
   * user.reactivated.
   */
  suspended: (userId: string) => `voice:suspended:${userId}`,
};

/**
 * Cuánto dura el bloqueo. Tiene que cubrir la vida del token de LiveKit, incluidos los que LiveKit
 * renueva a quien ya estaba conectado; /join lo borra antes si el usuario vuelve a tener permiso.
 */
export const BLOCK_TTL_SECONDS = 24 * 60 * 60;

/** Vida del token de LiveKit: alcanza para conectarse; LiveKit lo renueva a quien ya está en la sala. */
export const TOKEN_TTL = '10m';

/**
 * Saca al usuario del canal en Redis. Devuelve true si estaba (hay que publicar la presencia).
 * Si después del cambio su canal actual es otro (se pasó de canal), ese no se toca.
 */
export async function clearVoiceSession(redis: RedisClientType, channelId: string, userId: string): Promise<boolean> {
  const removed = await redis.sRem(keys.channelUsers(channelId), userId);
  const currentChannel = await redis.get(keys.userChannel(userId));
  if (currentChannel === channelId) {
    await redis.del([keys.userChannel(userId), keys.userServer(userId)]);
  }
  return removed > 0;
}
