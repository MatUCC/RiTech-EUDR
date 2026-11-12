/** geo-service — BC2 Cumplimiento Geoespacial (núcleo, D2). */
const express = require('express');
const { pool, tx } = require('./db');
const { HttpError, ah, manejadorErrores } = require('./http');
const { evaluarYRegistrar, REGLA_VERSION } = require('./evaluador');
const { iniciarRelay } = require('./relay');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT version FROM datasets_forestales WHERE activo');
  res.json({ servicio: 'geo-service', contexto: 'BC2', estado: 'ok', datasetActivo: rows[0]?.version, reglaVersion: REGLA_VERSION });
}));

// Customer/Supplier síncrono con BC1: E2 exige un veredicto inmediato (≤ 3 s).
app.post('/evaluaciones', ah(async (req, res) => {
  const { parcelaId, geometria, areaDeclaradaHa } = req.body || {};
  if (!parcelaId) throw new HttpError(400, 'parcelaId es obligatorio');
  const veredicto = await tx((c) => evaluarYRegistrar(c, { parcelaId, geometria, areaDeclaradaHa }));
  res.status(201).json(veredicto);
}));

app.get('/veredictos/:parcelaId', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id AS "eventoId", parcela_id AS "parcelaId", estado, motivo, area_ha AS "areaHa",
            area_solapada_m2 AS "areaSolapadaM2", dataset_version AS "datasetVersion",
            regla_version AS "reglaVersion", hash_entrada AS "hashEntrada", emitido_at AS "emitidoAt"
       FROM veredictos WHERE parcela_id = $1 ORDER BY emitido_at DESC`,
    [req.params.parcelaId],
  );
  res.json(rows);
}));

app.use(manejadorErrores('geo-service'));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[geo-service] BC2 escuchando en :${PORT}`);
  iniciarRelay();
});
