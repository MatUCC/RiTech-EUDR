# RiTech EUDR — Documentación de Arquitectura

## Parte 3: Diagramas C4 (Nivel 1 y Nivel 2)

Los diagramas usan `flowchart` de Mermaid en lugar de la sintaxis experimental `C4Context`. Así se pueden dibujar **leyendas** y distinguir flechas síncronas de asíncronas, cosa que la sintaxis C4 de Mermaid no permite. La notación sigue C4: Persona, Sistema, Contenedor y Base de datos, cada uno con el formato `[Tipo: Tecnología]`.

Versiones ya renderizadas (mermaid-cli 11.4.2): [Nivel 1](img/c4-nivel1-contexto.svg) · [Nivel 2](img/c4-nivel2-contenedores.svg).

---

## Nivel 1 — Diagrama de Contexto

```mermaid
flowchart TB
    agr["<b>Agricultor / Técnico de cooperativa</b><br/>[Persona]<br/>Registra parcelas (GeoJSON) y<br/>recepciones, mezclas y divisiones de lotes"]:::persona
    exp["<b>Exportador</b><br/>[Persona — operador EUDR]<br/>Mezcla lotes de exportación y<br/>emite Declaraciones de Debida Diligencia"]:::persona
    aud["<b>Auditor europeo</b><br/>[Persona — autoridad competente]<br/>Consulta el linaje y verifica<br/>la integridad (solo lectura)"]:::persona

    sys["<b>RiTech EUDR</b><br/>[Sistema de software]<br/>Valida parcelas contra deforestación post-2020,<br/>traza las mezclas de lotes hasta la parcela y<br/>presenta DDS ante la UE"]:::sistema

    euis["<b>Sistema de Información EUDR</b><br/>[Sistema externo — Comisión Europea]<br/>Registra DDS y devuelve<br/>número de referencia"]:::externo
    forest["<b>Mapas de cobertura forestal 2020</b><br/>[Fuente de datos externa]<br/>Capas de deforestación con versión"]:::externo

    agr -->|"Registra parcelas y lotes<br/>[HTTPS/JSON + JWT]"| sys
    exp -->|"Mezcla/divide lotes, emite DDS<br/>[HTTPS/JSON + JWT]"| sys
    aud -->|"Consulta linaje y verificación de cadena<br/>[HTTPS/JSON + JWT, solo GET]"| sys
    sys -.->|"Envía DDS, recibe nº de referencia<br/>[HTTPS/JSON, asíncrono, Idempotency-Key]"| euis
    forest -.->|"Importación de dataset versionado<br/>[ETL por lotes]"| sys

    subgraph leyenda["Leyenda"]
        direction LR
        lp["Persona"]:::persona
        ls["Sistema en alcance"]:::sistema
        le["Sistema / dato externo"]:::externo
        la1[" "]:::vacio -->|"síncrono (petición/respuesta)"| la2[" "]:::vacio
        lb1[" "]:::vacio -.->|"asíncrono / por lotes"| lb2[" "]:::vacio
    end

    classDef persona fill:#08427b,stroke:#052e56,color:#ffffff
    classDef sistema fill:#1168bd,stroke:#0b4884,color:#ffffff
    classDef externo fill:#8a8a8a,stroke:#6b6b6b,color:#ffffff
    classDef vacio fill:transparent,stroke:transparent,color:transparent
```

**Decisiones del Paso 2 visibles en el Nivel 1:**
- La relación con la UE es **asíncrona** (ADR-003, D3).
- El auditor tiene acceso de **solo lectura** (T15).
- Los mapas forestales entran como **dataset con versión**, no como consulta en línea, para que los veredictos sean deterministas (T7, D2).

---

## Nivel 2 — Diagrama de Contenedores

```mermaid
flowchart TB
    agr["<b>Agricultor / Técnico</b><br/>[Persona]"]:::persona
    exp["<b>Exportador</b><br/>[Persona]"]:::persona
    aud["<b>Auditor europeo</b><br/>[Persona]"]:::persona

    subgraph sys["RiTech EUDR [Sistema de software]"]
        direction TB
        gw["<b>api-gateway</b><br/>[Contenedor: Node.js 20 / Express]<br/>Único puerto público (8080).<br/>Emite y valida JWT, aplica RBAC<br/>(AUDITOR = solo GET), oculta /internal<br/><i>BC5 Identidad y Acceso</i>"]:::contenedor

        reg["<b>registro-service</b><br/>[Contenedor: Node.js / Express]<br/>Productores (PII) y parcelas declaradas.<br/>Fail-closed: si geo no responde → PENDIENTE<br/><i>BC1 Registro</i>"]:::contenedor
        geo["<b>geo-service</b><br/>[Contenedor: Node.js / Express]<br/>Valida geometría, regla de 4 ha y<br/>solapamiento con deforestación post-2020.<br/>Veredicto versionado + outbox<br/><i>BC2 Cumplimiento Geoespacial — D2</i>"]:::nucleo
        traza["<b>trazabilidad-service</b><br/>[Contenedor: Node.js / Express]<br/>Recepción, mezcla, división, linaje.<br/>Ledger append-only con cadena de hashes<br/><i>BC3 Trazabilidad — D1</i>"]:::nucleo
        dds["<b>dds-service</b><br/>[Contenedor: Node.js / Express + worker]<br/>Arma la DDS desde el linaje, ACL hacia el esquema UE,<br/>cola de envío con reintentos e idempotencia<br/><i>BC4 Debida Diligencia — D3</i>"]:::contenedor

        subgraph pg["PostgreSQL 16 + PostGIS 3.4 [1 instancia, 4 BD lógicas, red interna 'datos']"]
            direction LR
            dbreg[("<b>registro</b><br/>[BD: PostgreSQL]<br/>CRUD")]:::bd
            dbgeo[("<b>geo</b><br/>[BD: PostGIS]<br/>datasets, veredictos, outbox")]:::bd
            dbtraza[("<b>trazabilidad</b><br/>[BD: PostgreSQL]<br/>solo INSERT/SELECT<br/>eventos con hash")]:::bd
            dbdds[("<b>dds</b><br/>[BD: PostgreSQL]<br/>declaraciones = outbox")]:::bd
        end
    end

    euis["<b>Sistema de Información EUDR</b><br/>[Sistema externo]<br/>En el esqueleto: <i>eu-is-mock</i>,<br/>con modos NORMAL / CAIDO / LENTO"]:::externo
    forest["<b>Mapas de cobertura forestal 2020</b><br/>[Dato externo]<br/>En el esqueleto: semilla SQL<br/>forest-2020-v3"]:::externo

    agr -->|"HTTPS/JSON + JWT"| gw
    exp -->|"HTTPS/JSON + JWT"| gw
    aud -->|"HTTPS/JSON + JWT (solo GET)"| gw

    gw -->|"REST /productores, /parcelas<br/>[X-Usuario, X-Rol]"| reg
    gw -->|"REST /lotes, /auditoria<br/>[X-Usuario, X-Rol]"| traza
    gw -->|"REST /dds<br/>[X-Usuario, X-Rol]"| dds

    reg -->|"POST /evaluaciones<br/>[síncrono, timeout 5 s]"| geo
    geo -.->|"VeredictoEmitido<br/>[outbox + relay HTTP<br/>POST /internal/eventos, cada 1 s]"| traza
    dds -->|"GET /lotes/:id/linaje<br/>[síncrono]"| traza
    dds -.->|"POST /api/v1/dds<br/>[worker: backoff exponencial,<br/>Idempotency-Key, red 'externa']"| euis

    reg -->|"SQL"| dbreg
    geo -->|"SQL + funciones PostGIS"| dbgeo
    traza -->|"SQL: INSERT/SELECT<br/>+ advisory lock"| dbtraza
    dds -->|"SQL: FOR UPDATE SKIP LOCKED"| dbdds
    forest -.->|"Importación versionada<br/>[ETL / semilla]"| dbgeo

    subgraph leyenda["Leyenda"]
        direction LR
        lp["Persona"]:::persona
        lc["Contenedor (soporte / genérico)"]:::contenedor
        ln["Contenedor de dominio núcleo"]:::nucleo
        lbd[("Base de datos")]:::bd
        le["Sistema externo"]:::externo
        la1[" "]:::vacio -->|"síncrono REST/SQL"| la2[" "]:::vacio
        lb1[" "]:::vacio -.->|"asíncrono (outbox / reintentos)"| lb2[" "]:::vacio
    end

    classDef persona fill:#08427b,stroke:#052e56,color:#ffffff
    classDef contenedor fill:#438dd5,stroke:#2e6295,color:#ffffff
    classDef nucleo fill:#1168bd,stroke:#0b4884,color:#ffffff,stroke-width:3px
    classDef bd fill:#2f7d4f,stroke:#1f5535,color:#ffffff
    classDef externo fill:#8a8a8a,stroke:#6b6b6b,color:#ffffff
    classDef vacio fill:transparent,stroke:transparent,color:transparent
```

### Redes Docker (táctica T14; no caben en el diagrama sin saturarlo)

| Red | Miembros | Propósito |
|---|---|---|
| `servicios` | gateway, registro, geo, trazabilidad, dds, demo | Tráfico REST entre servicios |
| `datos` (`internal: true`) | postgres, registro, geo, trazabilidad, dds, demo* | Sin salida al exterior; el gateway **no** está en ella |
| `externa` | dds-service, eu-is-mock, demo* | Solo `dds-service` puede hablar con la "UE" |

\* `demo` está en `datos` solo para **simular un ataque** de manipulación del ledger (ver README).

### Cómo se reflejan las decisiones del Paso 2

| Decisión | Dónde se ve en el Nivel 2 |
|---|---|
| ADR-001 un servicio por BC + BD por servicio | 4 contenedores de dominio, cada uno con su propio cilindro de BD |
| ADR-001 consecuencia negativa: instancia única | Las 4 BD comparten la caja "1 instancia" |
| ADR-002 ledger append-only | `trazabilidad` → "solo INSERT/SELECT + advisory lock" |
| ADR-003 asincronía con la UE | Flecha punteada dds → UE con backoff + Idempotency-Key |
| Consistencia eventual BC2 → BC3 | Flecha punteada "outbox + relay" |
| D2 síncrono para respuesta inmediata | Flecha continua registro → geo |
