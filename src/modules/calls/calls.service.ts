import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { RedisClientType } from 'redis';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { LiveKitConfig } from '../../app';
import type { PublishPermissions } from '../voice/permissions';
import { isNotFound } from '../voice/moderation';
import { TOKEN_TTL } from '../voice/sessions';
import { ChatClient } from './chat';
import {
  Call,
  CallEndReason,
  CallState,
  CallStore,
  callRoomName,
  isLive,
  RING_TIMEOUT_MS,
  StoredCall,
  toPublicCall,
} from './state';

/** Error de negocio de las llamadas: la ruta lo responde como Problem Details con `code`. */
export class CallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CallError';
  }
}

/**
 * Micrófono y cámara (historia #54): en una llamada privada no hay roles que lo limiten. Compartir pantalla
 * todavía no existe en ningún lado.
 */
export const CALL_PERMISSIONS: PublishPermissions = { canSpeak: true, canVideo: true, canScreenShare: false };

/** Lo que el token deja publicar: lo mismo que dice CALL_PERMISSIONS al cliente. */
const CALL_PUBLISH_SOURCES = [TrackSource.MICROPHONE, TrackSource.CAMERA];

export interface CallJoin {
  call: Call;
  token: string;
  url: string;
  permissions: PublishPermissions;
}

export interface CallServiceDeps {
  redis: RedisClientType;
  roomService: RoomServiceClient;
  livekit: LiveKitConfig;
  chat: ChatClient;
  log: FastifyBaseLogger;
  /** Cuánto suena (default 30 s). */
  ringTimeoutMs?: number;
}

/** Cuántas veces se reintenta una transición que perdió la carrera contra otra. */
const MAX_TRANSITION_ATTEMPTS = 5;

// Los ids de llamada son UUID: cualquier otra cosa no existe (y no se arma una clave de Redis con ella)
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Role = 'caller' | 'callee';

/** 403 de Chat cuando la conversación todavía no está aceptada para quien pregunta. */
const DM_PENDING = 'DM_PENDING';

const notFound = () => new CallError(404, 'CALL_NOT_FOUND', 'Call not found');
const notRinging = () => new CallError(409, 'CALL_NOT_RINGING', 'The call is not ringing');

/**
 * Llamadas privadas 1 a 1 (historia #50, docs/ADR-04-Private-Calls.md). Voice es dueño del estado (voice-redis),
 * le pregunta a Chat si se puede llamar y avisa a los dos por el inbox de Chat. El audio va por una sala de
 * LiveKit de 2 personas (`call-<id>`).
 *
 * El timer de "no responde" vive en el proceso: con una sola instancia alcanza; el TTL de Redis y el timeout
 * local del cliente cubren que el proceso se caiga mientras suena.
 */
export class CallService {
  readonly store: CallStore;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ringTimeoutMs: number;

  constructor(private readonly deps: CallServiceDeps) {
    this.store = new CallStore(deps.redis);
    this.ringTimeoutMs = deps.ringTimeoutMs ?? RING_TIMEOUT_MS;
  }

  // ── Rutas ──────────────────────────────────────────────────────────────────────────────────────

  /** Quien llama inicia y entra a la sala (escucha "llamando…"). */
  async start(rawUserId: string, conversationId: string): Promise<CallJoin> {
    const access = await this.deps.chat.getCallAccess(conversationId, rawUserId);
    if (access.result === 'not_found') {
      throw new CallError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    }
    if (access.result === 'forbidden') {
      // Sin código (no participa) se responde como inexistente: no se confirma que la conversación existe
      if (!access.code) throw new CallError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
      throw new CallError(403, access.code, 'You cannot call in this conversation');
    }
    await this.store.saveIdentity(rawUserId, access.userId);

    const now = Date.now();
    const state: CallState = {
      id: randomUUID(),
      conversationId: access.conversationId,
      callerId: access.userId,
      calleeId: access.otherUserId,
      callerIdentity: rawUserId,
      status: 'ringing',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ringTimeoutMs).toISOString(),
    };

    if (!(await this.store.reserve(state))) {
      throw new CallError(409, 'CALL_BUSY', 'One of the participants is already in a call');
    }

    const room = callRoomName(state.id);
    try {
      await this.deps.roomService.createRoom({ name: room, maxParticipants: 2, emptyTimeout: 60 });
    } catch (error) {
      this.deps.log.error({ err: error, callId: state.id }, 'No se pudo crear la sala de la llamada');
      await this.store.discard(state);
      throw new CallError(503, 'LIVEKIT_UNAVAILABLE', 'Voice server unavailable');
    }

    // Si no se puede avisar a quien recibe, la llamada no existe: no queda nada creado
    try {
      await this.notify(state, 'CALL_RINGING');
    } catch (error) {
      this.deps.log.error({ err: error, callId: state.id }, 'No se pudo avisar la llamada por el inbox de Chat');
      await this.store.discard(state);
      await this.deleteRoom(room);
      throw new CallError(503, 'CHAT_UNAVAILABLE', 'Chat service unavailable');
    }

    this.scheduleRingTimeout(state);
    return this.credentials(state, rawUserId);
  }

  /**
   * Quien recibe atiende: vuelve a pasar por Chat (pudo haber un bloqueo o una suspensión mientras sonaba).
   * `DM_PENDING` no corta: quien llama ya pasó por Chat al iniciar, y la conversación puede seguir sin aceptar
   * para quien recibe (llama quien la rechazó, o dejaron de ser amigos mientras sonaba). Que es quien recibe
   * ya lo resolvió `loadForUser`.
   */
  async accept(rawUserId: string, callId: string): Promise<CallJoin> {
    const { stored, role } = await this.loadForUser(rawUserId, callId);
    if (role !== 'callee') throw new CallError(403, 'CALL_NOT_CALLEE', 'Only the callee can do this');
    if (stored.state.status !== 'ringing') throw notRinging();

    const access = await this.deps.chat.getCallAccess(stored.state.conversationId, rawUserId);
    const pendingOnly = access.result === 'forbidden' && access.code === DM_PENDING;
    if (!pendingOnly && (access.result !== 'allowed' || access.userId !== stored.state.calleeId)) {
      await this.finish(callId, (state) => (state.status === 'ringing' ? 'unavailable' : null));
      if (access.result === 'forbidden' && access.code) {
        throw new CallError(403, access.code, 'You cannot call in this conversation');
      }
      throw new CallError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    }

    const next: CallState = {
      ...stored.state,
      calleeIdentity: rawUserId,
      status: 'active',
      answeredAt: new Date().toISOString(),
    };
    // Si en el medio venció el timbre, cortó quien llama o atendió otro dispositivo, gana el que llegó primero
    if (!(await this.store.transition(stored, next))) throw notRinging();
    this.cancelRingTimeout(callId);

    try {
      await this.notify(next, 'CALL_ACCEPTED');
    } catch (error) {
      // La llamada ya está activa: quien llama lo ve igual cuando entra el otro a la sala o al reconciliar
      this.deps.log.error({ err: error, callId }, 'No se pudo avisar que se aceptó la llamada');
    }
    return this.credentials(next, rawUserId);
  }

  async decline(rawUserId: string, callId: string): Promise<void> {
    const { stored, role } = await this.loadForUser(rawUserId, callId);
    if (role !== 'callee') throw new CallError(403, 'CALL_NOT_CALLEE', 'Only the callee can do this');
    if (stored.state.status !== 'ringing') throw notRinging();
    const ended = await this.finish(callId, (state) => (state.status === 'ringing' ? 'declined' : null));
    if (!ended) throw notRinging();
  }

  /** Cualquiera de los dos. Idempotente: si ya terminó, no hace nada. */
  async end(rawUserId: string, callId: string): Promise<void> {
    const { stored, role } = await this.loadForUser(rawUserId, callId);
    if (!isLive(stored.state)) return;
    await this.finish(callId, (state) => {
      if (state.status === 'active') return 'ended';
      return role === 'caller' ? 'canceled' : 'declined';
    });
  }

  /** Llamada sonando o activa de quien pide: para recuperar el estado al reconectar. */
  async current(rawUserId: string): Promise<Call | null> {
    const canonicalId = await this.resolveCanonical(rawUserId);
    if (!canonicalId) return null;
    const stored = await this.store.currentOf(canonicalId);
    return stored ? toPublicCall(stored.state) : null;
  }

  // ── Webhooks y eventos ─────────────────────────────────────────────────────────────────────────

  /**
   * Webhook de LiveKit de una sala `call-`. No toca las claves ni la presencia de los canales.
   * Al recargar la página la conexión nueva puede entrar antes del participant_left de la vieja: solo
   * termina si el usuario ya no está en la sala.
   */
  async handleRoomEvent(event: string, room: string, callId: string, identity?: string): Promise<void> {
    if (!CALL_ID.test(callId)) return;

    switch (event) {
      case 'participant_joined': {
        if (!identity) return;
        const stored = await this.store.get(callId);
        const state = stored?.state ?? null;
        const allowed = isLive(state) && (identity === state.callerIdentity || identity === state.calleeIdentity);
        if (!allowed) {
          // Token de una llamada que ya terminó (LiveKit vuelve a crear la sala si entra) o de otra persona
          this.deps.log.warn({ callId, identity }, 'Participante fuera de la llamada: se lo saca');
          await this.removeParticipant(room, identity);
        }
        return;
      }

      case 'participant_left':
      case 'participant_connection_aborted': {
        if (!identity || (await this.isStillInRoom(room, identity))) return;
        await this.finish(callId, (state) => {
          if (state.status === 'ringing') return identity === state.callerIdentity ? 'canceled' : null;
          return identity === state.callerIdentity || identity === state.calleeIdentity ? 'ended' : null;
        });
        return;
      }

      case 'room_finished':
        await this.finish(callId, (state) => (state.status === 'ringing' ? 'canceled' : 'ended'));
        return;
    }
  }

  /**
   * Cuenta suspendida (`user.suspended`): termina la llamada de cualquiera de sus identidades. No le pregunta
   * a Chat: usa los ids del evento y los canónicos que ya se guardaron al pasar por Chat.
   *
   * @returns cuántas llamadas terminó
   */
  async endForIdentities(identities: string[]): Promise<number> {
    const canonicalIds = new Set(identities);
    for (const identity of identities) {
      const canonicalId = await this.store.getIdentity(identity);
      if (canonicalId) canonicalIds.add(canonicalId);
    }

    let ended = 0;
    for (const canonicalId of canonicalIds) {
      const stored = await this.store.currentOf(canonicalId);
      if (!stored) continue;
      if (await this.finish(stored.state.id, (state) => (isLive(state) ? 'unavailable' : null))) {
        ended += 1;
        this.deps.log.info({ callId: stored.state.id, userId: canonicalId }, 'Cuenta suspendida: llamada terminada');
      }
    }
    return ended;
  }

  /** Cancela los timers pendientes (al cerrar la app). */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // ── Internos ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Termina la llamada si `decide` da un motivo para el estado actual. Es la única forma de terminar: la
   * transición es atómica (si otra la cambió en el medio, vuelve a leer y decide de nuevo), y después borra la
   * sala, cancela el timer y avisa. Un fallo en el aviso no frena el corte.
   *
   * @returns el estado final, o null si no terminó (ya había terminado o `decide` no dio motivo)
   */
  async finish(callId: string, decide: (state: CallState) => CallEndReason | null): Promise<CallState | null> {
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
      const stored = await this.store.get(callId);
      if (!stored || !isLive(stored.state)) return null;
      const reason = decide(stored.state);
      if (!reason) return null;

      const next: CallState = { ...stored.state, status: 'ended', endReason: reason, endedAt: new Date().toISOString() };
      if (!(await this.store.transition(stored, next))) continue;

      this.cancelRingTimeout(callId);
      await this.deleteRoom(callRoomName(callId));
      try {
        await this.notify(next, 'CALL_ENDED');
      } catch (error) {
        this.deps.log.error({ err: error, callId }, 'No se pudo avisar el fin de la llamada');
      }
      return next;
    }
    this.deps.log.warn({ callId }, 'No se pudo terminar la llamada: demasiados cambios concurrentes');
    return null;
  }

  /**
   * La llamada y el rol de quien pide. Primero por la identidad cruda guardada (así `end` funciona con Chat
   * caído); si no coincide, por el id canónico (`call:identity:` o Chat).
   */
  private async loadForUser(rawUserId: string, callId: string): Promise<{ stored: StoredCall; role: Role }> {
    if (!CALL_ID.test(callId)) throw notFound();
    const stored = await this.store.get(callId);
    if (!stored) throw notFound();
    const { state } = stored;

    if (rawUserId === state.callerIdentity) return { stored, role: 'caller' };
    if (rawUserId === state.calleeIdentity) return { stored, role: 'callee' };

    const canonicalId = await this.resolveCanonical(rawUserId);
    if (canonicalId === state.callerId) return { stored, role: 'caller' };
    if (canonicalId === state.calleeId) return { stored, role: 'callee' };
    throw notFound();
  }

  /** Id canónico de un `X-User-Id`: el guardado, o el de Chat (y se guarda). Tira si Chat no responde. */
  private async resolveCanonical(rawUserId: string): Promise<string | null> {
    const cached = await this.store.getIdentity(rawUserId);
    if (cached) return cached;
    const user = await this.deps.chat.getCanonical(rawUserId);
    if (!user) return null;
    await this.store.saveIdentity(rawUserId, user.userId);
    return user.userId;
  }

  private async credentials(state: CallState, identity: string): Promise<CallJoin> {
    const at = new AccessToken(this.deps.livekit.apiKey, this.deps.livekit.apiSecret, {
      identity,
      name: `User-${identity}`,
      ttl: TOKEN_TTL,
    });
    at.addGrant({
      roomJoin: true,
      room: callRoomName(state.id),
      canPublish: true,
      canPublishSources: CALL_PUBLISH_SOURCES,
      canSubscribe: true,
    });
    return {
      call: toPublicCall(state),
      token: await at.toJwt(),
      url: this.deps.livekit.publicUrl,
      permissions: CALL_PERMISSIONS,
    };
  }

  /** El mismo objeto a los dos: cada cliente sabe su rol comparando callerId / calleeId. */
  private notify(state: CallState, type: 'CALL_RINGING' | 'CALL_ACCEPTED' | 'CALL_ENDED'): Promise<void> {
    return this.deps.chat.publishInboxEvent([state.callerId, state.calleeId], { type, call: toPublicCall(state) });
  }

  private scheduleRingTimeout(state: CallState): void {
    const delay = Math.max(0, Date.parse(state.expiresAt) - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(state.id);
      this.finish(state.id, (current) => (current.status === 'ringing' ? 'missed' : null)).catch((error) => {
        this.deps.log.error({ err: error, callId: state.id }, 'No se pudo terminar la llamada no respondida');
      });
    }, delay);
    // No retiene el proceso: si se cierra, el TTL de Redis limpia el estado
    timer.unref();
    this.timers.set(state.id, timer);
  }

  private cancelRingTimeout(callId: string): void {
    const timer = this.timers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(callId);
    }
  }

  /** Que la sala ya no exista no es un error; otro fallo se loguea y no frena el corte. */
  private async deleteRoom(room: string): Promise<void> {
    try {
      await this.deps.roomService.deleteRoom(room);
    } catch (error) {
      if (!isNotFound(error)) this.deps.log.error({ err: error, room }, 'No se pudo borrar la sala de la llamada');
    }
  }

  private async removeParticipant(room: string, identity: string): Promise<void> {
    try {
      await this.deps.roomService.removeParticipant(room, identity);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async isStillInRoom(room: string, identity: string): Promise<boolean> {
    try {
      const participants = await this.deps.roomService.listParticipants(room);
      return participants.some((p) => p.identity === identity);
    } catch {
      // La sala ya no existe
      return false;
    }
  }
}
