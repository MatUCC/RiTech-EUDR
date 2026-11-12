-- BC1 Registro de Productores y Parcelas. CRUD normal: aquí sí se permite UPDATE.
-- T4: la PII (nombre, documento) vive SOLO aquí; el ledger de BC3 solo guarda IDs.
\connect registro
SET ROLE registro;

CREATE TABLE productores (
  id          uuid PRIMARY KEY,
  nombre      text NOT NULL,
  documento   text NOT NULL,
  cooperativa text,
  creado_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parcelas (
  id                 uuid PRIMARY KEY,
  productor_id       uuid NOT NULL REFERENCES productores(id),
  nombre             text NOT NULL,
  geometria          jsonb NOT NULL,              -- GeoJSON tal como lo declara el agricultor
  area_declarada_ha  numeric,
  estado_validacion  text NOT NULL DEFAULT 'PENDIENTE'
                     CHECK (estado_validacion IN ('PENDIENTE','CONFORME','NO_CONFORME','INVALIDA')),
  ultimo_veredicto   jsonb,
  creado_at          timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;
