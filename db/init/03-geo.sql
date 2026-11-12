-- BC2 Cumplimiento Geoespacial. T6: PostGIS como motor de validación.
\connect geo
CREATE EXTENSION IF NOT EXISTS postgis;
SET ROLE geo;

-- T7: datasets con versión; solo uno está activo a la vez.
CREATE TABLE datasets_forestales (
  version      text PRIMARY KEY,
  descripcion  text NOT NULL,
  fecha_corte  date NOT NULL,                     -- EUDR: 2020-12-31
  activo       boolean NOT NULL DEFAULT false,
  cargado_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX un_solo_dataset_activo ON datasets_forestales (activo) WHERE activo;

CREATE TABLE areas_deforestadas (
  id               serial PRIMARY KEY,
  dataset_version  text NOT NULL REFERENCES datasets_forestales(version),
  fecha_deteccion  date NOT NULL,
  geom             geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX areas_deforestadas_gix ON areas_deforestadas USING gist (geom);

CREATE TABLE veredictos (
  id                uuid PRIMARY KEY,
  parcela_id        uuid NOT NULL,
  estado            text NOT NULL CHECK (estado IN ('CONFORME','NO_CONFORME','INVALIDA')),
  motivo            text,
  area_ha           numeric,
  area_solapada_m2  numeric,
  dataset_version   text NOT NULL,
  regla_version     text NOT NULL,
  hash_entrada      text NOT NULL,
  geometria         jsonb,
  emitido_at        timestamptz NOT NULL
);
CREATE INDEX veredictos_parcela_idx ON veredictos (parcela_id, emitido_at DESC);

-- Outbox (ADR-003): los eventos se publican hacia BC3 con un relay.
CREATE TABLE outbox (
  id          uuid PRIMARY KEY,
  tipo        text NOT NULL,
  payload     jsonb NOT NULL,
  creado_at   timestamptz NOT NULL DEFAULT now(),
  enviado_at  timestamptz,
  intentos    int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pendientes_idx ON outbox (creado_at) WHERE enviado_at IS NULL;

-- Semilla: sustituye la importación ETL de mapas forestales (zona ficticia del Huila, Colombia).
INSERT INTO datasets_forestales (version, descripcion, fecha_corte, activo)
VALUES ('forest-2020-v3', 'Semilla de demostración: áreas deforestadas detectadas', DATE '2020-12-31', true);

INSERT INTO areas_deforestadas (dataset_version, fecha_deteccion, geom) VALUES
  -- Deforestación POSTERIOR al corte (2022): invalida las parcelas que la tocan.
  ('forest-2020-v3', DATE '2022-03-15',
   ST_Multi(ST_GeomFromText('POLYGON((-75.6000 2.2000, -75.5900 2.2000, -75.5900 2.2100, -75.6000 2.2100, -75.6000 2.2000))', 4326))),
  -- Deforestación ANTERIOR al corte (2019): la EUDR no la penaliza.
  ('forest-2020-v3', DATE '2019-06-01',
   ST_Multi(ST_GeomFromText('POLYGON((-75.5500 2.2000, -75.5400 2.2000, -75.5400 2.2100, -75.5500 2.2100, -75.5500 2.2000))', 4326)));

RESET ROLE;
