/** registro-service — BC1 Registro de Productores y Parcelas (soporte). Es dueño de la PII (T4). */
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('./db');
const { HttpError, ah, manejadorErrores } = require('./http');

const GEO_URL = process.env.GEO_URL;
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', ah(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ servicio: 'registro-service', contexto: 'BC1', estado: 'ok' });
}));

app.post('/productores', ah(async (req, res) => {
  const { nombre, documento, cooperativa } = req.body || {};
  if (!nombre || !documento) throw new HttpError(400, 'nombre y documento son obligatorios');
  const id = randomUUID();
  await pool.query('INSERT INTO productores (id, nombre, documento, cooperativa) VALUES ($1,$2,$3,$4)',
    [id, nombre, documento, cooperativa || null]);
  res.status(201).json({ id, nombre, cooperativa: cooperativa || null });
}));

/**
 * Pide el veredicto a BC2 de forma síncrona (Customer/Supplier).
 * T8 fail-closed: si geo-service no responde, la parcela queda PENDIENTE. Como BC3 nunca recibe
 * un veredicto para ella, no puede entrar en ningún lote.
 */
async function solicitarVeredicto(parcela) {
  try {
    const r = await fetch(`${GEO_URL}/evaluaciones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parcelaId: parcela.id,
        geometria: parcela.geometria,
        areaDeclaradaHa: parcela.area_declarada_ha ?? undefined,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`geo-service respondió HTTP ${r.status}`);
    const v = await r.json();
    await pool.query('UPDATE parcelas SET estado_validacion = $2, ultimo_veredicto = $3 WHERE id = $1',
      [parcela.id, v.estado, JSON.stringify(v)]);
    return { estado: v.estado, veredicto: v };
  } catch (e) {
    console.warn(`[registro-service] geo-service no disponible para ${parcela.id}: ${e.message}`);
    return { estado: 'PENDIENTE', aviso: 'Validación geoespacial no disponible; reintente con POST /parcelas/:id/reevaluar' };
  }
}

const aDto = (p) => ({
  id: p.id, productorId: p.productor_id, nombre: p.nombre, geometria: p.geometria,
  areaDeclaradaHa: p.area_declarada_ha === null ? null : Number(p.area_declarada_ha),
  estadoValidacion: p.estado_validacion, ultimoVeredicto: p.ultimo_veredicto,
});

app.post('/parcelas', ah(async (req, res) => {
  const { productorId, nombre, geometria, areaDeclaradaHa } = req.body || {};
  if (!productorId || !nombre || !geometria) throw new HttpError(400, 'productorId, nombre y geometria son obligatorios');
  const existe = await pool.query('SELECT 1 FROM productores WHERE id = $1', [productorId]);
  if (!existe.rowCount) throw new HttpError(404, 'Productor no encontrado');

  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO parcelas (id, productor_id, nombre, geometria, area_declarada_ha)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, productorId, nombre, JSON.stringify(geometria), areaDeclaradaHa ?? null],
  );
  const resultado = await solicitarVeredicto(rows[0]);
  res.status(201).json({ parcela: { ...aDto(rows[0]), estadoValidacion: resultado.estado }, ...resultado });
}));

app.post('/parcelas/:id/reevaluar', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM parcelas WHERE id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Parcela no encontrada');
  res.json(await solicitarVeredicto(rows[0]));
}));

app.get('/parcelas/:id', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM parcelas WHERE id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Parcela no encontrada');
  res.json(aDto(rows[0]));
}));

app.get('/parcelas', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM parcelas ORDER BY creado_at DESC LIMIT 200');
  res.json(rows.map(aDto));
}));

app.use(manejadorErrores('registro-service'));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`[registro-service] BC1 escuchando en :${PORT}`));
