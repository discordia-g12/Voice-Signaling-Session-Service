export type ConnectPermission = 'allowed' | 'forbidden' | 'not_found';

export interface RetryOptions {
  /** Timeout de cada intento. */
  timeoutMs?: number;
  /** Intentos totales (el primero más los reintentos). */
  attempts?: number;
  /** Espera antes del primer reintento; se duplica en cada uno (backoff exponencial). */
  baseDelayMs?: number;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  timeoutMs: 2000,
  attempts: 3,
  baseDelayMs: 200,
};

/** Server-Roles no respondió después de todos los reintentos (falla transitoria agotada). */
export class PermissionServiceUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Server-Roles no disponible', { cause });
    this.name = 'PermissionServiceUnavailableError';
  }
}

/** Server-Roles respondió algo inesperado que no se arregla reintentando (ej. 400). */
class PermanentPermissionError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pregunta a Server-Roles si el usuario puede conectarse al canal de voz.
 *
 * Llamada sincrónica (ver docs/ADR-03-Synchronous-Dependencies.md): cada intento tiene timeout y
 * las fallas transitorias (timeout, red, 5xx) se reintentan con backoff exponencial. 403 y 404 son
 * respuestas válidas y no se reintentan. Si se agotan los intentos tira
 * `PermissionServiceUnavailableError`.
 */
export async function checkCanConnect(
  userId: string,
  channelId: string,
  options: RetryOptions = {}
): Promise<ConnectPermission> {
  return (await checkConnectAccess(userId, channelId, options)).permission;
}

/** Qué puede publicar en la llamada (micrófono, cámara, pantalla). */
export interface PublishPermissions {
  canSpeak: boolean;
  canVideo: boolean;
  canScreenShare: boolean;
}

/** Sin los campos (Server-Roles anterior a los permisos de voz) se puede publicar todo, como antes. */
const PUBLISH_ALL: PublishPermissions = { canSpeak: true, canVideo: true, canScreenShare: true };

export interface ConnectAccess {
  permission: ConnectPermission;
  /** Servidor dueño del canal (solo si `permission` es 'allowed' y Server-Roles lo informó). */
  serverId?: string;
  /** Qué puede publicar (solo si `permission` es 'allowed'). */
  publish?: PublishPermissions;
}

interface CanConnectBody {
  server_id?: unknown;
  can_speak?: unknown;
  can_video?: unknown;
  can_screen_share?: unknown;
}

async function readBody(response: Response): Promise<CanConnectBody> {
  try {
    return ((await response.json()) as CanConnectBody | null) ?? {};
  } catch {
    return {};
  }
}

const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/**
 * GET a un endpoint /internal de Server-Roles con timeout y reintentos (ver checkCanConnect).
 * Devuelve la respuesta si fue 2xx, o el permiso si fue 403 / 404.
 */
async function callServerRoles(path: string, options: RetryOptions): Promise<Response | 'forbidden' | 'not_found'> {
  const { timeoutMs, attempts, baseDelayMs } = { ...DEFAULT_RETRY, ...options };
  const coreServiceUrl = process.env.CORE_SERVICE_URL || 'http://server-roles-service:8080';
  const url = `${coreServiceUrl}${path}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 404) return 'not_found';
      if (response.status === 403) return 'forbidden';
      if (response.ok) return response;
      if (response.status < 500) {
        throw new PermanentPermissionError(`Server-Roles respondió ${response.status}`);
      }
      lastError = new Error(`Server-Roles respondió ${response.status}`);
    } catch (error) {
      if (error instanceof PermanentPermissionError) throw error;
      // Timeout (AbortSignal) o error de red: transitorio
      lastError = error;
    }

    if (attempt < attempts) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw new PermissionServiceUnavailableError(lastError);
}

const channelPath = (channelId: string, endpoint: string, userId: string) =>
  `/internal/channels/${encodeURIComponent(channelId)}/${endpoint}?user_id=${encodeURIComponent(userId)}`;

/** Igual que `checkCanConnect`, pero además devuelve el servidor del canal y qué puede publicar. */
export async function checkConnectAccess(
  userId: string,
  channelId: string,
  options: RetryOptions = {}
): Promise<ConnectAccess> {
  const result = await callServerRoles(channelPath(channelId, 'can-connect', userId), options);
  if (typeof result === 'string') return { permission: result };

  const body = await readBody(result);
  return {
    permission: 'allowed',
    serverId: typeof body.server_id === 'string' ? body.server_id : undefined,
    publish: {
      canSpeak: flag(body.can_speak, PUBLISH_ALL.canSpeak),
      canVideo: flag(body.can_video, PUBLISH_ALL.canVideo),
      canScreenShare: flag(body.can_screen_share, PUBLISH_ALL.canScreenShare),
    },
  };
}

/**
 * Si el usuario puede VER el canal (VIEW_CHANNELS), aunque no pueda conectarse: alcanza para saber
 * quién está en un canal de voz (presencia), como en Discord. Mismos reintentos que checkCanConnect.
 */
export async function checkCanView(
  userId: string,
  channelId: string,
  options: RetryOptions = {}
): Promise<ConnectPermission> {
  const result = await callServerRoles(channelPath(channelId, 'access', userId), options);
  return typeof result === 'string' ? result : 'allowed';
}
