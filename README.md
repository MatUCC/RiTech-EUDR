# RiTech EUDR — Walking Skeleton

Cumplimiento y trazabilidad EUDR para exportaciones de café y cacao. **Microservicios de grano grueso**: un servicio por bounded context, con una base de datos lógica por servicio (ADR-001).

| Documento | Contenido |
|---|---|
| [docs/01-drivers-escenarios-contextos.md](docs/01-drivers-escenarios-contextos.md) | Árbol de utilidad, drivers D1–D3, escenarios E1–E3, bounded contexts |
| [docs/02-estilo-tacticas-adrs.md](docs/02-estilo-tacticas-adrs.md) | Estilo, tácticas T1–T15, ADR-001 a 003, riesgos R-1 y R-2, correspondencia diseño ↔ código |
| [docs/03-diagramas-c4.md](docs/03-diagramas-c4.md) | C4 Nivel 1 y Nivel 2 (Mermaid) |
| [docs/05-sustentacion.md](docs/05-sustentacion.md) | Respuestas para la sustentación |

## Arranque (un solo comando)

Requisito: Docker Desktop (o Docker Engine con Compose v2).

```bash
docker compose up --build
```

`docker-compose up --build` (Compose v1) también funciona. El primer arranque descarga las imágenes `postgis/postgis:16-3.4` y `node:20-alpine` e instala las dependencias.

### En este equipo (Windows 10 LTSC 2021, sin Docker Desktop)

Docker Desktop exige la build 19045 o superior y LTSC 2021 se queda en 19044. Por eso Docker Engine está instalado **dentro de Ubuntu en WSL 2**. Desde PowerShell, el mismo comando se ejecuta así:

```bash
wsl -d Ubuntu -u root --cd /mnt/c/Users/Usuario/Desktop/Ritech -- docker compose up --build
```

Los puertos se ven desde Windows igual que siempre: `http://localhost:8080` y `http://localhost:8090`.

Verificado el 2026-11-11 con Docker Engine 29.9.3 y Compose v5.7.1: los 8 contenedores arrancan sanos y la demo termina con «todas las comprobaciones pasaron».

Cuando todo está sano, el contenedor **`demo`** recorre los escenarios automáticamente y termina con:

```
RESULTADO: todas las comprobaciones pasaron
```

El resto del sistema sigue activo. Para ver solo la demo, o repetirla:

```bash
docker compose logs demo
```

```bash
docker compose run --rm demo
```

Para reiniciar desde cero (borra la BD):

```bash
docker compose down -v
```

## Qué demuestra la demo

| Escenario | Qué se ve | Contenedores implicados |
|---|---|---|
| **E2 / D2** | 5 parcelas: limpia → CONFORME; ~4 % sobre deforestación 2022 → NO_CONFORME; auto-intersección → INVALIDA; punto de 6 ha → INVALIDA; deforestación 2019 (anterior al corte) → CONFORME. Re-evaluar da el mismo `hashEntrada`. | gateway → registro → **geo (PostGIS)** |
| **E1 / D1** | Consistencia eventual (409 hasta que llega el veredicto). Cosecha de una parcela NO_CONFORME bloqueada (422). Mezcla → división → mezcla (3 niveles). Reutilizar un lote consumido da 409. El auditor obtiene el linaje hasta 2 parcelas y no puede escribir (403). | geo ⇢ outbox ⇢ **trazabilidad** |
| **E1 / ADR-002** | Ataque 1: el usuario del servicio intenta `UPDATE` → *permission denied*. Ataque 2: un superusuario desactiva los triggers y altera kg → `/auditoria/verificacion` señala el evento exacto. | trazabilidad + PostgreSQL |
| **E3 / D3** | UE en modo `CAIDO`: 3 DDS aceptadas (202) y la trazabilidad sigue operando. Al recuperarse la UE, las 3 quedan REGISTRADAS, sin pérdidas ni duplicados. | **dds** ⇢ eu-is-mock |
| **R-1** | UE en modo `LENTO` (registra pero responde tarde): el reintento con la misma `Idempotency-Key` no duplica. | dds ⇢ eu-is-mock |

## Topología

```
             :8080                         red "servicios"
 cliente ──► api-gateway ──► registro-service ──► geo-service ⇢(outbox)⇢ trazabilidad-service
             (JWT, RBAC)     ──► trazabilidad-service ◄── dds-service
                             ──► dds-service ⇢(red "externa", reintentos)⇢ eu-is-mock :8090
                                                         red "datos" (internal)
 registro-service, geo-service, trazabilidad-service, dds-service ──► postgres (4 BD lógicas)
```

## Probar a mano

```bash
TOKEN=$(curl -s -X POST localhost:8080/auth/token -H 'Content-Type: application/json' -d '{"usuario":"aud","rol":"AUDITOR"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
```

```bash
curl -s localhost:8080/api/trazabilidad/auditoria/verificacion -H "Authorization: Bearer $TOKEN"
```

```bash
curl -s -X POST localhost:8090/_control/modo -H 'Content-Type: application/json' -d '{"modo":"CAIDO"}'
```

| Método y ruta (vía gateway) | Rol de escritura |
|---|---|
| `POST /api/registro/productores`, `POST /api/registro/parcelas`, `POST /api/registro/parcelas/:id/reevaluar` | AGRICULTOR |
| `POST /api/trazabilidad/lotes/recepcion`, `/lotes/mezcla`, `/lotes/:id/division` | AGRICULTOR, EXPORTADOR |
| `GET /api/trazabilidad/lotes/:id/linaje`, `GET /api/trazabilidad/auditoria/verificacion` | lectura: todos |
| `POST /api/dds/dds`, `GET /api/dds/dds/:id` | EXPORTADOR |

## Estructura

```
docker-compose.yml          7 contenedores, 3 redes (T14)
db/init/                    una BD + un usuario por servicio; ledger con solo INSERT/SELECT
services/
  api-gateway/              BC5: JWT, RBAC, proxy
  registro-service/         BC1: productores (PII) y parcelas
  geo-service/              BC2: evaluador PostGIS + relay del outbox
  trazabilidad-service/     BC3: lotes, linaje, ledger con cadena de hashes
  dds-service/              BC4: ACL hacia la UE + worker con reintentos e idempotencia
  eu-is-mock/               sistema externo simulado (NORMAL | CAIDO | LENTO)
demo/                       recorrido automático de los escenarios
```

## Fuera del alcance del esqueleto (a propósito)

- No hay interfaz gráfica: la "aplicación web" se demuestra con su API.
- La transformación de producto (cereza → pergamino → verde) no está implementada.
- No hay IdP real: el gateway emite tokens de demostración.
- El hash de cabeza del ledger no se ancla externamente (consecuencia negativa de ADR-002).
- No hay cola de mensajes muertos (dead letter queue) ni alertas en el worker de la UE (consecuencia negativa de ADR-003).
- Los esquemas se crean con scripts `docker-entrypoint-initdb.d`, que solo se ejecutan con un volumen vacío. Cambiarlos exige `docker compose down -v`.
- Las credenciales están en claro en `docker-compose.yml`. Solo sirven para demostración.
