/**
 * Relay del outbox (ADR-003 aplicado a BC2 → BC3).
 * Publica VeredictoEmitido hacia trazabilidad-service por HTTP. Garantiza entrega "al menos una vez":
 * el receptor es idempotente por eventoId. El orden no importa, porque BC3 toma el veredicto más reciente por emitidoAt.
 */
const { pool } = require('./db');

const TRAZA_URL = process.env.TRAZABILIDAD_URL;
let enCurso = false;

async function publicarPendientes() {
  if (enCurso) return;
  enCurso = true;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      `SELECT id, tipo, payload FROM outbox WHERE enviado_at IS NULL
        ORDER BY creado_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
    );
    for (const ev of rows) {
      try {
        const r = await fetch(`${TRAZA_URL}/internal/eventos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: ev.id, tipo: ev.tipo, payload: ev.payload }),
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await c.query('UPDATE outbox SET enviado_at = now(), intentos = intentos + 1 WHERE id = $1', [ev.id]);
      } catch (e) {
        await c.query('UPDATE outbox SET intentos = intentos + 1 WHERE id = $1', [ev.id]);
        console.warn(`[geo-service] relay: no se pudo publicar ${ev.id} (${e.message}); se reintentará`);
        break; // si el destino está caído, no insistir con el resto en este ciclo
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[geo-service] relay error', e.message);
  } finally {
    c.release();
    enCurso = false;
  }
}

function iniciarRelay() {
  const ms = Number(process.env.RELAY_INTERVAL_MS || 1000);
  setInterval(publicarPendientes, ms).unref();
}

module.exports = { iniciarRelay };
