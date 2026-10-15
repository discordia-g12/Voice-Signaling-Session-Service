import type { WebSocket } from 'ws';

/**
 * Cloudflare (y otros proxies) cierran los WebSockets que pasan ~100 s sin tráfico. Con un ping cada
 * 30 s la conexión de un canal tranquilo sigue viva.
 */
export const DEFAULT_PING_INTERVAL_MS = 30_000;

/**
 * Manda un ping de protocolo (no un mensaje de la app: navegadores y apps responden el pong solos)
 * cada `intervalMs`. Si el cliente no respondió el anterior, la conexión está muerta (sin red, app
 * suspendida) y se termina, para no seguir mandándole mensajes.
 *
 * @returns función que frena el heartbeat; llamarla al cerrarse la conexión.
 */
export function startHeartbeat(socket: WebSocket, intervalMs: number): () => void {
  let alive = true;
  const onPong = () => {
    alive = true;
  };
  socket.on('pong', onPong);

  const timer = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, intervalMs);

  return () => {
    clearInterval(timer);
    socket.off('pong', onPong);
  };
}
