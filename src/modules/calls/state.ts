import type { RedisClientType } from 'redis';

/**
 * Estado de las llamadas privadas en voice-redis. Separado de las claves de canales (`channel:*`,
 * `user:*:voice_channel`): una llamada no toca la presencia de los canales de voz.
 */
export const callKeys = {
  /** JSON de CallState. */
  call: (callId: string) => `call:${callId}`,
  /** callId de la llamada sonando o activa del usuario (id canónico): marca "ocupado". */
  user: (canonicalId: string) => `call:user:${canonicalId}`,
  /** Id canónico de un `X-User-Id` crudo: permite cortar aunque Chat no responda. */
  identity: (rawUserId: string) => `call:identity:${rawUserId}`,
};

/** Las salas de LiveKit de las llamadas se llaman así; las de canales, igual que el channelId. */
export const CALL_ROOM_PREFIX = 'call-';
export const callRoomName = (callId: string) => `${CALL_ROOM_PREFIX}${callId}`;
export const callIdFromRoom = (room: string) => room.slice(CALL_ROOM_PREFIX.length);

/** Cuánto suena antes de darse por no respondida. */
export const RING_TIMEOUT_MS = 30_000;

/**
 * TTLs de red de seguridad: si el proceso se cae con una llamada en curso, el "ocupado" no queda para
 * siempre. Mientras suena el TTL es algo mayor que el timbre, para que el timer gane y avise.
 */
export const TTL_SECONDS = {
  ringing: 45,
  active: 12 * 60 * 60,
  ended: 5 * 60,
  identity: 12 * 60 * 60,
} as const;

export type CallStatus = 'ringing' | 'active' | 'ended';
export type CallEndReason = 'declined' | 'missed' | 'canceled' | 'ended' | 'unavailable';

export interface CallState {
  id: string;
  conversationId: string;
  /** Ids canónicos (los da Chat). */
  callerId: string;
  calleeId: string;
  /** `X-User-Id` crudos: identidad en LiveKit. La de quien recibe se conoce al aceptar. */
  callerIdentity: string;
  calleeIdentity?: string;
  status: CallStatus;
  endReason?: CallEndReason;
  createdAt: string;
  expiresAt: string;
  answeredAt?: string;
  endedAt?: string;
}

/** Lo que ve el cliente (respuestas y eventos del inbox): sin las identidades crudas. */
export type Call = Omit<CallState, 'callerIdentity' | 'calleeIdentity'>;

export function toPublicCall(state: CallState): Call {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { callerIdentity, calleeIdentity, ...call } = state;
  return call;
}

export const isLive = (state: CallState | null): state is CallState =>
  state !== null && (state.status === 'ringing' || state.status === 'active');

// Toma el "ocupado" de los dos participantes y guarda la llamada, todo o nada. Si alguno ya está en una
// llamada no deja nada a medias (si el segundo SET NX falla, libera el primero).
// KEYS: call, user caller, user callee. ARGV: json, ttl, callId
const RESERVE_SCRIPT = `
if not redis.call('SET', KEYS[2], ARGV[3], 'NX', 'EX', ARGV[2]) then return 0 end
if not redis.call('SET', KEYS[3], ARGV[3], 'NX', 'EX', ARGV[2]) then
  redis.call('DEL', KEYS[2])
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

// Compare-and-set sobre el JSON entero: solo cambia si nadie lo cambió desde que se leyó. Así aceptar y que
// venza el timbre a la vez no ganan los dos. El "ocupado" se renueva (ttl > 0) o se borra (ttl = 0), solo si
// todavía apunta a esta llamada.
// KEYS: call, user caller, user callee. ARGV: json esperado, json nuevo, ttl llamada, callId, ttl ocupado
const TRANSITION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
for i = 2, 3 do
  if redis.call('GET', KEYS[i]) == ARGV[4] then
    if ARGV[5] == '0' then redis.call('DEL', KEYS[i]) else redis.call('EXPIRE', KEYS[i], ARGV[5]) end
  end
end
return 1
`;

// Deshace una reserva (falló LiveKit o el aviso al iniciar): borra la llamada y el "ocupado" si es suyo.
// KEYS: call, user caller, user callee. ARGV: callId
const DISCARD_SCRIPT = `
redis.call('DEL', KEYS[1])
for i = 2, 3 do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
return 1
`;

/** Una lectura del estado: el objeto y el JSON tal cual está en Redis (para el compare-and-set). */
export interface StoredCall {
  state: CallState;
  raw: string;
}

const participantKeys = (state: CallState) => [
  callKeys.call(state.id),
  callKeys.user(state.callerId),
  callKeys.user(state.calleeId),
];

export class CallStore {
  constructor(private readonly redis: RedisClientType) {}

  private async ready(): Promise<RedisClientType> {
    if (!this.redis.isOpen) await this.redis.connect();
    return this.redis;
  }

  async get(callId: string): Promise<StoredCall | null> {
    const raw = await (await this.ready()).get(callKeys.call(callId));
    if (!raw) return null;
    return { state: JSON.parse(raw) as CallState, raw };
  }

  /** Llamada sonando o activa del usuario (id canónico). */
  async currentOf(canonicalId: string): Promise<StoredCall | null> {
    const callId = await (await this.ready()).get(callKeys.user(canonicalId));
    if (!callId) return null;
    const stored = await this.get(callId);
    return stored && isLive(stored.state) ? stored : null;
  }

  /** Guarda una llamada nueva sonando. `false` si alguno de los dos ya está en una llamada. */
  async reserve(state: CallState): Promise<boolean> {
    const result = await (await this.ready()).eval(RESERVE_SCRIPT, {
      keys: participantKeys(state),
      arguments: [JSON.stringify(state), String(TTL_SECONDS.ringing), state.id],
    });
    return result === 1;
  }

  /** Reemplaza `current` por `next` si nadie lo cambió. `false` si perdió la carrera. */
  async transition(current: StoredCall, next: CallState): Promise<boolean> {
    const ttl = TTL_SECONDS[next.status];
    const userTtl = next.status === 'ended' ? 0 : ttl;
    const result = await (await this.ready()).eval(TRANSITION_SCRIPT, {
      keys: participantKeys(next),
      arguments: [current.raw, JSON.stringify(next), String(ttl), next.id, String(userTtl)],
    });
    return result === 1;
  }

  async discard(state: CallState): Promise<void> {
    await (await this.ready()).eval(DISCARD_SCRIPT, { keys: participantKeys(state), arguments: [state.id] });
  }

  async getIdentity(rawUserId: string): Promise<string | null> {
    return (await this.ready()).get(callKeys.identity(rawUserId));
  }

  async saveIdentity(rawUserId: string, canonicalId: string): Promise<void> {
    await (await this.ready()).set(callKeys.identity(rawUserId), canonicalId, { EX: TTL_SECONDS.identity });
  }
}
