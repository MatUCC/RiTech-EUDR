/**
 * ADR-003 — Worker de envío a la UE.
 * T10: la tabla 'declaraciones' es la outbox (estado PENDIENTE_ENVIO).
 * T11: backoff exponencial con jitter, timeout por llamada.
 * T12: Idempotency-Key = id de la DDS.
 * Error 5xx/429/timeout/red → reintento. Otro 4xx → RECHAZADA (no tiene sentido reintentar).
 */
const { pool } = require('./db');
const { desdeRespuestaUE } = require('./acl/traductor-ue');

const EU_URL = process.env.EU_IS_URL;
const TIMEOUT_MS = Number(process.env.EU_TIMEOUT_MS || 5000);
const BASE_MS = Number(process.env.BACKOFF_BASE_MS || 1000);
const MAX_MS = Number(process.env.BACKOFF_MAX_MS || 15000);

let enCurso = false;

const espera = (intentos) => Math.min(BASE_MS * 2 ** (intentos - 1), MAX_MS) + Math.floor(Math.random() * 250);

async function enviar(c, d) {
  let error;
  try {
    const r = await fetch(`${EU_URL}/api/v1/dds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': d.id },
      body: JSON.stringify(d.contenido_ue),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.ok) {
      const { numeroReferencia, numeroVerificacion } = desdeRespuestaUE(await r.json());
      await c.query(
        `UPDATE declaraciones SET estado = 'REGISTRADA', numero_referencia = $2, numero_verificacion = $3,
                intentos = intentos + 1, ultimo_error = NULL, registrada_at = now() WHERE id = $1`,
        [d.id, numeroReferencia, numeroVerificacion],
      );
      console.log(`[dds-service] DDS ${d.id} REGISTRADA en la UE: ${numeroReferencia} (intento ${d.intentos + 1})`);
      return;
    }
    const texto = (await r.text()).slice(0, 300);
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      await c.query(`UPDATE declaraciones SET estado = 'RECHAZADA', intentos = intentos + 1, ultimo_error = $2 WHERE id = $1`,
        [d.id, `HTTP ${r.status}: ${texto}`]);
      console.warn(`[dds-service] DDS ${d.id} RECHAZADA por la UE: HTTP ${r.status}`);
      return;
    }
    error = `HTTP ${r.status}`;
  } catch (e) {
    error = e.name === 'TimeoutError' ? `timeout ${TIMEOUT_MS} ms` : e.message;
  }
  const intentos = d.intentos + 1;
  const ms = espera(intentos);
  await c.query(
    `UPDATE declaraciones SET intentos = $2, ultimo_error = $3,
            proximo_intento_at = now() + make_interval(secs => $4::double precision / 1000) WHERE id = $1`,
    [d.id, intentos, error, ms],
  );
  console.warn(`[dds-service] DDS ${d.id}: fallo (${error}); reintento #${intentos + 1} en ${ms} ms`);
}

async function procesarCola() {
  if (enCurso) return;
  enCurso = true;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      `SELECT id, contenido_ue, intentos FROM declaraciones
        WHERE estado = 'PENDIENTE_ENVIO' AND proximo_intento_at <= now()
        ORDER BY creado_at LIMIT 10 FOR UPDATE SKIP LOCKED`,
    );
    for (const d of rows) await enviar(c, d);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[dds-service] worker error', e.message);
  } finally {
    c.release();
    enCurso = false;
  }
}

function iniciarWorker() {
  setInterval(procesarCola, Number(process.env.WORKER_INTERVAL_MS || 1000)).unref();
}

module.exports = { iniciarWorker, procesarCola };
