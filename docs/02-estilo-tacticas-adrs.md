# RiTech EUDR — Documentación de Arquitectura

## Parte 2: Estilo, Tácticas, ADRs y Riesgos

> Trazabilidad con la Parte 1: cada decisión cita el driver (D1, D2, D3) y el escenario (E1, E2, E3) que la motiva, y dice qué atributo sacrifica.

---

## 1. Estilo arquitectónico: **Microservicios de grano grueso (1 servicio = 1 bounded context)**

| Contenedor | Bounded context | Driver principal |
|---|---|---|
| `registro-service` | BC1 Registro de Productores y Parcelas | (soporte) |
| `geo-service` | BC2 Cumplimiento Geoespacial | **D2** |
| `trazabilidad-service` | BC3 Trazabilidad de Lotes | **D1** |
| `dds-service` | BC4 Debida Diligencia y Pasarela UE | **D3** |
| `api-gateway` | BC5 Identidad y Acceso (genérico: JWT + RBAC) | Seguridad (A,B) |

Hay **una base de datos lógica por servicio**. En el esqueleto son 4 bases dentro de una sola instancia de PostgreSQL + PostGIS. Cada base tiene su propio usuario y `REVOKE CONNECT ... FROM PUBLIC`, de modo que ningún servicio puede leer la base de otro.

### Por qué (driver)

- **D3 / E3, el driver decisivo.** E3 exige que *"las funciones que no dependen de la UE mantengan su disponibilidad"* durante 6 h de caída del sistema UE. El cliente de la UE pasará esas horas reintentando, con sockets colgados, *timeouts* y respuestas inesperadas que el traductor (ACL) tiene que interpretar. En un monolito, ese código comparte **proceso, event loop de Node y pool de conexiones** con el registro y la trazabilidad. Un fallo no controlado o una fuga de memoria del cliente UE se los llevaría por delante. Separar procesos funciona como un **bulkhead físico**: si `dds-service` se cae, solo deja de funcionar el envío de DDS.
- **D1 / E1, como refuerzo.** El *ledger* de trazabilidad tiene un único proceso con credenciales para escribirlo, y esas credenciales solo permiten `INSERT`/`SELECT`. La propiedad de los datos se impone **por red y por credenciales**, no por la disciplina del equipo. Es un argumento que se le puede mostrar a un auditor.
- **D2 / E2, como refuerzo.** Los datasets forestales y las reglas tienen un ritmo de cambio propio (Parte 1, BC2 [C]). Una nueva versión de dataset o de regla solo despliega `geo-service`.

### Qué sacrifica

| Atributo degradado | Cómo se manifiesta | Por qué se acepta |
|---|---|---|
| **Simplicidad operativa / despliegue** | 7 contenedores, 3 redes y observabilidad distribuida, frente a 1 proceso | Se limita con grano grueso: 4 servicios, no 20 |
| **Consistencia inmediata** | Un veredicto tarda unos 1–2 s en llegar de BC2 a BC3 (outbox) | Es *fail-closed*: sin veredicto replicado la parcela no entra en ningún lote, así que nunca aparece un falso CONFORME |
| **Rendimiento (latencia)** | Saltos de red adicionales (gateway → registro → geo) | Rendimiento es (M,M), no es driver |
| **Facilidad de prueba end-to-end** | Hace falta levantar todo el sistema | Se resuelve con `docker compose up` y el contenedor `demo` |

---

## 2. Tácticas aplicadas

### Contra E1 (Auditabilidad, D1)

| # | Táctica | Implementación en el esqueleto | Qué degrada |
|---|---|---|---|
| T1 | **Registro append-only** | Las tablas de `trazabilidad` pertenecen a `postgres`. El servicio solo tiene `GRANT SELECT, INSERT`. Además, un trigger `prohibir_mutacion` bloquea `UPDATE`/`DELETE`/`TRUNCATE` (defensa en profundidad). | **Modificabilidad de datos**: un error solo se corrige con un evento compensatorio. También aumenta el almacenamiento. |
| T2 | **Cadena de hashes** | `hash = sha256(prev_hash \| evento_id \| tipo \| lote_id \| payload canónico)`. `GET /auditoria/verificacion` recalcula la cadena entera. | **Rendimiento de escritura**: un *advisory lock* global serializa las escrituras para encadenar los hashes (ver Paso 5, pregunta 4). |
| T3 | **Snapshot del veredicto en el evento** | `LoteRecibido` copia el veredicto vigente: estado, versión del dataset, versión de la regla y fecha. | **Consistencia/almacenamiento**: el dato de BC2 queda duplicado a propósito. |
| T4 | **Seudonimización (separar PII)** | BC3 solo guarda `parcelaId`. El nombre y documento del productor viven en BC1. Resuelve la tensión con el RGPD (Parte 1 §4.1): se borra la PII en BC1 y el ledger no se toca. | **Usabilidad del auditor**: para ver el nombre hace falta una consulta a BC1. |
| T5 | **Linaje con CTE recursiva** | `WITH RECURSIVE` sobre `lote_origen`, más la tabla `lotes_consumidos` (PK), que impide consumir un lote dos veces. | Acopla el diseño a PostgreSQL. |

### Contra E2 (Corrección geoespacial, D2)

| # | Táctica | Implementación | Qué degrada |
|---|---|---|---|
| T6 | **Usar un motor geoespacial probado** | La validación se hace en PostGIS (`ST_IsValid`, `ST_Intersects`, `ST_Area(::geography)`), no en JavaScript propio. | **Portabilidad** (dependencia de PostGIS) y **latencia** (ida y vuelta a la BD). |
| T7 | **Determinismo versionado** | Cada veredicto guarda `datasetVersion`, `reglaVersion` y `hashEntrada`. | Almacenamiento; migrar un dataset implica re-evaluar parcelas. |
| T8 | **Fail-closed** | Si una geometría es mal formada o inválida → `INVALIDA`. Un punto en una parcela > 4 ha → `INVALIDA`. Si toca un área deforestada, aunque sea solo el borde → `NO_CONFORME`. Si `geo-service` no responde → la parcela queda `PENDIENTE` y no puede entrar en un lote. | **Disponibilidad percibida**: el agricultor puede quedar bloqueado y se aceptan más falsos positivos. Se prefiere un falso positivo (se revisa a mano) a un falso negativo (sanción). |
| T9 | **Golden dataset** | Casos con resultado esperado conocido. El `demo` incluye una versión mínima de 5 casos. | Coste de mantener el dataset. |

### Contra E3 (Interoperabilidad UE, D3)

| # | Táctica | Implementación | Qué degrada |
|---|---|---|---|
| T10 | **Outbox transaccional** | La DDS se guarda como `PENDIENTE_ENVIO` en la misma transacción que la crea; la tabla `declaraciones` hace de cola. El exportador recibe `202 Accepted`. | **Inmediatez**: el número de referencia llega más tarde (consistencia eventual). |
| T11 | **Reintento con backoff exponencial + jitter + timeout** | El worker interno reintenta con `min(1s·2^n, 15s)` + jitter y un timeout de 5 s por llamada. | **Latencia** hasta el registro definitivo. |
| T12 | **Idempotencia** | `Idempotency-Key = id de la DDS`. El reintento tras un timeout ambiguo no duplica. | Depende de que la UE la soporte → **Riesgo R-1**. |
| T13 | **Anti-Corruption Layer** | `src/acl/traductor-ue.js` traduce el modelo interno al esquema UE; nada más conoce ese esquema. | Una capa más que mantener cuando cambia la API UE. |
| T14 | **Bulkhead por proceso y por red** | `dds-service` es el **único** servicio conectado a la red `externa`. `datos` es una red `internal`, sin salida. | Más configuración de red. |

### Transversal (Seguridad, A,B: tácticas estándar, sin ser driver)

- **T15 Gateway único + JWT + RBAC:** el rol `AUDITOR` solo puede hacer `GET`; las rutas `/internal/*` no se exponen. Solo el gateway publica un puerto (8080). **Degrada:** el gateway es un punto único de fallo y añade un salto de latencia.

---

## 3. ADRs

### ADR-001 — Microservicios de grano grueso por bounded context

- **Estado:** Aceptada
- **Contexto:** Hay tres drivers con ritmos de cambio y modos de fallo distintos (Parte 1). D3 depende de un sistema externo inestable y E3 exige que ese fallo no se propague.
- **Decisión:** Un servicio Node.js/Express por BC (4) más un API Gateway, cada uno con su propia base de datos lógica en PostgreSQL. La comunicación usa REST/JSON de forma síncrona donde el escenario exige respuesta inmediata (E2: registro → geo) y un outbox con relay HTTP donde basta la consistencia eventual (geo → trazabilidad).
- **Driver:** D3 (E3), con D1 y D2 como refuerzo.
- **Alternativas descartadas:**
  1. **Monolito modular.** Era la alternativa más fuerte. Es más simple, tiene transacciones locales y es más fácil de depurar. Se descarta porque un solo proceso Node comparte el event loop y el pool entre el cliente UE en modo degradado y la trazabilidad, lo que viola la medida de E3. Además, la propiedad del ledger quedaría en manos de la disciplina del equipo.
  2. **Arquitectura en capas clásica (un monolito).** Organiza el código por capa técnica, no por dominio. Mezcla el lenguaje de BC1 y BC2 ("Parcela" tiene dos significados) y no aísla fallos.
  3. **Nanoservicios (un servicio por agregado o caso de uso).** Multiplica el coste operativo sin que ningún driver lo pida. Escalabilidad es (B,M).
  4. **Serverless/FaaS.** Queda fuera de la restricción T1 (Docker Compose). Además, el worker de reintentos de larga duración y las conexiones a PostGIS no encajan bien con funciones efímeras.
- **Consecuencias positivas:** Aislamiento de fallos (E3). Despliegue independiente del motor geoespacial (D2). Propiedad del ledger forzada por credenciales (D1).
- **Consecuencias negativas (lo malo):**
  - **Consistencia eventual** entre BC2 y BC3. Durante unos segundos una parcela recién aprobada todavía no se puede usar (409). Es visible en la demo.
  - **No hay transacciones distribuidas.** Si `registro` guarda la parcela y la llamada a `geo` falla, queda `PENDIENTE` y hace falta `POST /parcelas/:id/reevaluar`.
  - **Una sola instancia de PostgreSQL** para las 4 bases (concesión del esqueleto): es un único dominio de fallo de datos y un límite compartido de `max_connections`. El aislamiento es lógico, no físico.
  - **Acoplamiento punto a punto** en el relay: `geo-service` conoce la URL de `trazabilidad-service`. Añadir un segundo suscriptor exige código.
  - **Mayor coste operativo**: 7 contenedores, logs dispersos y sin trazas distribuidas (el gateway solo genera `X-Request-Id`).
  - La red interna es **de confianza**: los servicios creen las cabeceras `X-Usuario`/`X-Rol` del gateway sin volver a validar el JWT.

### ADR-002 — Ledger append-only con cadena de hashes en PostgreSQL (sin blockchain)

- **Estado:** Aceptada
- **Contexto:** E1 exige 0 parcelas huérfanas y detectar el 100 % de las alteraciones durante 5 años (R4). Además, el RGPD obliga a poder borrar los datos personales (Parte 1 §4.1).
- **Decisión:** Una tabla `eventos` insert-only en la base `trazabilidad` con `prev_hash`/`hash` encadenados (SHA-256 sobre JSON canónico). Los privilegios se limitan a `SELECT, INSERT`, un trigger bloquea las mutaciones y hay un endpoint de verificación completa. Las tablas `lotes`, `lote_origen`, `lotes_consumidos` y `replica_veredictos` también son insert-only. Los eventos solo contienen identificadores, nunca PII.
- **Driver:** D1 (E1).
- **Alternativas descartadas:**
  1. **Blockchain (Hyperledger Fabric / Ethereum).** La EUDR no la exige. Añade nodos, consenso y gobernanza entre organizaciones que nadie pidió, con latencia y coste altos. Además, escribir datos de agricultores en una cadena replicada e imborrable **contradice el RGPD**.
  2. **Tabla CRUD + triggers de auditoría (`*_history`).** El dato principal es mutable y la tabla de historial se puede alterar con los mismos privilegios. Deja rastro, pero no da evidencia de integridad.
  3. **Event store dedicado (EventStoreDB).** Queda fuera del stack T1, es una tecnología más que operar y no aporta la cadena de hashes por sí mismo.
  4. **Base de datos ledger gestionada (p. ej. Amazon QLDB).** Hay dependencia de un proveedor (AWS ya anunció el fin de QLDB) y queda fuera del stack T1.
- **Consecuencias positivas:** Cualquier alteración de un evento rompe la cadena desde ese punto y `GET /auditoria/verificacion` la detecta (en la demo se muestra con una manipulación real). Funciona con el stack existente.
- **Consecuencias negativas (lo malo):**
  - **Serialización global de escrituras:** `pg_advisory_xact_lock` impone un techo de rendimiento que no mejora con réplicas.
  - **Un superusuario puede reescribir la cadena entera** y recalcular los hashes. La cadena detecta manipulaciones *parciales*, no una reescritura total, salvo que el hash de cabeza se **ancle fuera** del sistema (pendiente; ver Riesgos).
  - **Correcciones solo con eventos compensatorios.** Un error de carga (p. ej. kg mal escritos) queda para siempre en el historial.
  - La verificación completa es **O(n)** sobre todo el ledger; a 5 años necesitará checkpoints.
  - El JSON canónico debe ser estable entre versiones de Node y del driver `pg`. Un cambio en cómo se serializan los números rompería la verificación sin que haya habido manipulación.

### ADR-003 — Integración asíncrona con la UE: outbox + reintentos + idempotencia + ACL (sin broker)

- **Estado:** Aceptada
- **Contexto:** Sin un número de referencia de DDS el contenedor no sale (R3). El sistema UE puede caer durante horas (E3) y no lo controlamos.
- **Decisión:** `POST /dds` valida el linaje (llamada síncrona a BC3), guarda la DDS ya traducida por el ACL como `PENDIENTE_ENVIO` y responde `202`. Un worker dentro de `dds-service` toma las pendientes con `FOR UPDATE SKIP LOCKED`, envía con `Idempotency-Key` y reintenta con backoff exponencial si hay error 5xx, 429 o timeout. Un 4xx marca la DDS como `RECHAZADA`, sin reintento. La comunicación geo → trazabilidad usa el mismo patrón de outbox.
- **Driver:** D3 (E3).
- **Alternativas descartadas:**
  1. **Llamada síncrona directa a la UE desde la petición del exportador.** Si la UE cae, el exportador recibe un error y debe reintentar a mano: incumple "0 perdidas". Si hay un timeout ambiguo y el usuario reintenta, se arriesga a duplicar.
  2. **Message broker (RabbitMQ / Kafka).** Ofrece entrega garantizada y fan-out, pero es una pieza más que operar, fuera del stack T1, para un volumen estacional bajo (Escalabilidad B,M). Además, el broker por sí solo **no** resuelve la atomicidad con la BD, que igual exigiría un outbox.
  3. **Envío batch nocturno (cron).** Es simple, pero añade hasta 24 h de latencia el día del embarque y no da respuesta temprana de rechazo.
- **Consecuencias positivas:** Ninguna DDS se pierde: queda persistida antes de responder. El envío sobrevive a reinicios del servicio. Los reintentos son seguros mientras la UE respete la idempotencia.
- **Consecuencias negativas (lo malo):**
  - **El exportador no obtiene la referencia al instante.** Debe consultar `GET /dds/:id`; en el esqueleto no hay notificación push.
  - **Latencia de polling** del worker (1 s), más el backoff (hasta 15 s tras la recuperación).
  - **Si la UE no respeta la idempotencia**, un timeout ambiguo produce un duplicado (Riesgo R-1).
  - **Sin cola de mensajes muertos (dead letter queue) ni alertas:** una DDS puede reintentarse indefinidamente sin que nadie se entere. Falta un límite de intentos y una alarma.
  - El worker mantiene una transacción abierta mientras hace llamadas HTTP, lo que retiene conexiones; con más volumen habría que separar *reservar* y *enviar*.
  - `POST /dds` sigue dependiendo **de forma síncrona** de `trazabilidad-service`: si BC3 cae, no se pueden crear DDS nuevas (502), aunque las ya encoladas siguen enviándose.

---

## 4. Riesgos arquitectónicos y cómo descartarlos

### R-1 — El Sistema de Información UE no garantiza la idempotencia que asume T12

- **Por qué es un riesgo:** ADR-003 se apoya en que un reenvío con la misma clave no cree una segunda DDS. Si la API real no acepta una clave del cliente, un *timeout* después de que la UE ya registró la DDS lleva a una DDS duplicada para el mismo embarque, con inconsistencia ante la aduana.
- **Cómo verificarlo (spike):**
  1. Contra el **entorno de aceptación/formación** del Sistema de Información EUDR, enviar una DDS y cortar la conexión del cliente *después* de que se envíe la petición (proxy con retardo, p. ej. *toxiproxy*).
  2. Reenviar la misma DDS: (a) con la misma clave y (b) consultando antes por el *número de referencia interno* que pone el operador.
  3. Repetir 100 veces.
- **Criterio para descartarlo:** 0 duplicados en 100 intentos con timeout forzado. Si falla, se pasa a una estrategia de **"consultar antes de reintentar"** por referencia interna dentro del ACL. Esa estrategia sigue siendo coherente con ADR-003, porque solo cambia el traductor.
- **En el esqueleto:** el mock `eu-is-mock` tiene un modo `LENTO` que registra la DDS y responde después del timeout del cliente. La demo comprueba que el reintento devuelve la misma referencia (`duplicadasEvitadas ≥ 1`, `registradas` +1).

### R-2 — Falsos negativos o veredictos no reproducibles en la validación geoespacial

- **Por qué es un riesgo:** E2 exige 0 falsos negativos y determinismo. Hay fuentes reales de error: el SRID (4326 en grados frente al área geodésica), la precisión en polígonos que solo se tocan por el borde, las diferencias de comportamiento entre versiones de PostGIS/GEOS y los vértices duplicados o mal orientados.
- **Cómo verificarlo:**
  1. Construir un **golden dataset** de al menos 200 polígonos reales con resultado conocido, validado por un experto SIG. Debe incluir casos borde: tangentes, solapamiento < 0,01 %, agujeros, multipolígonos, auto-intersecciones y parcelas de 3,99 / 4,01 ha.
  2. Ejecutarlo en CI contra la **imagen fijada** `postgis/postgis:16-3.4`, 3 veces seguidas.
  3. Antes de subir de versión de PostGIS, ejecutarlo en las dos versiones y comparar los `hashEntrada` y los veredictos.
- **Criterio para descartarlo:** 0 falsos negativos, 100 % de reproducibilidad en 3 ejecuciones y 0 diferencias entre versiones. Si falla, se fija la versión de PostGIS como parte de `reglaVersion`.
- **En el esqueleto:** la demo ejecuta un *golden* mínimo de 5 casos (conforme, deforestación posterior a 2020, auto-intersección, punto > 4 ha y deforestación anterior a 2020) y evalúa una parcela dos veces para comprobar que obtiene el mismo `hashEntrada` y el mismo estado.

---

## 5. Correspondencia diseño ↔ código

| Elemento de diseño | Dónde está en el código |
|---|---|
| ADR-001 servicios por BC | `docker-compose.yml`, `services/*` |
| ADR-001 BD por servicio | `db/init/01-bases-y-usuarios.sql` |
| ADR-002 ledger append-only + hash | `db/init/04-trazabilidad.sql`, `services/trazabilidad-service/src/ledger.js` |
| ADR-003 outbox + reintentos + idempotencia | `services/dds-service/src/worker.js`, `services/geo-service/src/relay.js` |
| T13 ACL | `services/dds-service/src/acl/traductor-ue.js` |
| T6–T8 validación PostGIS fail-closed | `services/geo-service/src/evaluador.js` |
| T14 redes | `docker-compose.yml` (`servicios`, `datos` internal, `externa`) |
| T15 JWT + RBAC | `services/api-gateway/src/index.js` |
