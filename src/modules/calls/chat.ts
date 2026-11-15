/**
 * Cliente de los endpoints internos de Chat-Engine que usan las llamadas privadas (historia #50).
 * Red del nodo realtime, sin Kong: no se manda `X-User-Id` (Chat responde 404 si llega).
 *
 * Dependencia sincrónica (ver docs/ADR-03 y docs/ADR-04): timeout de 2 s por intento. Las lecturas
 * (`call-access`, `canonical`) se reintentan con backoff ante fallas transitorias; publicar en el inbox no,
 * porque Chat podría haberlo publicado aunque no llegue la respuesta y el evento saldría dos veces.
 */

export interface ChatClientOptions {
  /** URL base de Chat. Default: `CHAT_SERVICE_URL` o `http://chat-engine-service:3000`. */
  baseUrl?: string;
  /** Timeout de cada intento. */
  timeoutMs?: number;
  /** Intentos totales de las lecturas (el primero más los reintentos). */
  attempts?: number;
  /** Espera antes del primer reintento; se duplica en cada uno. */
  baseDelayMs?: number;
}

/** Chat no respondió (timeout, red, 5xx) o respondió algo fuera de contrato. */
export class ChatServiceUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Chat-Engine no disponible', { cause });
    this.name = 'ChatServiceUnavailableError';
  }
}

export type CallAccess =
  | { result: 'allowed'; conversationId: string; userId: string; otherUserId: string }
  | { result: 'not_found' }
  /** `code`: DM_NOT_DELIVERABLE / DM_PENDING; sin código, no participa de la conversación. */
  | { result: 'forbidden'; code?: string };

export interface CanonicalUser {
  userId: string;
  suspended: boolean;
}

export interface InboxEvent {
  type: string;
  [key: string]: unknown;
}

/** Respuesta que no se arregla reintentando (4xx inesperado, body fuera de contrato). */
class PermanentChatError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await response.json()) as unknown;
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Un 404 de negocio de Chat trae `code`. Sin él es una ruta que ese Chat no tiene (Voice desplegado antes que
 * Chat): se trata como Chat no disponible (503), no como "no existe".
 */
function requireNotFoundCode(body: Record<string, unknown>, code: string, route: string): void {
  if (body.code !== code) {
    throw new ChatServiceUnavailableError(new Error(`${route} respondió 404 sin ${code}: Chat sin la ruta`));
  }
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

export class ChatClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly baseDelayMs: number;

  constructor(options: ChatClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.CHAT_SERVICE_URL || 'http://chat-engine-service:3000').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.attempts = options.attempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 200;
  }

  /**
   * GET con reintentos. Devuelve la respuesta si es 2xx, 403 o 404 (respuestas válidas del contrato);
   * timeout, red y 5xx se reintentan; otro 4xx se corta.
   */
  private async read(path: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.ok || response.status === 403 || response.status === 404) return response;
        if (response.status < 500) throw new PermanentChatError(`Chat respondió ${response.status}`);
        lastError = new Error(`Chat respondió ${response.status}`);
      } catch (error) {
        if (error instanceof PermanentChatError) throw new ChatServiceUnavailableError(error);
        lastError = error;
      }
      if (attempt < this.attempts) {
        await sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw new ChatServiceUnavailableError(lastError);
  }

  /** ¿Puede `rawUserId` llamar en la conversación? Mismas reglas que mandar un DM (participante, bloqueo, `pending`). */
  async getCallAccess(conversationId: string, rawUserId: string): Promise<CallAccess> {
    const response = await this.read(
      `/internal/conversations/${encodeURIComponent(conversationId)}/call-access?user_id=${encodeURIComponent(rawUserId)}`,
    );
    const body = await readJson(response);
    if (response.status === 404) {
      requireNotFoundCode(body, 'CONVERSATION_NOT_FOUND', 'call-access');
      return { result: 'not_found' };
    }
    if (response.status === 403) {
      return isNonEmptyString(body.code) ? { result: 'forbidden', code: body.code } : { result: 'forbidden' };
    }
    if (!isNonEmptyString(body.conversationId) || !isNonEmptyString(body.userId) || !isNonEmptyString(body.otherUserId)) {
      throw new ChatServiceUnavailableError(new Error('call-access fuera de contrato'));
    }
    return { result: 'allowed', conversationId: body.conversationId, userId: body.userId, otherUserId: body.otherUserId };
  }

  /** Id canónico de un `X-User-Id` (que puede ser un alias federado). `null` si Chat no lo conoce. */
  async getCanonical(rawUserId: string): Promise<CanonicalUser | null> {
    const response = await this.read(`/internal/users/${encodeURIComponent(rawUserId)}/canonical`);
    const body = await readJson(response);
    if (response.status === 404) {
      requireNotFoundCode(body, 'USER_NOT_FOUND', 'canonical');
      return null;
    }
    if (response.status === 403) throw new ChatServiceUnavailableError(new Error('canonical respondió 403'));
    if (!isNonEmptyString(body.userId)) {
      throw new ChatServiceUnavailableError(new Error('canonical fuera de contrato'));
    }
    return { userId: body.userId, suspended: body.suspended === true };
  }

  /** Publica el evento en el inbox de cada usuario. Un solo intento: ver el comentario del archivo. */
  async publishInboxEvent(userIds: string[], event: InboxEvent): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/inbox/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userIds, event }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ChatServiceUnavailableError(error);
    }
    if (!response.ok) {
      throw new ChatServiceUnavailableError(new Error(`inbox respondió ${response.status}`));
    }
  }
}
