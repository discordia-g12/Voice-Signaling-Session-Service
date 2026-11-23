# Voice-Signaling-Session-Service

Señalización de los canales de voz de Discordia (Node.js 20, TypeScript, Fastify 4). El audio y el video no
pasan por este servicio: los transporta **LiveKit** (un SFU de WebRTC). Este servicio:

- decide quién puede entrar a cada canal de voz (le pregunta a Server-Roles-Core) y le entrega un token de
  LiveKit que limita qué puede publicar: micrófono, cámara o pantalla, según sus roles;
- mantiene en Redis quién está en cada llamada y lo transmite por WebSocket (`/ws/voice`) a quienes miran el
  canal;
- recibe los webhooks de LiveKit (alguien entró, salió o se cortó) para mantener la presencia al día;
- saca de la llamada a quien banean, expulsan o abandona el servidor (eventos de RabbitMQ);
- maneja las **llamadas privadas 1 a 1** desde una conversación directa: estado en Redis, una sala de LiveKit de
  2 personas por llamada, autorización delegada a Chat-Engine y aviso por el inbox de Chat
  ([ADR-04](docs/ADR-04-Private-Calls.md)).

## Requisitos

- Node.js 20 (la versión de la imagen y del CI) y npm.
- Docker, para Redis y LiveKit.
- **Server-Roles-Core-Service** corriendo, para entrar a un canal: sin él, el join responde `503`. Con su
  `docker compose up -d` queda en `localhost:8080`.
- **Chat-Engine-Service** corriendo, para las llamadas privadas: sin él, iniciar o aceptar una llamada responde
  `503` (cortar sigue funcionando). Con su `docker compose up -d` queda en `localhost:3000`.
- RabbitMQ es opcional: sin él (sin `RABBITMQ_URL`), un usuario baneado no se saca de la llamada en vivo.

## Levantarlo en local

### Todo en contenedores

```bash
docker compose up -d --build
curl localhost:8082/readyz        # {"status":"ready"}: llega a Redis y a LiveKit
```

`docker-compose.yaml` levanta:

| Servicio | Puerto en el host | Para qué |
|---|---|---|
| `voice_signaling_svc` | 8082 | Este servicio |
| `redis_voice` | 6379 | Sesiones y presencia |
| `livekit` (v1.13.7, modo `--dev`) | 7880, 7881/tcp, 7882/udp | SFU. Claves de desarrollo: `devkey` / `secret` |

El servicio llega a Server-Roles en `http://host.docker.internal:8080` (se cambia con `CORE_SERVICE_URL`), a Chat
en `http://host.docker.internal:3000` (`CHAT_SERVICE_URL`), y
LiveKit le manda los webhooks a `http://host.docker.internal:8082/webhooks/livekit`.

Bajar todo: `docker compose down`.

### Desde el host, con recarga en caliente

Se levantan Redis y LiveKit con Docker, y el servicio con `npm run dev`. Tiene que escuchar en el **8082**,
que es adonde LiveKit manda los webhooks (y en el 8080 ya está Server-Roles):

```bash
npm install
docker compose up -d redis_voice livekit

# El servicio no lee .env: las variables van exportadas o en la línea
export PORT=8082 CORE_SERVICE_URL=http://localhost:8080 CHAT_SERVICE_URL=http://localhost:3000 \
  LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  LIVEKIT_URL=ws://localhost:7880 LIVEKIT_PUBLIC_URL=ws://localhost:7880
npm run dev
```

Las cuatro variables de LiveKit son obligatorias: sin ellas el servicio no arranca, para no firmar tokens
con un secreto conocido.

### Probarlo

Hace falta un canal de voz real: crear un servidor en Server-Roles (`POST /api/v1/servers`, que trae un
canal de voz "Voz General") y usar su `id`. Sin Kong adelante, la identidad va en `x-user-id`:

```bash
CANAL=<id del canal de voz>
curl -X POST localhost:8082/api/v1/voice/rooms/$CANAL/join -H "x-user-id: auth0|local-test"
# {"token":"eyJ...","url":"ws://localhost:7880","permissions":{"canSpeak":true,"canVideo":true,"canScreenShare":true}}

npx wscat -c ws://localhost:8082/ws/voice -H "x-user-id: auth0|local-test"
> {"type":"subscribe","channelIds":["<id del canal de voz>"]}
< {"type":"presence","channelId":"...","userIds":["auth0|local-test"]}

curl -X POST localhost:8082/api/v1/voice/rooms/leave -H "x-user-id: auth0|local-test"
```

Para hablar de verdad hace falta un cliente de LiveKit con ese token (la web o la app mobile de
Discordia-WebApp).

Llamada privada (con Chat-Engine levantado y una conversación directa `accepted` entre los dos usuarios):

```bash
curl -X POST localhost:8082/api/v1/voice/calls -H "x-user-id: auth0|alice" \
  -H "content-type: application/json" -d '{"conversationId":"dm-..."}'
# 201 {"call":{"id":"<callId>","status":"ringing",...},"token":"eyJ...","url":"ws://localhost:7880","permissions":{...}}

curl localhost:8082/api/v1/voice/calls/current -H "x-user-id: auth0|bob"      # {"call":{... "status":"ringing"}}
curl -X POST localhost:8082/api/v1/voice/calls/<callId>/accept -H "x-user-id: auth0|bob"
curl -X POST localhost:8082/api/v1/voice/calls/<callId>/end -H "x-user-id: auth0|alice"   # 204
```

### Con el resto del sistema

Para levantarlo junto con el Gateway y los demás servicios, usar el compose del orquestador
(`discordia-orchestrator/deploy/docker-compose.yml`, profile `local`). Ahí el cliente entra por Kong
(`/api/v1/voice`, `/ws/voice` y `/livekit` para la señalización de LiveKit) y el audio va directo a LiveKit
por UDP 7882.

Si también corrés Chat-Engine con su propio compose, los dos publican Redis en el 6379: levantá uno solo de
los dos Redis, o cambiá el puerto de uno.

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `8080` | Puerto HTTP y WebSocket |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | — (obligatorias) | Claves con las que se firman los tokens y se validan los webhooks. Las mismas que tiene LiveKit |
| `LIVEKIT_URL` | — (obligatoria) | URL interna de LiveKit, para su API (crear y borrar salas, sacar participantes) y para `/readyz` |
| `LIVEKIT_PUBLIC_URL` | — (obligatoria) | URL de LiveKit que se le da al cliente. En producción, `wss://api.discordia.lol/livekit` |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | Sesiones y presencia |
| `CORE_SERVICE_URL` | `http://server-roles-service:8080` | Server-Roles-Core, para `can-connect` y `access` |
| `CHAT_SERVICE_URL` | `http://chat-engine-service:3000` | Chat-Engine, para las llamadas privadas: `call-access`, id canónico e inbox |
| `INTERNAL_API_TOKEN` | — | Secreto compartido con Chat: va en `X-Internal-Token` al publicar en el inbox. Tiene que ser el mismo que el de Chat; si Chat lo tiene y Voice no, avisar una llamada falla |
| `RABBITMQ_URL` | — | Broker. Sin él no se consumen eventos (aviso en el log) |
| `RABBITMQ_EXCHANGE` / `RABBITMQ_QUEUE` | `server.events` / `voice_signaling_events` | De dónde consume |
| `RABBITMQ_USER_EXCHANGE` | `user.events` | Exchange de Auth-User, del que consume `user.suspended` y `user.reactivated` |

## API

En producción está detrás de Kong, que valida el token y agrega `x-user-id`.

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/v1/voice/rooms/:channelId/join` | Valida el acceso con Server-Roles (`can-connect`), registra la sesión y devuelve `{token, url, permissions}`. El token dura 10 minutos y solo sirve para entrar. `403` sin permiso, `404` canal inexistente, `503` si Server-Roles no responde |
| `POST` | `/api/v1/voice/rooms/leave` | Saca al usuario de su llamada actual y avisa a los que miran el canal |
| `GET` | `/ws/voice` | WebSocket de presencia: el cliente manda `{"type":"subscribe","channelIds":[...]}` y recibe `{"type":"presence","channelId","userIds"}` al suscribirse y en cada cambio. Solo de los canales que puede ver |
| `POST` | `/webhooks/livekit` | Webhooks de LiveKit (firmados con las claves): `participant_joined`, `participant_left`, `participant_connection_aborted` y `room_finished`. `401` si la firma no es válida |
| `POST` | `/api/v1/voice/calls` | Inicia una llamada privada: body `{conversationId}`. `201 {call, token, url, permissions}` (quien llama entra a la sala `call-<id>`; el token deja publicar micrófono, cámara y pantalla). `400`, `403 DM_NOT_DELIVERABLE` / `DM_PENDING`, `404 CONVERSATION_NOT_FOUND`, `409 CALL_BUSY`, `503 CHAT_UNAVAILABLE` / `LIVEKIT_UNAVAILABLE` |
| `POST` | `/api/v1/voice/calls/:callId/accept` | Solo quien recibe, solo sonando. `200 {call, token, url, permissions}`. Vuelve a pasar por Chat: `403 DM_NOT_DELIVERABLE` termina la llamada (`unavailable`). `403 CALL_NOT_CALLEE`, `404 CALL_NOT_FOUND`, `409 CALL_NOT_RINGING`, `503` |
| `POST` | `/api/v1/voice/calls/:callId/decline` | Solo quien recibe, solo sonando. `204`; `409 CALL_NOT_RINGING` |
| `POST` | `/api/v1/voice/calls/:callId/end` | Cualquiera de los dos. `204`, idempotente. Sonando: `canceled` (quien llama) o `declined` (quien recibe); activa: `ended`. Funciona con Chat caído |
| `GET` | `/api/v1/voice/calls/current` | `200 {call}`: la llamada sonando o activa de quien pide, o `null` |
| `GET` | `/livez` | El proceso está vivo |
| `GET` | `/readyz` | Llega a Redis y a LiveKit (`503` con el detalle si no) |

Las llamadas a Server-Roles tienen timeout de 2 s y hasta 3 intentos con backoff para las fallas
transitorias ([ADR-03](docs/ADR-03-Synchronous-Dependencies.md)). Las de Chat, igual para las lecturas; publicar
en el inbox se intenta una sola vez ([ADR-04](docs/ADR-04-Private-Calls.md)).

Los errores de las llamadas privadas van en Problem Details (`application/problem+json`, con `code`). Las rutas de
canales no cambiaron.

### Llamadas privadas

El estado vive en Redis (`call:<id>`, `call:user:<canónico>` para "ocupado", `call:identity:<X-User-Id>`), separado
de las claves de canales. Suena 30 s (timer en el proceso; sin respuesta termina `missed`). Los dos se enteran por
el inbox de Chat: `CALL_RINGING`, `CALL_ACCEPTED` y `CALL_ENDED` (el motivo en `call.endReason`: `declined`,
`missed`, `canceled`, `ended`, `unavailable`). Los webhooks de las salas `call-` terminan la llamada si alguien se
va sin cortar; no tocan la presencia de los canales.

### Eventos que consume

Cola `voice_signaling_events`, enlazada a `member.banned`, `member.kicked` y `member.left` del exchange
`server.events`. Saca al usuario de la llamada si es de ese servidor, y lo bloquea para que no vuelva a entrar
con un token que ya tenía.

También a `server.suspended` y `server.unsuspended` del mismo exchange (servidor suspendido por el staff, ADR-002 de
Server-Roles):

- `server.suspended`: saca a todos de las llamadas de sus canales de voz (`voice_channel_ids`) y marca el servidor
  (`voice:server-suspended:<id>`, 24 h). Server-Roles ya niega `/join` (`can-connect` responde `403`); la marca hace
  que el webhook saque a quien entre con un token de LiveKit emitido antes;
- `server.unsuspended`: borra esa marca.

La misma cola está enlazada a `user.suspended` y `user.reactivated` del exchange `user.events` (Auth-User):

- `user.suspended`: saca de la llamada en la que esté, en cualquier servidor, a cada identidad de la cuenta
  (`identities`), termina su llamada privada (`unavailable`), le cierra el WebSocket de presencia con `4010` y la marca como suspendida
  (`voice:suspended:<id>`, 24 h). Si entra con un token de LiveKit
  que ya tenía, el webhook `participant_joined` la vuelve a sacar: la señalización de LiveKit no pasa por el
  validador de Kong, así que la lista de suspendidos del Gateway no la frena;
- `user.reactivated`: borra esa marca, para que pueda volver a entrar.

## Tests, lint y seguridad

Los mismos chequeos que corre el CI (ahí van dentro del contenedor, con
`docker compose run --rm voice_signaling_svc sh -c "npm run lint && npm run typecheck && npm run test"`):

```bash
npm run lint                   # ESLint, con reglas de seguridad
npm run typecheck              # tsc --noEmit
npm audit --audit-level=high   # dependencias con vulnerabilidades
npm run test:coverage          # tests + cobertura (mínimo 85 %, ver ADR-01)
```

Los tests simulan LiveKit, RabbitMQ, Server-Roles y Chat; usan un Redis real (`REDIS_HOST` / `REDIS_PORT`,
por defecto `localhost:6379`), p. ej. el de `docker compose up -d redis_voice`.

## Estructura

```text
src/
├── server.ts                    arranque: consumidor de eventos y HTTP
├── app.ts                       app de Fastify, configuración de LiveKit y Redis, /livez y /readyz
└── modules/
    ├── calls/                   llamadas privadas 1 a 1
    │   ├── calls.routes.ts      /api/v1/voice/calls (Problem Details)
    │   ├── calls.service.ts     iniciar, aceptar, rechazar, cortar, timer, webhooks de salas call-
    │   ├── state.ts             claves de Redis, TTLs y transiciones atómicas (Lua)
    │   └── chat.ts              cliente de Chat-Engine: call-access, canónico e inbox
    └── voice/
        ├── voice.routes.ts      join y leave
        ├── presence.routes.ts   WebSocket /ws/voice
        ├── presence.ts          quién está en cada canal y a quién avisar
        ├── webhook.routes.ts    webhooks de LiveKit
        ├── permissions.ts       consultas a Server-Roles, con timeout y reintentos
        ├── events.ts            consumidor de RabbitMQ
        ├── moderation.ts        sacar de la llamada al banear o expulsar
        ├── sessions.ts          claves de Redis y duración del token
        └── heartbeat.ts         ping del WebSocket
tests/
```

## CI/CD

`.github/workflows/ci.yml`, en cada push y PR a `main` y `develop`:

1. `test`: lint, typecheck y tests con Node en el runner y Redis como service container (los tests mockean
   LiveKit y los otros servicios). `npm audit` se muestra pero no bloquea: hoy reporta Fastify 4, que se
   corrige pasando a Fastify 5.
2. `docker`: solo en push (y en los PRs de Dependabot de la imagen base): construye la imagen y la publica
   como `ghcr.io/discordia-g12/voice-signaling-service:<sha>`.
3. `deploy`: en push a `main`, la despliega en el nodo **realtime** con el workflow del orquestador. Si no
   queda sana, vuelve sola a la versión anterior.

## Decisiones de arquitectura

| ADR | Tema |
|-----|------|
| [ADR-01](docs/ADR-01-CI-CD-Pipeline.md) | Pipeline de CI/CD |
| [ADR-02](docs/ADR-02-Voice-Presence.md) | Presencia de los canales de voz en tiempo real |
| [ADR-03](docs/ADR-03-Synchronous-Dependencies.md) | Dependencias sincrónicas (Server-Roles y LiveKit): timeouts, reintentos y `/readyz` |
| [ADR-04](docs/ADR-04-Private-Calls.md) | Llamadas privadas 1 a 1: sala de LiveKit, estado en Redis, autorización en Chat y aviso por el inbox |
