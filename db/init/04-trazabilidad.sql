-- BC3 Trazabilidad de Lotes — ADR-002: ledger append-only.
-- Las tablas pertenecen a 'postgres'. El servicio 'trazabilidad' solo recibe SELECT e INSERT (T1).
-- Además, un trigger bloquea UPDATE/DELETE/TRUNCATE (defensa en profundidad).
\connect trazabilidad

-- Copia local de los veredictos publicados por BC2 (Published Language).
CREATE TABLE replica_veredictos (
  evento_id        uuid PRIMARY KEY,
  parcela_id       uuid NOT NULL,
  estado           text NOT NULL,
  dataset_version  text NOT NULL,
  regla_version    text NOT NULL,
  geometria        jsonb,
  emitido_at       timestamptz NOT NULL,
  recibido_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX replica_veredictos_parcela_idx ON replica_veredictos (parcela_id, emitido_at DESC);

CREATE TABLE lotes (
  id                   uuid PRIMARY KEY,
  tipo                 text NOT NULL CHECK (tipo IN ('RECEPCION','MEZCLA','DIVISION')),
  producto             text NOT NULL CHECK (producto IN ('CAFE','CACAO')),
  kg                   numeric NOT NULL CHECK (kg > 0),
  parcela_id           uuid,                                     -- solo en RECEPCION
  veredicto_evento_id  uuid REFERENCES replica_veredictos(evento_id), -- T3: snapshot del veredicto
  creado_por           text NOT NULL,
  creado_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((tipo = 'RECEPCION') = (parcela_id IS NOT NULL))
);

-- Aristas del grafo de linaje: lote_id se formó a partir de origen_lote_id.
CREATE TABLE lote_origen (
  lote_id         uuid NOT NULL REFERENCES lotes(id),
  origen_lote_id  uuid NOT NULL REFERENCES lotes(id),
  kg_aportados    numeric NOT NULL CHECK (kg_aportados > 0),
  PRIMARY KEY (lote_id, origen_lote_id)
);
CREATE INDEX lote_origen_hijo_idx ON lote_origen (lote_id);

-- Un lote se consume UNA sola vez (en una mezcla o una división). La PK lo garantiza.
CREATE TABLE lotes_consumidos (
  lote_id          uuid PRIMARY KEY REFERENCES lotes(id),
  operacion        text NOT NULL,
  consumido_at     timestamptz NOT NULL DEFAULT now()
);

-- T2: eventos con cadena de hashes.
CREATE TABLE eventos (
  seq          bigserial PRIMARY KEY,
  evento_id    uuid NOT NULL UNIQUE,
  tipo         text NOT NULL,
  lote_id      uuid NOT NULL,
  payload      jsonb NOT NULL,
  prev_hash    char(64) NOT NULL,
  hash         char(64) NOT NULL UNIQUE,
  registrado_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eventos_lote_idx ON eventos (lote_id);

CREATE FUNCTION prohibir_mutacion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger append-only: % prohibido sobre %', TG_OP, TG_TABLE_NAME;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['replica_veredictos','lotes','lote_origen','lotes_consumidos','eventos'] LOOP
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prohibir_mutacion()', t, t);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prohibir_mutacion()', t, t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO trazabilidad;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO trazabilidad;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO trazabilidad;
