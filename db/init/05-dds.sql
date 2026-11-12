-- BC4 Debida Diligencia y Pasarela UE — ADR-003.
-- La tabla 'declaraciones' es a la vez el agregado y la bandeja de salida (outbox).
\connect dds
SET ROLE dds;

CREATE TABLE declaraciones (
  id                   uuid PRIMARY KEY,        -- también es la Idempotency-Key (T12)
  lote_id              uuid NOT NULL,
  operador             text NOT NULL,
  estado               text NOT NULL CHECK (estado IN ('PENDIENTE_ENVIO','REGISTRADA','RECHAZADA')),
  contenido_ue         jsonb NOT NULL,          -- ya traducido por el ACL (T13)
  numero_referencia    text,
  numero_verificacion  text,
  intentos             int NOT NULL DEFAULT 0,
  proximo_intento_at   timestamptz NOT NULL DEFAULT now(),
  ultimo_error         text,
  creado_at            timestamptz NOT NULL DEFAULT now(),
  registrada_at        timestamptz
);
CREATE INDEX declaraciones_cola_idx ON declaraciones (proximo_intento_at) WHERE estado = 'PENDIENTE_ENVIO';

RESET ROLE;
