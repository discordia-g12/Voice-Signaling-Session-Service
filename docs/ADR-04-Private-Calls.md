## ADR 04: Llamadas privadas 1 a 1

**Contexto:**
La historia [#41](https://github.com/discordia-g12/Voice-Signaling-Session-Service/issues/41) (historia #50 del backlog) pide llamar por voz a otro usuario desde una conversación directa: suena del otro lado, se puede aceptar o rechazar, cualquiera de los dos corta y quien llama se entera de cómo terminó (rechazada, no respondió, ocupado, finalizada).

Lo que ya había y condiciona el diseño:

* El join de Voice (`POST /rooms/:channelId/join`) solo sirve para canales de servidor: le pregunta a Server-Roles (`can-connect`), y la presencia, los webhooks y la moderación usan `channel:{id}:users`, `user:{id}:voice_channel` y `channel:{id}:server`.
* Las conversaciones directas, el bloqueo, la suspensión y la regla de "¿puede escribirle?" (`ConversationService.assertCanSend`) viven en Chat-Engine. Chat ya tiene un inbox por usuario (`inbox:<id>` en `chat-redis`, por su WebSocket) que el cliente escucha siempre.
* Voice y Chat corren en el nodo realtime, en la misma red de Docker. Voice tiene una sola instancia.
* `X-User-Id` puede ser un alias (login federado): el id canónico lo conoce Chat (cache de Auth).

**Decisión:**

* **Audio por una sala de LiveKit de 2 personas.** Cada llamada es una sala `call-<uuid>` creada con `createRoom({ maxParticipants: 2, emptyTimeout: 60 })` antes de dar el token. El token (10 min, identidad = `X-User-Id` crudo, como en canales) solo deja publicar el micrófono. Quien llama entra al iniciar; quien recibe, al aceptar. El cliente reutiliza la misma integración con LiveKit que los canales.
* **Voice es dueño del estado, en voice-redis.** Módulo nuevo `src/modules/calls/` (no dentro de `voice/`: otro dominio, otra fuente de autorización, otras claves):
  * `call:<id>` (JSON con ids canónicos, identidades crudas, estado y fechas), `call:user:<canónico>` (marca de "ocupado") y `call:identity:<crudo>` (canónico, para poder cortar con Chat caído).
  * Reservar el "ocupado" de los dos y crear la llamada es un único script Lua (`SET NX` de los dos; si el segundo falla, libera el primero): dos llamadas a la vez a la misma persona no suenan las dos.
  * Toda transición es un compare-and-set en Lua sobre el JSON leído: aceptar y que venza el timbre a la vez no ganan los dos; quien pierde vuelve a leer y decide de nuevo. Terminar borra el "ocupado" de los dos en el mismo script.
  * TTLs de red de seguridad: 45 s sonando, 12 h activa, 5 min terminada.
* **Timer de 30 s en el proceso.** `setTimeout` por llamada, cancelable al aceptar, rechazar o cortar; al vencer intenta la transición `ringing → ended(missed)`, que pierde si otra ganó antes.
* **Autorización delegada a Chat.** Voice pregunta `GET /internal/conversations/:id/call-access` al iniciar y al aceptar (el bloqueo pudo aparecer mientras sonaba). Al aceptar, un `403 DM_PENDING` no corta: quien llama ya pasó el chequeo, y para quien recibe la conversación puede seguir sin aceptar (llama quien la rechazó). Chat aplica las mismas reglas que un DM y devuelve los ids canónicos. Para identificar a quien acepta, rechaza o corta: identidad cruda guardada en la llamada, `call:identity:` o `GET /internal/users/:id/canonical`.
* **Aviso por el inbox de Chat.** `POST /internal/inbox/events` publica `CALL_RINGING`, `CALL_ACCEPTED` y `CALL_ENDED` (motivo en `call.endReason`) a los dos participantes, en todos sus dispositivos. Si el aviso falla al iniciar, la llamada no se crea (`503`, se deshace la reserva y la sala); al terminar, un fallo se loguea y no frena el corte.
* **Dependencia sincrónica con Chat** (mismo criterio que ADR-03): timeout de 2 s; las lecturas se reintentan (3 intentos, backoff 200 / 400 ms); publicar en el inbox no, porque Chat pudo haberlo publicado aunque no llegue la respuesta. Chat no entra en `/readyz`: sin Chat siguen andando los canales y cortar una llamada.
* **Webhooks.** Las salas `call-` se separan por prefijo y no tocan las claves ni la presencia de los canales: si quien llama se va mientras suena → `canceled`; si cualquiera se va de una activa → `ended` (solo si ya no está en la sala, por las recargas); `room_finished` → `canceled` / `ended`; quien entra a una llamada terminada o ajena se saca. `user.suspended` termina la llamada de cualquiera de las identidades del evento (`unavailable`).

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| WebRTC P2P (sin SFU) | Hace falta señalización propia (ofertas, candidatos ICE) y TURN para los NAT simétricos. LiveKit ya resuelve todo eso, ya está desplegado y el cliente ya lo usa en los canales. |
| WebSocket propio de Voice para avisar | El cliente ya mantiene el WebSocket de Chat (inbox) siempre abierto; `/ws/voice` solo está abierto mientras se mira un servidor. Un socket más por usuario duplica reconexión, autenticación en Kong y multi-dispositivo. |
| Eventos por RabbitMQ (Voice publica, Chat reenvía al inbox) | Es asincrónico: al iniciar no se sabe si el aviso salió, y la regla es que sin aviso no hay llamada. Agrega un consumidor en Chat para un reenvío 1 a 1 y depende del nodo infra para algo que pasa entero en el nodo realtime. |
| Voice escribe directo en `chat-redis` | Acopla Voice al formato interno y a la base de Chat (otro dueño, otra red lógica); cualquier cambio del inbox rompe Voice en silencio. |
| Voice consulta a Auth (o guarda su propia lista de bloqueos) | La regla "¿puede contactarlo?" (participante, bloqueo en los dos sentidos, suspensión, `pending`) ya está en Chat; repetirla en Voice la duplica y diverge. Chat ya tiene el cache del id canónico. |
| Timer distribuido (cola con retardo, keyspace notifications de Redis) | Con una sola instancia no hace falta. Las notificaciones de expiración de Redis no son confiables (llegan cuando Redis nota la expiración) y no traen el valor. |

**Consecuencias:**

* Iniciar o aceptar depende de Chat: con Chat caído responden `503` y no se crea nada. Cortar funciona igual (identidad cruda guardada en la llamada).
* **Límite del timer en proceso:** con más de una instancia de Voice, el timer queda en la que atendió el inicio. Si esa instancia muere mientras suena, nadie publica `missed`: el TTL de 45 s libera el "ocupado" y el cliente tiene un timeout local (`expiresAt + 10 s`) que da la llamada por perdida y manda `end`. Para escalar horizontalmente hay que mover el timer (p. ej. un barrido periódico de llamadas vencidas con el mismo compare-and-set) y la presencia (ADR-02).
* Bloquear durante una llamada activa no la corta (deuda): el bloqueo solo se revisa al iniciar y al aceptar.
* Si el proceso se cae con una llamada activa, el "ocupado" dura hasta que LiveKit cierre la sala (`room_finished`) o venza el TTL de 12 h.
* Tests: `tests/calls.test.ts` (cada CA, ocupado, bloqueo al iniciar y al aceptar, Chat caído, carrera aceptar vs. timbre, webhooks de salas `call-`, suspensión) y `tests/chat-client.test.ts` (timeouts, reintentos, errores permanentes).
