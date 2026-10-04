export type ConnectPermission = 'allowed' | 'forbidden' | 'not_found';

/**
 * Pregunta a server-roles si el usuario puede conectarse al canal de voz.
 * Tira error si server-roles no responde como se espera.
 */
export async function checkCanConnect(userId: string, channelId: string): Promise<ConnectPermission> {
  const coreServiceUrl = process.env.CORE_SERVICE_URL || 'http://server-roles-service:8080';
  const response = await fetch(
    `${coreServiceUrl}/internal/channels/${encodeURIComponent(channelId)}/can-connect?user_id=${encodeURIComponent(userId)}`
  );

  if (response.status === 404) return 'not_found';
  if (response.status === 403) return 'forbidden';
  if (!response.ok) throw new Error(`Error en el servicio de roles: ${response.status}`);
  return 'allowed';
}
