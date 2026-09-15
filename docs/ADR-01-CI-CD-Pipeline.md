## ADR 01: Pipeline de CI y alcance de CD

**Contexto:**
El enunciado del TP exige un pipeline de CI que corra automáticamente ante cada push y **bloquee el merge** ante fallas en los tests, con cobertura mínima del 70% en los servicios backend, y recomienda incorporar análisis estático de seguridad (SAST). También exige CD (despliegue automático a producción desde `main` o por tags), documentado. No existía ningún workflow de CI/CD ni carpeta `docs/` en este repo todavía — es el primer ADR de `Voice-Signaling-Session-Service`.

Como paso previo (commit aparte, antes de este ADR) se migró el repo de JavaScript plano a **TypeScript**, alineándolo con el ADR 0002 del org (`docs/architecture/decisions/0002-backend-technology-stack.md`, repo `.github`), que especifica "Node.js / TypeScript" para este servicio. Ese mismo commit corrigió también un bug preexistente: `/readyz` se colgaba indefinidamente en vez de responder `503` cuando Redis estaba inalcanzable, porque el cliente de `redis` v4 reintenta conectar indefinidamente por default. Se acotó con un timeout y se deshabilitó el reintento automático del cliente usado para el health check. Este ADR ya trabaja sobre el código en TypeScript, con `/readyz` corregido.

**Decisión:**

* **Test runner:** `node:test` (vía `tsx --test`) + `c8` para cobertura — mismo criterio que en Chat-Engine-Service, cero framework de testing nuevo para minimizar dependencias. Se agregaron los primeros tests del repo (`tests/health.test.ts`), usando `app.inject()` de Fastify. Incluyen el caso de `/readyz` con Redis inalcanzable — es la prueba que hubiera detectado el bug del cuelgue antes de que llegara a producción.
* **Type checking:** `tsc --noEmit` como paso de CI aparte (`npm run typecheck`).
* **Lint:** ESLint con flat config (`eslint.config.js`), vía `typescript-eslint` + `eslint-plugin-security`.
* **SAST:** `eslint-plugin-security` (integrado al lint) + `npm audit --audit-level=high` como paso aparte, informativo (no bloquea el merge).
* **Cobertura:** `c8 --check-coverage` con gate en **85%** (lines/functions/branches/statements), bloqueando merge por debajo — mismo umbral que el resto de los servicios del equipo.
* **Servicio en CI:** `redis:7-alpine` como service container (misma imagen que `docker-compose.yaml`), usado de verdad por los tests de `/readyz`.
* **Build de imagen:** job separado `docker-build`, corre `docker build` sobre el `Dockerfile` (multi-stage, TypeScript) existente, sin push — no hay registry/target de deploy configurado todavía. Verificado además que compila y corre correctamente a través del `docker-compose.yml` del orquestador raíz del monorepo, no solo con el compose local del servicio.
* **Bloqueo de merge:** el job `test` se configura como *required status check* en `main`/`develop` desde GitHub, una vez confirmada una corrida verde real en un PR. El merge nunca es automático.

**CD — explícitamente fuera de alcance de este ADR:**
El enunciado exige documentar en un ADR la elección de plataforma de despliegue antes de automatizar el deploy. A la fecha de este ADR no existe esa decisión en `docs/architecture/decisions/` del repo `.github` — mismo motivo por el que CD quedó pendiente en Auth-User-Service y Chat-Engine-Service. **CD queda pendiente** hasta que exista esa decisión.

**Consecuencias:**

* El pipeline queda verde con 4 tests reales (health checks, incluyendo el caso de falla de Redis) — la cobertura del 85% se alcanza porque `app.ts` es casi todo lo que hay hoy. A medida que se agregue lógica real de señalización (LiveKit, sesiones de voz), el umbral va a exigir tests reales de esa lógica.
* Cuando exista un ADR de infraestructura de despliegue, este ADR debe actualizarse (o crearse uno nuevo) agregando el job de CD correspondiente.
