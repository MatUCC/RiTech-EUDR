/**
 * ADR-002 — Ledger append-only con cadena de hashes (T1, T2).
 * hash_n = sha256(hash_{n-1} | evento_id | tipo | lote_id | payload canónico)
 * Si se altera cualquier evento, la cadena se rompe desde ese punto.
 */
const { randomUUID } = require('crypto');
const { canonico, sha256 } = require('./canonico');

const GENESIS = '0'.repeat(64);
// Lock global: serializa las escrituras para encadenar los hashes. Consecuencia negativa de ADR-002.
const LOCK_LEDGER = 4242;

const calcularHash = (prevHash, e) => sha256(`${prevHash}|${e.evento_id}|${e.tipo}|${e.lote_id}|${canonico(e.payload)}`);

async function bloquearLedger(c) {
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_LEDGER]);
}

/** Añade un evento al final de la cadena. Debe llamarse dentro de una transacción. */
async function registrarEvento(c, tipo, loteId, payload) {
  await bloquearLedger(c);
  const { rows } = await c.query('SELECT hash FROM eventos ORDER BY seq DESC LIMIT 1');
  const prevHash = rows.length ? rows[0].hash : GENESIS;
  const ev = { evento_id: randomUUID(), tipo, lote_id: loteId, payload };
  const hash = calcularHash(prevHash, ev);
  const r = await c.query(
    'INSERT INTO eventos (evento_id, tipo, lote_id, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING seq',
    [ev.evento_id, tipo, loteId, JSON.stringify(payload), prevHash, hash],
  );
  return { seq: Number(r.rows[0].seq), eventoId: ev.evento_id, hash };
}

/** Recalcula la cadena completa. Es O(n); a 5 años necesitará checkpoints (ADR-002, consecuencias negativas). */
async function verificarCadena(db) {
  const { rows } = await db.query('SELECT seq, evento_id, tipo, lote_id, payload, prev_hash, hash FROM eventos ORDER BY seq');
  let prev = GENESIS;
  for (const e of rows) {
    const esperado = calcularHash(prev, e);
    if (e.prev_hash !== prev || e.hash !== esperado) {
      return {
        integra: false,
        eventosVerificados: rows.length,
        primerEventoAlterado: { seq: Number(e.seq), tipo: e.tipo, loteId: e.lote_id, hashGuardado: e.hash, hashRecalculado: esperado },
      };
    }
    prev = e.hash;
  }
  return { integra: true, eventosVerificados: rows.length, hashCabeza: prev };
}

module.exports = { registrarEvento, verificarCadena, bloquearLedger };
