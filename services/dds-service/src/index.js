/** dds-service — BC4 Debida Diligencia y Pasarela UE (D3). */
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('./db');
const { HttpError, ah, manejadorErrores } = require('./http');
const { aFormatoUE } = require('./acl/traductor-ue');
const { iniciarWorker, procesarCola } = require('./worker');

const TRAZA_URL = process.env.TRAZABILIDAD_URL;
const PAIS = process.env.PAIS_PRODUCCION || 'CO';
const app = express();
app.use(express.json({ limit: '1mb' }));

const aDto = (d) => ({
  id: d.id, loteId: d.lote_id, operador: d.operador, estado: d.estado,
  numeroReferencia: d.numero_referencia, numeroVerificacion: d.numero_verificacion,
  intentos: d.intentos, ultimoError: d.ultimo_error, creadaAt: d.creado_at, registradaAt: d.registrada_at,
});

app.get('/health', ah(async (req, res) => {
  const { rows } = await pool.query(`SELECT estado, COUNT(*)::int AS n FROM declaraciones GROUP BY estado`);
  res.json({ servicio: 'dds-service', contexto: 'BC4', estado: 'ok', cola: Object.fromEntries(rows.map((r) => [r.estado, r.n])) });
}));

/**
 * Crea la DDS y responde 202 sin esperar a la UE (T10).
 * Depende de forma síncrona de BC3 para obtener el linaje (consecuencia negativa de ADR-003).
 */
app.post('/dds', ah(async (req, res) => {
  const { loteId } = req.body || {};
  if (!loteId) throw new HttpError(400, 'loteId es obligatorio');
  const operador = req.get('X-Usuario') || 'desconocido';

  let r;
  try {
    r = await fetch(`${TRAZA_URL}/lotes/${encodeURIComponent(loteId)}/linaje`, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    throw new HttpError(502, `Trazabilidad no disponible: ${e.message}`);
  }
  if (r.status === 404 || r.status === 400) throw new HttpError(404, 'Lote no encontrado en trazabilidad');
  if (!r.ok) throw new HttpError(502, `Trazabilidad respondió HTTP ${r.status}`);
  const linaje = await r.json();
  if (!linaje.conformeActual) {
    throw new HttpError(422, 'El lote contiene parcelas no conformes o sin veredicto: no se puede declarar', {
      parcelas: linaje.parcelasOrigen.map((p) => ({ parcelaId: p.parcelaId, estado: p.veredictoActual?.estado })),
    });
  }

  const id = randomUUID();
  const contenidoUE = aFormatoUE({ id, operador, pais: PAIS, linaje });
  await pool.query(
    `INSERT INTO declaraciones (id, lote_id, operador, estado, contenido_ue) VALUES ($1,$2,$3,'PENDIENTE_ENVIO',$4)`,
    [id, loteId, operador, JSON.stringify(contenidoUE)],
  );
  setImmediate(procesarCola);
  res.status(202).json({
    id, loteId, estado: 'PENDIENTE_ENVIO', parcelasDeclaradas: linaje.parcelasOrigen.length,
    mensaje: 'Declaración aceptada. Se enviará al Sistema de Información UE; consulte GET /dds/:id para obtener el número de referencia.',
  });
}));

app.get('/dds/:id', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM declaraciones WHERE id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'DDS no encontrada');
  res.json(aDto(rows[0]));
}));

app.get('/dds', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM declaraciones ORDER BY creado_at DESC LIMIT 200');
  res.json(rows.map(aDto));
}));

app.use(manejadorErrores('dds-service'));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[dds-service] BC4 escuchando en :${PORT}`);
  iniciarWorker();
});
