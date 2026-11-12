# RiTech EUDR — Documentación de Arquitectura

## Parte 1: Drivers, Escenarios y Bounded Contexts

---

## 0. Entradas del diseño (de dónde salen los drivers)

Los drivers no son una opinión: salen de restricciones verificables.

| ID | Restricción | Origen | Implicación arquitectónica |
|----|-------------|--------|----------------------------|
| R1 | Geolocalización de **todas** las parcelas de origen. Parcelas > 4 ha → **polígono**; ≤ 4 ha → se admite un punto. | EUDR (Reg. UE 2023/1115), Art. 2 y 9 | Validación geoespacial estricta, no opcional |
| R2 | Fecha de corte **31-12-2020**: sin deforestación posterior en la parcela. | EUDR Art. 2 y 3 | Cruce de polígonos con mapas de cobertura forestal |
| R3 | Declaración de Debida Diligencia (DDS) registrada en el **Sistema de Información de la UE** antes de exportar; devuelve un número de referencia. | EUDR Art. 4 y 33 | Integración con un sistema externo que no controlamos |
| R4 | Conservar la información **5 años** y entregarla a la autoridad competente. | EUDR Art. 12 | Registros históricos íntegros y consultables |
| R5 | No se puede mezclar con producto de origen desconocido: un lote mezclado debe listar **todas** sus parcelas de origen. | EUDR Art. 9 (trazabilidad hasta la parcela) | Linaje completo de mezclas en cooperativas |
| R6 | Sanciones de hasta al menos el **4 % de la facturación anual en la UE** del operador. | EUDR Art. 25 | El coste de un error es existencial para el cliente |
| T1 | Node.js, Express, PostgreSQL, Docker Compose. | Restricción técnica del proyecto | Acota las opciones de los Pasos 2 y 4 |

**Usuarios:** Agricultor / Técnico de cooperativa · Exportador (operador EUDR) · Auditor europeo (autoridad competente).

---

## 1. Árbol de Utilidad

**Escala:** `(Importancia para el negocio, Riesgo técnico)` con A = Alta, M = Media, B = Baja.
**Regla de selección:** solo pasan a driver las hojas `(A,A)`, o `(A,M)` cuando dependen de una restricción externa que no controlamos. Una hoja `(A,B)` es importante, pero no condiciona la arquitectura porque ya existe una solución estándar.

```
Utilidad — RiTech EUDR
│
├── Auditabilidad (integridad de la trazabilidad)
│   ├── Reconstruir el linaje completo de un lote mezclado hasta sus parcelas ... (A,A) ★ D1 → E1
│   └── Demostrar que un registro histórico no se alteró ........................ (A,A)   (dentro de E1)
│
├── Corrección funcional (validación geoespacial)
│   ├── Detectar solapamiento con deforestación posterior a 2020 ............... (A,A) ★ D2 → E2
│   └── Rechazar geometrías inválidas (auto-intersección, polígono abierto) .... (A,M)   (dentro de E2)
│
├── Interoperabilidad (Sistema de Información UE)
│   ├── Enviar la DDS aunque el sistema UE esté caído, sin pérdidas ni duplicados (A,M) ★ D3 → E3
│   └── Adaptarse a una nueva versión del esquema o la API de la UE ............ (M,M)
│
├── Modificabilidad
│   └── Cambiar una regla regulatoria (p. ej. riesgo por país) en < 1 día ...... (M,M)
│
├── Seguridad
│   └── Auditor solo lectura; agricultor solo ve sus parcelas .................. (A,B)
│
├── Rendimiento
│   └── Validar una carga masiva de 2.000 parcelas en < 30 min ................. (M,M)
│
├── Escalabilidad
│   └── Absorber un pico de cosecha de ×5 registros ............................ (B,M)
│
├── Disponibilidad
│   └── UI disponible al 99,5 % en horario laboral ............................. (M,B)
│
└── Usabilidad
    └── Un agricultor registra una parcela en < 5 min .......................... (M,B)
```

### Drivers priorizados

| # | Driver | (I,R) | Por qué este orden |
|---|--------|-------|--------------------|
| **D1** | **Auditabilidad / integridad de la trazabilidad** | (A,A) | Lo que se vende es **evidencia**. Un veredicto correcto que no se puede demostrar ante el auditor no vale nada (R4, R5, R6). El riesgo es alto porque las mezclas de lotes forman un grafo de varios niveles que debe ser completo e inalterable durante 5 años. |
| **D2** | **Corrección de la validación geoespacial** | (A,A) | Un falso negativo, es decir una parcela deforestada aprobada, contamina todos los lotes que la contienen y expone al exportador a la sanción (R1, R2, R6). El riesgo es alto porque requiere geometría computacional, datasets forestales con versiones y resultados que se puedan reproducir. |
| **D3** | **Interoperabilidad resiliente con el sistema UE** | (A,M) | Sin número de referencia de la DDS el contenedor no sale de aduana (R3). Es una dependencia externa fuera de nuestro control. El riesgo es medio, no alto, porque se puede aislar detrás de un adaptador. Aun así es driver, porque si falla bloquea el negocio. |

### Lo que conscientemente **no** es driver

- **Seguridad (A,B):** importa mucho, pero se resuelve con tácticas estándar (RBAC, JWT, TLS) y no da forma a la estructura. Se aplicará igual, solo que no gobierna las decisiones.
- **Modificabilidad (M,M):** las reglas cambian, pero a un ritmo de meses, no de días. Se atiende de forma indirecta al aislar los contextos (ver §3).
- **Escalabilidad (B,M):** el volumen es estacional y moderado: miles de parcelas por cooperativa, no millones de transacciones por segundo. Optimizar para esto ahora sería diseño especulativo.

---

## 2. Escenarios Arquitectónicos

### E1 — Auditabilidad (D1): trazabilidad de un lote mezclado

| Elemento | Descripción |
|----------|-------------|
| **Fuente** | Auditor europeo (autoridad competente de un Estado miembro). |
| **Estímulo** | Pide la trazabilidad completa del lote de exportación `EXP-2026-0412` (un contenedor de café). Ese lote es el resultado de **3 niveles de mezcla** en la cooperativa: 40 lotes intermedios que provienen de 120 parcelas. |
| **Artefacto** | Contexto de Trazabilidad de Lotes y su registro de eventos. |
| **Entorno** | Operación normal, **4 años y 11 meses** después del embarque. Varias parcelas cambiaron de titular o de estado desde entonces. |
| **Respuesta** | El sistema devuelve el árbol de linaje del lote hasta **todas** sus parcelas de origen. Incluye la geolocalización y el veredicto de deforestación **vigente en la fecha de la mezcla**, no el actual. Adjunta además una prueba de integridad (cadena de hashes) que el auditor puede verificar por su cuenta. |
| **Medida** | • 100 % de las parcelas de origen recuperadas (0 huérfanas).<br>• Respuesta en ≤ 5 s para grafos de hasta 500 nodos.<br>• 100 % de las alteraciones de eventos históricos se detectan al verificar la cadena. |

### E2 — Corrección geoespacial (D2): parcela con deforestación posterior al corte

| Elemento | Descripción |
|----------|-------------|
| **Fuente** | Técnico de cooperativa que registra una parcela en nombre de un agricultor. |
| **Estímulo** | Registra un polígono de **6,2 ha** que se solapa en un **3 %** con un área deforestada en 2022. Otra variante: envía un polígono auto-intersectado, o un punto para una parcela de más de 4 ha. |
| **Artefacto** | Contexto de Cumplimiento Geoespacial. |
| **Entorno** | Operación normal, en plena temporada de cosecha, con el dataset forestal versión `forest-2020-v3` activo. |
| **Respuesta** | El sistema marca la parcela como **NO_CONFORME** y explica el motivo: tipo de violación, área solapada en m² y versión del dataset. La parcela queda **bloqueada para participar en cualquier lote**. Una geometría inválida se rechaza antes de evaluarse. |
| **Medida** | • **0 falsos negativos** sobre el *golden dataset* de referencia (conjunto de polígonos con resultado conocido).<br>• Resultado **determinista**: misma geometría + misma versión de dataset + misma versión de regla = mismo veredicto, siempre.<br>• ≤ 3 s por polígono de hasta 1.000 vértices.<br>• 100 % de los veredictos guardan la versión del dataset y la de la regla aplicada. |

### E3 — Interoperabilidad (D3): el sistema de la UE no está disponible

| Elemento | Descripción |
|----------|-------------|
| **Fuente** | Sistema de Información EUDR de la UE (sistema externo). |
| **Estímulo** | Responde con timeouts o errores 5xx durante **6 horas**. En ese tiempo, un exportador envía **50 DDS** que necesita para un embarque de mañana. |
| **Artefacto** | Contexto de Debida Diligencia y su pasarela hacia la UE. |
| **Entorno** | Degradado: la dependencia externa está caída y el resto del sistema funciona. |
| **Respuesta** | El sistema acepta las 50 declaraciones, las guarda como `PENDIENTE_ENVIO` y avisa al exportador de que el envío está diferido. Reintenta con *backoff* exponencial usando una clave de idempotencia por DDS. Cuando la UE se recupera, envía las DDS y guarda los números de referencia. El registro de parcelas y la trazabilidad siguen operando con normalidad. |
| **Medida** | • **0 DDS perdidas** y **0 duplicadas** en el sistema UE.<br>• 100 % enviadas en ≤ 15 min tras la recuperación.<br>• Las funciones que no dependen de la UE mantienen su disponibilidad: el fallo no se propaga. |

---

## 3. Bounded Contexts

### Tipos de señal usados para trazar fronteras

- **[L] Lingüística:** la misma palabra significa cosas distintas.
- **[C] Ritmo de cambio:** cambia por razones distintas o a velocidades distintas.
- **[I] Invariante propio:** tiene una regla de consistencia que solo tiene sentido dentro de esa frontera.
- **[X] Modelo externo impuesto:** el modelo lo dicta un tercero.
- **[A] Actor distinto:** otro usuario y otra forma de trabajar.

### Contextos

#### BC1 — Registro de Productores y Parcelas · *Soporte*
- **Responsabilidad:** alta de productores y cooperativas, titularidad de parcelas y captura de la geometría tal como la declara el agricultor.
- **Lenguaje:** *Productor, Cooperativa, Parcela (= activo con dueño), Titularidad*.
- **Señal:** **[L]** aquí "Parcela" es un activo administrativo con dueño. **[C]** cambia por razones administrativas (cambio de titular, de cooperativa), no regulatorias. **[A]** lo opera el agricultor o técnico.
- **Datos propios:** datos personales del productor y geometría *declarada*.

#### BC2 — Cumplimiento Geoespacial · *Núcleo* · sostiene **D2**
- **Responsabilidad:** validar la geometría (cierre, auto-intersección, regla de 4 ha), cruzarla con los mapas de cobertura forestal de 2020 y emitir un **Veredicto** reproducible.
- **Lenguaje:** *Geometría evaluada, Dataset forestal (versionado), Solapamiento, Veredicto {CONFORME, NO_CONFORME, INVALIDA}, Versión de regla*.
- **Señal:** **[L]** aquí "Parcela" es una geometría bajo evaluación y no importa quién es el dueño. **[C]** depende de datasets externos que se actualizan a su propio ritmo. **[I]** el veredicto debe ser determinista y reproducible (geometría + versión de dataset + versión de regla). Ningún otro contexto tiene esta invariante.
- **Datos propios:** veredictos, versiones de datasets y de reglas.

#### BC3 — Trazabilidad de Lotes · *Núcleo* · sostiene **D1**
- **Responsabilidad:** recepción de cosecha por parcela, **mezcla** (N lotes → 1), **división** (1 → N) y el grafo de linaje hasta las parcelas. La transformación (cereza → pergamino → verde) queda fuera del esqueleto; sería un nuevo tipo de evento sobre el mismo grafo.
- **Lenguaje:** *Lote, Mezcla, División, Linaje, Parcela de origen (= solo referencia + veredicto en la fecha)*.
- **Señal:** **[L]** "Lote" no existe en ningún otro contexto con este significado. **[I]** un lote solo es conforme si **todos** sus ancestros lo son, y no se puede mezclar un lote con una parcela no conforme o desconocida (R5). **[I]** el historial es *append-only*: nunca se reescribe.
- **Datos propios:** eventos de lote (inmutables) y grafo de linaje.

#### BC4 — Debida Diligencia y Pasarela UE · *Soporte (restricción externa)* · sostiene **D3**
- **Responsabilidad:** armar la DDS a partir del linaje de un lote de exportación, enviarla al Sistema de Información UE y gestionar su ciclo de vida (`PENDIENTE_ENVIO` → `REGISTRADA` | `RECHAZADA`).
- **Lenguaje:** *Declaración (DDS), Operador, Número de referencia, Estado de envío*.
- **Señal:** **[X]** el esquema de la DDS lo impone la Comisión Europea y cambia cuando ella decide. Necesita una **capa anticorrupción** para que ese modelo no contamine BC1 a BC3. **[A]** lo opera el exportador. **[C]** su disponibilidad depende de un tercero.
- **Datos propios:** DDS, cola de envíos y números de referencia.

#### BC5 — Identidad y Acceso · *Genérico*
- **Responsabilidad:** autenticación y roles (AGRICULTOR, EXPORTADOR, AUDITOR).
- **Señal:** **[C]** problema resuelto y sin relación con el dominio. Se compra o se usa una solución estándar, sin construir nada a medida.

### Decisión explícita: "Auditoría" **no** es un Bounded Context

El auditor es un **actor** [A], pero no aporta un modelo ni invariantes propios. Consulta el linaje (BC3) y las DDS (BC4) en modo solo lectura. Crear un BC "Auditoría" obligaría a duplicar el modelo de linaje, y con ello aparecería el riesgo de que las dos copias diverjan, lo que va directamente contra **D1**. El auditor se atiende como un **rol de solo lectura** sobre el lenguaje publicado de BC3 y BC4.

### Mapa de contextos (relaciones)

| Upstream → Downstream | Patrón | Qué fluye |
|-----------------------|--------|-----------|
| BC1 Registro → BC2 Geoespacial | Customer / Supplier (síncrono, porque E2 exige respuesta inmediata) | `POST /evaluaciones {parcelaId, geometria, areaDeclaradaHa}` |
| BC2 Geoespacial → BC3 Trazabilidad | Published Language (BC3 se adapta al modelo de BC2), asíncrono vía outbox | `VeredictoEmitido {eventoId, parcelaId, estado, datasetVersion, reglaVersion, geometria, emitidoAt}`. BC3 **nunca recalcula** veredictos. |
| BC3 Trazabilidad → BC4 Debida Diligencia | Customer / Supplier (síncrono) | `GET /lotes/:id/linaje`: parcelas, geolocalización y veredictos |
| BC4 → Sistema de Información UE (externo) | **Anticorruption Layer** | DDS traducida al esquema de la UE y número de referencia de vuelta |
| BC2 → Datasets forestales (externos) | **Anticorruption Layer** | Capas de cobertura forestal 2020, con versión |
| BC5 Identidad → todos | Open Host Service | Token con rol |

---

## 4. Tensiones detectadas (entrada para el Paso 2)

Se dejan escritas aquí para que el Paso 2 las resuelva con decisiones explícitas:

1. **D1 (historial inmutable) frente al RGPD (derecho de supresión de datos personales del agricultor).** Para no tener que borrar historial habrá que separar los datos personales (BC1) de los eventos inmutables (BC3), que solo guardan IDs.
2. **D2 (precisión) frente a rendimiento.** Geometrías complejas contra capas forestales grandes son operaciones costosas. La precisión no se negocia, así que se sacrificará latencia.
3. **D3 (envío asíncrono y resiliente) frente a la expectativa del exportador de obtener el número de referencia al instante.** Habrá que sacrificar inmediatez y aceptar consistencia eventual en ese flujo.
