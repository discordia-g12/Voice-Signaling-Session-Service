## ADR 03: Dependencias sincrónicas del servicio de voz (Server-Roles y LiveKit)

**Contexto:**
El enunciado pide que la comunicación *entre servicios* backend sea asíncrona (eventos/colas) por defecto, que toda llamada sincrónica se justifique en un ADR, que las llamadas entre servicios contemplen fallos transitorios (se recomiendan Retry con backoff exponencial y Circuit Breaker) y que `/readyz` verifique las dependencias críticas del servicio.

Voice-Signaling-Session-Service depende de forma sincrónica de dos componentes:

* **Server-Roles-Core-Service** (`GET /internal/channels/{id}/can-connect?user_id=...`): decide si un usuario puede conectarse a un canal de voz. Lo usan el join (`POST /api/v1/voice/rooms/:channelId/join`) y la suscripción de presencia (`/ws/voice`, ver ADR-02).
* **LiveKit** (SFU, ver ADR 0007 del repo `.github`): recibe el audio. El servicio solo le habla por su API de servidor (consultar participantes en los webhooks), pero sin LiveKit no hay voz.

Antes de este ADR la llamada a `can-connect` no tenía timeout (si Server-Roles se colgaba, el join quedaba esperando indefinidamente), un error de Server-Roles se devolvía como `500` genérico y `/readyz` solo verificaba Redis.

**Decisión:**

* **`can-connect` se mantiene sincrónico.** El join necesita la respuesta para completar la operación que pidió el usuario: sin saber si tiene permiso no se puede firmar el token de LiveKit ni rechazarlo con `403`. Es el caso que el enunciado contempla como excepción ("el flujo necesita una respuesta inmediata para completar la operación solicitada por el usuario"). Además, el propio enunciado exige validar el acceso a un canal de voz contra los roles y permisos "antes de admitir la conexión".
* **Timeout y reintentos** (`src/modules/voice/permissions.ts`):
  * Timeout de **2 s por intento** (`AbortSignal.timeout`).
  * Hasta **3 intentos** con **backoff exponencial** (200 ms, 400 ms).
  * **Transitorio (se reintenta):** timeout, error de red, respuesta `5xx`.
  * **Permanente (no se reintenta):** `403` y `404` son respuestas válidas (sin permiso / canal inexistente); otro `4xx` es un error de contrato y se propaga.
  * Si se agotan los intentos, el join responde **`503 Permission service unavailable`** (antes `500`). En la presencia, el canal se trata como sin acceso y no se informa (falla cerrada).
  * Peor caso del join con Server-Roles caído: ~6,6 s (3 × 2 s + 0,6 s de espera), acotado.
* **Readiness** (`/readyz` en `src/app.ts`): verifica en paralelo **Redis** (`PING`) y **LiveKit** (`GET` a la raíz de su API HTTP interna, que responde `OK`), cada uno con timeout de 2 s. Si alguno falla responde `503` indicando cuál (`redis: ...`, `livekit: ...`). `/livez` no consulta dependencias.
* **Server-Roles no forma parte de `/readyz`:** el servicio sigue siendo útil sin él (leave, webhooks, presencia ya suscripta) y una caída de Server-Roles no se arregla reiniciando o sacando de rotación al voice-service; marcarlo no-ready propagaría la falla en cascada. Su indisponibilidad se refleja en el `503` del join.

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| Réplica local de permisos (consumir eventos de roles, membresías, bans y overrides y evaluar `can-connect` en el voice-service) | Elimina la llamada sincrónica, pero duplica la lógica de permisos (roles, overrides por canal, bans, mutes) en otro servicio y obliga a mantenerla consistente con eventos que hoy no existen. El costo supera el beneficio mientras la evaluación de permisos siga cambiando (Server-Roles #18). |
| Validar el permiso en el Gateway | Kong solo valida el token; meter lógica de dominio de permisos ahí rompe la separación de responsabilidades (ADR 0005). |
| Circuit Breaker | Recomendado por el enunciado, pero con una sola dependencia sincrónica, timeouts cortos y reintentos acotados el beneficio es chico: el peor caso ya está limitado. Se reconsidera si aparecen más dependencias sincrónicas o si los reintentos sobrecargan a Server-Roles en una caída (en ese caso: abrir el circuito tras N fallas seguidas y responder `503` sin llamar). |
| Incluir Server-Roles en `/readyz` | Ver arriba: falla en cascada. |

**Consecuencias:**

* El join ya no puede quedar colgado y distingue "no tenés permiso" (`403`) de "no se puede verificar ahora" (`503`). El front muestra el mensaje genérico de error de conexión para el `503`.
* Con Server-Roles caído, cada join tarda hasta ~6,6 s antes de fallar.
* Un deploy u orquestador puede usar `/readyz` para no mandar tráfico a una instancia sin Redis o sin LiveKit.
* Tests: `tests/permissions.test.ts` (reintentos, timeout, errores permanentes), `tests/health.test.ts` (`/livez`, `/readyz` con cada dependencia caída) y el caso `503` del join en `tests/voice.test.ts`.
* Pendiente relacionado: desconectar de la voz a un miembro baneado como reacción asíncrona a un evento de moderación (consumidor de RabbitMQ), cuando exista el evento de baneo.
