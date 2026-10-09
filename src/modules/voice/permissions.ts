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
  const { timeoutMs, attempts, baseDelayMs } = { ...DEFAULT_RETRY, ...options };
  const coreServiceUrl = process.env.CORE_SERVICE_URL || 'http://server-roles-service:8080';
  const url = `${coreServiceUrl}/internal/channels/${encodeURIComponent(channelId)}/can-connect?user_id=${encodeURIComponent(userId)}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 404) return 'not_found';
      if (response.status === 403) return 'forbidden';
      if (response.ok) return 'allowed';
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
