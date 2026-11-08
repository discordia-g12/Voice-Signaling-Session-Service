# Voice-Signaling-Session-Service

Señalización de los canales de voz de Discordia (Node.js 20, TypeScript, Fastify 4). El audio y el video no
pasan por este servicio: los transporta **LiveKit** (un SFU de WebRTC). Este servicio:

- decide quién puede entrar a cada canal de voz (le pregunta a Server-Roles-Core) y le entrega un token de
  LiveKit que limita qué puede publicar: micrófono, cámara o pantalla, según sus roles;
- mantiene en Redis quién está en cada llamada y lo transmite por WebSocket (`/ws/voice`) a quienes miran el
  canal;
- recibe los webhooks de LiveKit (alguien entró, salió o se cortó) para mantener la presencia al día;
- saca de la llamada a quien banean, expulsan o abandona el servidor (eventos de RabbitMQ).

## Requisitos

- Node.js 20 (la versión de la imagen y del CI) y npm.
- Docker, para Redis y LiveKit.
- **Server-Roles-Core-Service** corriendo, para entrar a un canal: sin él, el join responde `503`. Con su
  `docker compose up -d` queda en `localhost:8080`.
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

El servicio llega a Server-Roles en `http://host.docker.internal:8080` (se cambia con `CORE_SERVICE_URL`), y
LiveKit le manda los webhooks a `http://host.docker.internal:8082/webhooks/livekit`.

Bajar todo: `docker compose down`.

### Desde el host, con recarga en caliente

Se levantan Redis y LiveKit con Docker, y el servicio con `npm run dev`. Tiene que escuchar en el **8082**,
que es adonde LiveKit manda los webhooks (y en el 8080 ya está Server-Roles):

```bash
npm install
docker compose up -d redis_voice livekit

# El servicio no lee .env: las variables van exportadas o en la línea
export PORT=8082 CORE_SERVICE_URL=http://localhost:8080 \
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
| `LIVEKIT_URL` | — (obligatoria) | URL interna de LiveKit, para su API (sacar participantes) y para `/readyz` |
| `LIVEKIT_PUBLIC_URL` | — (obligatoria) | URL de LiveKit que se le da al cliente. En producción, `wss://api.discordia.lol/livekit` |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | Sesiones y presencia |
| `CORE_SERVICE_URL` | `http://server-roles-service:8080` | Server-Roles-Core, para `can-connect` y `access` |
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
| `GET` | `/livez` | El proceso está vivo |
| `GET` | `/readyz` | Llega a Redis y a LiveKit (`503` con el detalle si no) |

Las llamadas a Server-Roles tienen timeout de 2 s y hasta 3 intentos con backoff para las fallas
transitorias ([ADR-03](docs/ADR-03-Synchronous-Dependencies.md)).

### Eventos que consume

Cola `voice_signaling_events`, enlazada a `member.banned`, `member.kicked` y `member.left` del exchange
`server.events`. Saca al usuario de la llamada si es de ese servidor, y lo bloquea para que no vuelva a entrar
con un token que ya tenía.

La misma cola está enlazada a `user.suspended` y `user.reactivated` del exchange `user.events` (Auth-User):

- `user.suspended`: saca de la llamada en la que esté, en cualquier servidor, a cada identidad de la cuenta
  (`identities`), le cierra el WebSocket de presencia con `4010` y la marca como suspendida
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

Los tests no necesitan Docker: simulan Redis, LiveKit, RabbitMQ y Server-Roles.

## Estructura

```text
src/
├── server.ts                    arranque: consumidor de eventos y HTTP
├── app.ts                       app de Fastify, configuración de LiveKit y Redis, /livez y /readyz
└── modules/voice/
    ├── voice.routes.ts          join y leave
    ├── presence.routes.ts       WebSocket /ws/voice
    ├── presence.ts              quién está en cada canal y a quién avisar
    ├── webhook.routes.ts        webhooks de LiveKit
    ├── permissions.ts           consultas a Server-Roles, con timeout y reintentos
    ├── events.ts                consumidor de RabbitMQ
    ├── moderation.ts            sacar de la llamada al banear o expulsar
    ├── sessions.ts              claves de Redis y duración del token
    └── heartbeat.ts             ping del WebSocket
tests/
```

## CI/CD

`.github/workflows/ci.yml`, en cada push y PR a `main` y `develop`:

1. `test-and-build`: lint, typecheck y tests, dentro del contenedor de `docker-compose.yaml`
   (`docker compose run voice_signaling_svc`). `npm audit` se muestra pero no bloquea: hoy reporta Fastify 4,
   que se corrige pasando a Fastify 5.
2. `docker`: construye la imagen; en push la publica como `ghcr.io/discordia-g12/voice-signaling-service:<sha>`.
3. `deploy`: en push a `main`, la despliega en el nodo **realtime** con el workflow del orquestador. Si no
   queda sana, vuelve sola a la versión anterior.

## Decisiones de arquitectura

| ADR | Tema |
|-----|------|
| [ADR-01](docs/ADR-01-CI-CD-Pipeline.md) | Pipeline de CI/CD |
| [ADR-02](docs/ADR-02-Voice-Presence.md) | Presencia de los canales de voz en tiempo real |
| [ADR-03](docs/ADR-03-Synchronous-Dependencies.md) | Dependencias sincrónicas (Server-Roles y LiveKit): timeouts, reintentos y `/readyz` |
