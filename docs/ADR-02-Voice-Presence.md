## ADR 02: Presencia de canales de voz en tiempo real (WebSocket)

**Contexto:**
La historia [#4 "Ver participantes conectados"](https://github.com/discordia-g12/Voice-Signaling-Session-Service/issues/4) pide que un miembro vea quién está conectado a **cada** canal de voz del servidor *antes de unirse* (CA 1), y que esa lista se actualice sin recargar (CA 2).

Hasta ahora el front solo conocía a los participantes de la sala a la que estaba conectado, porque LiveKit únicamente informa eventos de la sala en la que el cliente está. El dato de quién está en cada canal ya existía en Redis (`channel:{id}:users`), y con los webhooks de LiveKit (ver `src/modules/voice/webhook.routes.ts`) es confiable también cuando alguien se va sin llamar a `/leave` (cierra la pestaña, se queda sin red). Faltaba hacérselo llegar al front y mantenerlo actualizado.

Se evaluaron tres formas de actualizar la lista:

| Opción | Cómo funciona | Por qué no / por qué sí |
|---|---|---|
| Polling | El front vuelve a pedir la lista cada N segundos | Descartado: con N = 5 s el cambio tarda demasiado en verse, y bajar N multiplica los requests. |
| SSE (Server-Sent Events) | Conexión abierta, solo el servidor envía | Viable, pero al cambiar de servidor (y por lo tanto de canales) habría que cerrar y reabrir la conexión. |
| **WebSocket** | Conexión abierta en ambos sentidos | El cliente cambia su suscripción sin reconectar y el servidor empuja cada cambio al instante. |

**Decisión:**

* **Transporte:** WebSocket en `GET /ws/voice`, con el plugin oficial `@fastify/websocket` (v10, compatible con Fastify 4). El Gateway ya tenía la ruta `/ws/voice` apuntando a este servicio, con validación del token de Auth0 por query param (`?token=`) y timeouts de una hora; es el mismo patrón que usa el WebSocket del chat.
* **Fuente de verdad:** Redis (`channel:{channelId}:users`). La presencia no guarda participantes propios: cada aviso lee el set de Redis y manda la lista completa del canal (no deltas), así un mensaje perdido se corrige con el siguiente.
* **Permisos:** al suscribirse, cada canal se valida con `GET /internal/channels/{id}/can-connect` de Server-Roles-Core-Service (extraído a `src/modules/voice/permissions.ts`, el mismo chequeo que usa el join). Los canales sin acceso o inexistentes se descartan sin error.
* **Cuándo se avisa:** en el join (canal nuevo y, si se cambió de canal, el anterior), en el leave y en los webhooks de LiveKit (`participant_left`, `participant_connection_aborted`, `room_finished`) solo cuando efectivamente sacaron a alguien.
* **Suscripciones en memoria:** una única instancia de `VoicePresence` por proceso guarda qué socket mira qué canal.

**Cómo funciona:**

Hay que distinguir dos datos:

1. **Quién está en un canal** — vive en **Redis**. El join hace `SADD channel:{id}:users`; el leave o el webhook hacen `SREM`. Cuando sale el último, Redis borra el set solo (no guarda sets vacíos).
2. **Quién está mirando un canal** — vive en la instancia de **`VoicePresence`** (`src/modules/voice/presence.ts`), que se crea una sola vez al arrancar el servicio (`app.decorate('voicePresence', ...)` en `src/app.ts`). Tiene dos mapas:
   * `socketsByChannel`: canal → sockets que lo miran (para saber a quién avisar).
   * `channelsBySocket`: socket → canales que mira (para limpiar al cerrar o al cambiar de suscripción).

   Una entrada aparece cuando alguien abre un servidor en la WebApp y se suscribe a sus canales de voz, y desaparece cuando ya nadie lo mira, **aunque el canal tenga gente adentro**.

Flujo completo:

```
WebApp (useVoicePresence)                Gateway (Kong)              voice-signaling-service
        |                                      |                               |
        |-- WS /ws/voice?token=... ----------->|-- valida token, X-User-Id --->|
        |-- {type:"subscribe", channelIds} --------------------------------->  |
        |                                      |        access (VIEW_CHANNELS) por canal -> Server-Roles
        |<-- {type:"presence", channelId, userIds} (estado inicial, uno por canal permitido)
        |                                      |                               |
   (otro usuario hace join / leave, o llega un webhook de LiveKit)             |
        |                                      |   Redis SADD/SREM + publish(channelId)
        |<-- {type:"presence", channelId, userIds} (lista nueva de ese canal) -|
```

Protocolo de mensajes:

* Cliente → servidor: `{ "type": "subscribe", "channelIds": ["<uuid>", ...] }` (máximo 100). Cada `subscribe` **reemplaza** al anterior; si llegan dos seguidos, solo vale el último. Un mensaje inválido responde `{ "type": "error", "error": "Invalid message" }`.
* Servidor → cliente: `{ "type": "presence", "channelId": "<uuid>", "userIds": ["auth0|...", ...] }`, con los IDs ordenados.
* Sin `X-User-Id` (no pasó por el Gateway) la conexión se cierra con código `1008`.

En el front, `useVoicePresence(channelIds)` (Discordia-WebApp, `src/api/hooks/useVoicePresence.ts`) abre el socket mientras haya canales de voz que mirar, reenvía el `subscribe` al cambiar de servidor sin reconectar, y se reconecta con backoff exponencial (1 s a 15 s) si se corta. Para el canal en el que el propio usuario está conectado, el sidebar usa los datos de LiveKit (quién habla, mute) en lugar de los de presencia.

**Consecuencias:**

* Los cambios se ven en decenas de milisegundos (medido contra el stack local: estado inicial ~90 ms, join ~60 ms, leave ~15 ms). Las salidas sin `/leave` se ven cuando llega el webhook de LiveKit: al instante si el cliente cerró ordenadamente, hasta ~20 s si la conexión se cortó de golpe.
* Una conexión abierta por usuario mientras mira un servidor.
* **Una sola instancia:** las suscripciones viven en memoria del proceso. Si el servicio escala a varias instancias, un join atendido por una no avisaría a los sockets conectados a otra; habría que repartir los avisos con Redis pub/sub.
* **Permisos al suscribirse:** si a un usuario le quitan el acceso a un canal con la app abierta, sigue viendo su presencia hasta que vuelva a suscribirse (cambiar de servidor o recargar).
* **`CONNECT` en vez de `VIEW_CHANNELS`:** se reutiliza `can-connect`, así que se ven los canales a los que el usuario puede *conectarse*. En Discord alcanza con poder *ver* el canal. Hoy `VIEW_CHANNELS` no se evalúa en ningún lado de Server-Roles; cuando se implemente la sobrescritura de permisos por canal (Server-Roles #18) conviene agregar un `can-view` interno y usarlo acá. Los overrides que se carguen ya se respetan, porque `can-connect` los evalúa.
* Tests: `tests/presence.test.ts` (usa `app.injectWS`, sin levantar un servidor real) y `src/api/hooks/__tests__/useVoicePresence.test.tsx` en la WebApp.

**Actualización (27/10/2026):** la presencia ya no usa `can-connect` sino `GET /internal/channels/{id}/access`, que exige `VIEW_CHANNELS` (con los overrides del canal), el mismo chequeo que usa el chat para leer. Como en Discord, un usuario que puede ver un canal de voz ve quién está adentro aunque no tenga `CONNECT`; entrar a la llamada sigue pidiendo `can-connect`. Esto reemplaza el punto "`CONNECT` en vez de `VIEW_CHANNELS`" de las consecuencias.
