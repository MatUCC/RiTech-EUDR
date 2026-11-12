# RiTech EUDR — Preparación para la Sustentación

**Decisión principal:** microservicios de grano grueso, con un servicio y una base de datos lógica por bounded context (ADR-001).

---

### 1. ¿Qué driver justifica la decisión principal y de dónde salió?

**D3, interoperabilidad resiliente con el Sistema de Información UE**, concretado en el escenario **E3**. La medida que decide es: *"las funciones que no dependen de la UE mantienen su disponibilidad; el fallo no se propaga"*.

**De dónde salió:** de la restricción **R3** (EUDR Art. 4 y 33). La DDS tiene que registrarse en un sistema de la Comisión Europea que no controlamos, y sin su número de referencia el contenedor no sale de aduana. En el árbol de utilidad quedó (A,M): importancia alta, porque bloquea el negocio y se suma la sanción R6; riesgo medio, porque se puede aislar.

La separación en procesos es la que convierte ese aislamiento en un **bulkhead físico**. D1 la refuerza: el ledger tiene un único dueño con credenciales de solo `INSERT`/`SELECT`.

*Dónde se ve:* en la demo, sección E3. Con la UE en `CAIDO`, `POST /lotes/recepcion` sigue respondiendo 201.

### 2. ¿Qué alternativa descartamos aquí y por qué?

El **monolito modular**, que era la alternativa más seria. Habría sido más simple, con transacciones locales y sin consistencia eventual.

Se descartó porque, en un solo proceso Node, el cliente de la UE en modo degradado comparte **event loop, memoria y pool de conexiones** con la trazabilidad y el registro. Pasaría horas reintentando, con timeouts, sockets colgados y respuestas inesperadas que el ACL tiene que interpretar. Un fallo no controlado ahí tumba todo el sistema, y eso viola directamente la medida de E3. Además, la propiedad del ledger dependería de la disciplina del equipo, no de credenciales.

Los nanoservicios se descartaron por el extremo contrario: ningún driver pide ese grano, y Escalabilidad es (B,M).

### 3. ¿Qué atributo empeoró con esta decisión y por qué es aceptable?

Empeoraron dos atributos:

1. **Simplicidad operativa:** 7 contenedores, 3 redes, logs dispersos y ninguna transacción distribuida.
2. **Consistencia inmediata:** un veredicto tarda unos 1–2 s en llegar de BC2 a BC3, y la demo muestra las respuestas 409 durante esa ventana.

**Por qué es aceptable:**
- La ventana de inconsistencia es **fail-closed**. Mientras una parcela no tiene veredicto replicado, *no puede entrar en ningún lote*, así que la inconsistencia nunca produce un falso CONFORME. Es decir, no degrada D1 ni D2, que son los drivers de mayor prioridad.
- La complejidad se limitó con grano grueso (4 servicios, uno por BC) y con un único `docker compose up`.
- Los atributos que más sufren con la red, Rendimiento (M,M) y Escalabilidad (B,M), **no son drivers**.

### 4. Si el negocio creciera 10 veces, ¿qué parte se rompería primero?

**El lock global de la cadena de hashes en `trazabilidad-service`** (`pg_advisory_xact_lock(4242)` en `ledger.js`).

**Por qué es lo primero que se rompe:**
- Cada recepción, mezcla y división de **todo el sistema** se serializa detrás de ese lock.
- Además, dentro del lock se ejecuta la verificación de ancestros (`WITH RECURSIVE`), que se encarece a medida que crecen la profundidad y el ancho del grafo de mezclas.
- Si cada transacción retiene el lock unos 10 ms, el techo ronda las 100 escrituras por segundo **para todo el sistema**.
- Ese techo **no sube con réplicas**: es el único componente que no escala horizontalmente. geo, registro y dds son *stateless* y se escalan añadiendo instancias.
- En temporada de cosecha (×5, multiplicado por ×10 de crecimiento = ×50) se forma cola y aparecen timeouts en el gateway (15 s).

**Lo siguiente en romperse:** la **instancia única de PostgreSQL**, compartida por las 4 bases. Con 4 pools de 10 conexiones más las réplicas añadidas, se agota `max_connections`, y además es un único dominio de fallo.

**Cómo se verifica antes de que ocurra:** con una prueba de carga (p. ej. k6) a ×50 del pico de cosecha, midiendo el p95 de `POST /lotes/*` y el tiempo de espera del lock en `pg_stat_activity`.

**Salida evolutiva, sin cambiar de estilo:**
- **Cadenas de hash por cooperativa o partición**, con un *Merkle root* periódico que las une y que también sirve para anclar el hash fuera del sistema (la consecuencia negativa pendiente de ADR-002).
- Después, **instancias de PostgreSQL separadas** por servicio. ADR-001 ya lo permite, porque ninguna base comparte tablas con otra.
