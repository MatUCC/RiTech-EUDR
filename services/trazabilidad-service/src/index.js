/**
 * trazabilidad-service — BC3 Trazabilidad de Lotes (núcleo, D1).
 * Invariantes del contexto:
 *   I1. Solo entra cosecha de parcelas cuyo veredicto MÁS RECIENTE es CONFORME.
 *   I2. Un lote mezclado o dividido es conforme solo si TODAS sus parcelas ancestro siguen CONFORMES.
 *   I3. Un lote se consume una sola vez (no hay doble conteo de masa).
 *   I4. Todo cambio es un evento encadenado en el ledger. Nunca se modifica nada.
 */
const express = require('express');
const { randomUUID } = require('crypto');
const { pool, tx } = require('./db');
const { HttpError, ah, manejadorErrores } = require('./http');
const { registrarEvento, verificarCadena, bloquearLedger } = require('./ledger');

const PRODUCTOS = ['CAFE', 'CACAO'];
const app = express();
app.use(express.json({ limit: '1mb' }));

const actor = (req) => req.get('X-Usuario') || 'desconocido';
const iso = (d) => (d instanceof Date ? d.toISOString() : d);

// ---------- consultas de apoyo ----------

const SQL_VEREDICTO_ACTUAL = `
  SELECT DISTINCT ON (parcela_id) evento_id, parcela_id, estado, dataset_version, regla_version, geometria, emitido_at
    FROM replica_veredictos WHERE parcela_id = ANY($1::uuid[])
   ORDER BY parcela_id, emitido_at DESC`;

async function veredictosActuales(db, parcelaIds) {
  const { rows } = await db.query(SQL_VEREDICTO_ACTUAL, [parcelaIds]);
  return new Map(rows.map((r) => [r.parcela_id, r]));
}

async function parcelasAncestro(db, loteIds) {
  const { rows } = await db.query(
    `WITH RECURSIVE a AS (
        SELECT id FROM lotes WHERE id = ANY($1::uuid[])
        UNION
        SELECT o.origen_lote_id FROM lote_origen o JOIN a ON o.lote_id = a.id)
     SELECT DISTINCT l.parcela_id FROM a JOIN lotes l ON l.id = a.id WHERE l.parcela_id IS NOT NULL`,
    [loteIds],
  );
  return rows.map((r) => r.parcela_id);
}

/** I2: todas las parcelas ancestro deben seguir CONFORMES (un dataset nuevo pudo cambiar su veredicto). */
async function exigirAncestrosConformes(c, loteIds) {
  const parcelas = await parcelasAncestro(c, loteIds);
  const actuales = await veredictosActuales(c, parcelas);
  const bloqueantes = parcelas.filter((p) => actuales.get(p)?.estado !== 'CONFORME');
  if (bloqueantes.length) {
    throw new HttpError(422, 'Operación bloqueada: hay parcelas de origen que ya no son CONFORMES', {
      parcelas: bloqueantes.map((p) => ({ parcelaId: p, estadoActual: actuales.get(p)?.estado || 'SIN_VEREDICTO' })),
    });
  }
  return parcelas;
}

async function cargarLotesNoConsumidos(c, ids) {
  const { rows } = await c.query('SELECT id, producto, kg FROM lotes WHERE id = ANY($1::uuid[])', [ids]);
  if (rows.length !== ids.length) throw new HttpError(404, 'Algún lote de origen no existe');
  const consumidos = await c.query('SELECT lote_id, operacion FROM lotes_consumidos WHERE lote_id = ANY($1::uuid[])', [ids]);
  if (consumidos.rowCount) {
    throw new HttpError(409, 'I3: hay lotes de origen ya consumidos en otra operación', { lotes: consumidos.rows });
  }
  return rows.map((r) => ({ ...r, kg: Number(r.kg) }));
}

// ---------- endpoints ----------

app.get('/health', ah(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ servicio: 'trazabilidad-service', contexto: 'BC3', estado: 'ok' });
}));

/** Published Language desde BC2. Idempotente por eventoId (entrega "al menos una vez"). */
app.post('/internal/eventos', ah(async (req, res) => {
  const { tipo, payload: p } = req.body || {};
  if (tipo !== 'VeredictoEmitido') return res.status(202).json({ ignorado: true });
  await pool.query(
    `INSERT INTO replica_veredictos (evento_id, parcela_id, estado, dataset_version, regla_version, geometria, emitido_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (evento_id) DO NOTHING`,
    [p.eventoId, p.parcelaId, p.estado, p.datasetVersion, p.reglaVersion, JSON.stringify(p.geometria ?? null), p.emitidoAt],
  );
  res.json({ ok: true });
}));

app.post('/lotes/recepcion', ah(async (req, res) => {
  const { parcelaId, producto, kg } = req.body || {};
  if (!parcelaId || !PRODUCTOS.includes(producto) || !(Number(kg) > 0)) {
    throw new HttpError(400, `parcelaId, producto (${PRODUCTOS.join('|')}) y kg > 0 son obligatorios`);
  }
  const lote = await tx(async (c) => {
    await bloquearLedger(c);
    const v = (await veredictosActuales(c, [parcelaId])).get(parcelaId);
    if (!v) throw new HttpError(409, 'La parcela no tiene veredicto en BC3 (pendiente de validación o aún no replicado)');
    if (v.estado !== 'CONFORME') {
      throw new HttpError(422, `I1: parcela bloqueada, veredicto ${v.estado} (dataset ${v.dataset_version})`);
    }
    const id = randomUUID();
    await c.query(
      `INSERT INTO lotes (id, tipo, producto, kg, parcela_id, veredicto_evento_id, creado_por)
       VALUES ($1,'RECEPCION',$2,$3,$4,$5,$6)`,
      [id, producto, Number(kg), parcelaId, v.evento_id, actor(req)],
    );
    const evento = await registrarEvento(c, 'LoteRecibido', id, {
      loteId: id, parcelaId, producto, kg: Number(kg), actor: actor(req), ocurridoAt: new Date().toISOString(),
      // T3: snapshot del veredicto vigente en este momento
      veredicto: { eventoId: v.evento_id, estado: v.estado, datasetVersion: v.dataset_version, reglaVersion: v.regla_version, emitidoAt: iso(v.emitido_at) },
    });
    return { id, tipo: 'RECEPCION', producto, kg: Number(kg), parcelaId, evento };
  });
  res.status(201).json(lote);
}));

app.post('/lotes/mezcla', ah(async (req, res) => {
  const ids = [...new Set((req.body || {}).lotesOrigen || [])];
  if (ids.length < 2) throw new HttpError(400, 'lotesOrigen debe contener al menos 2 lotes distintos');
  const lote = await tx(async (c) => {
    await bloquearLedger(c);
    const origen = await cargarLotesNoConsumidos(c, ids);
    const productos = new Set(origen.map((o) => o.producto));
    if (productos.size > 1) throw new HttpError(422, 'No se pueden mezclar productos distintos');
    const parcelas = await exigirAncestrosConformes(c, ids);

    const id = randomUUID();
    const kg = Number(origen.reduce((s, o) => s + o.kg, 0).toFixed(3));
    const producto = origen[0].producto;
    await c.query(`INSERT INTO lotes (id, tipo, producto, kg, creado_por) VALUES ($1,'MEZCLA',$2,$3,$4)`, [id, producto, kg, actor(req)]);
    for (const o of origen) {
      await c.query('INSERT INTO lote_origen (lote_id, origen_lote_id, kg_aportados) VALUES ($1,$2,$3)', [id, o.id, o.kg]);
      await c.query(`INSERT INTO lotes_consumidos (lote_id, operacion) VALUES ($1, 'MEZCLA')`, [o.id]);
    }
    const evento = await registrarEvento(c, 'LotesMezclados', id, {
      loteId: id, producto, kg, origenes: origen.map((o) => ({ loteId: o.id, kg: o.kg })),
      parcelasAncestro: [...parcelas].sort(), actor: actor(req), ocurridoAt: new Date().toISOString(),
    });
    return { id, tipo: 'MEZCLA', producto, kg, lotesOrigen: ids, parcelasAncestro: parcelas.length, evento };
  });
  res.status(201).json(lote);
}));

app.post('/lotes/:id/division', ah(async (req, res) => {
  const partes = ((req.body || {}).partesKg || []).map(Number);
  if (partes.length < 2 || partes.some((k) => !(k > 0))) throw new HttpError(400, 'partesKg debe tener al menos 2 valores > 0');
  const resultado = await tx(async (c) => {
    await bloquearLedger(c);
    const [origen] = await cargarLotesNoConsumidos(c, [req.params.id]);
    const suma = partes.reduce((s, k) => s + k, 0);
    if (Math.abs(suma - origen.kg) > 0.001) {
      throw new HttpError(422, `Conservación de masa: las partes suman ${suma} kg y el lote tiene ${origen.kg} kg`);
    }
    await exigirAncestrosConformes(c, [origen.id]);
    const hijos = [];
    for (const k of partes) {
      const id = randomUUID();
      await c.query(`INSERT INTO lotes (id, tipo, producto, kg, creado_por) VALUES ($1,'DIVISION',$2,$3,$4)`, [id, origen.producto, k, actor(req)]);
      await c.query('INSERT INTO lote_origen (lote_id, origen_lote_id, kg_aportados) VALUES ($1,$2,$3)', [id, origen.id, k]);
      hijos.push({ id, kg: k });
    }
    await c.query(`INSERT INTO lotes_consumidos (lote_id, operacion) VALUES ($1, 'DIVISION')`, [origen.id]);
    const evento = await registrarEvento(c, 'LoteDividido', origen.id, {
      loteId: origen.id, producto: origen.producto, hijos, actor: actor(req), ocurridoAt: new Date().toISOString(),
    });
    return { loteOrigen: origen.id, lotes: hijos, evento };
  });
  res.status(201).json(resultado);
}));

/** E1: linaje completo hasta las parcelas, con el veredicto vigente en la recepción y el actual, más la prueba de integridad. */
app.get('/lotes/:id/linaje', ah(async (req, res) => {
  const { rows: nodos } = await pool.query(
    `WITH RECURSIVE arbol AS (
        SELECT id, NULL::uuid AS hijo_id, 0 AS nivel FROM lotes WHERE id = $1
        UNION ALL
        SELECT o.origen_lote_id, o.lote_id, a.nivel + 1 FROM lote_origen o JOIN arbol a ON o.lote_id = a.id)
     SELECT a.nivel, a.hijo_id, l.id, l.tipo, l.producto, l.kg, l.parcela_id, l.creado_at,
            rv.evento_id AS v_evento, rv.estado AS v_estado, rv.dataset_version AS v_dataset,
            rv.regla_version AS v_regla, rv.emitido_at AS v_emitido, rv.geometria AS v_geometria
       FROM arbol a JOIN lotes l ON l.id = a.id
       LEFT JOIN replica_veredictos rv ON rv.evento_id = l.veredicto_evento_id
      ORDER BY a.nivel, l.creado_at`,
    [req.params.id],
  );
  if (!nodos.length) throw new HttpError(404, 'Lote no encontrado');

  // El linaje es un DAG: un mismo lote de recepción puede aparecer por dos caminos (división y luego mezcla).
  const recepciones = [...new Map(nodos.filter((n) => n.tipo === 'RECEPCION').map((n) => [n.id, n])).values()];
  const actuales = await veredictosActuales(pool, [...new Set(recepciones.map((n) => n.parcela_id))]);
  const parcelasOrigen = recepciones.map((n) => {
    const act = actuales.get(n.parcela_id);
    return {
      parcelaId: n.parcela_id, loteRecepcion: n.id, kg: Number(n.kg), geometria: n.v_geometria,
      veredictoEnRecepcion: { eventoId: n.v_evento, estado: n.v_estado, datasetVersion: n.v_dataset, reglaVersion: n.v_regla, emitidoAt: iso(n.v_emitido) },
      veredictoActual: act ? { eventoId: act.evento_id, estado: act.estado, datasetVersion: act.dataset_version, emitidoAt: iso(act.emitido_at) } : null,
    };
  });
  const ids = [...new Set(nodos.map((n) => n.id))];
  const { rows: eventos } = await pool.query(
    'SELECT seq, tipo, lote_id, hash FROM eventos WHERE lote_id = ANY($1::uuid[]) ORDER BY seq', [ids],
  );
  const cabeza = await pool.query('SELECT seq, hash FROM eventos ORDER BY seq DESC LIMIT 1');
  const raiz = nodos[0];

  res.json({
    lote: { id: raiz.id, tipo: raiz.tipo, producto: raiz.producto, kg: Number(raiz.kg) },
    conformeActual: parcelasOrigen.length > 0 && parcelasOrigen.every((p) => p.veredictoActual?.estado === 'CONFORME'),
    niveles: Math.max(...nodos.map((n) => n.nivel)),
    nodos: nodos.map((n) => ({ nivel: n.nivel, loteId: n.id, tipo: n.tipo, kg: Number(n.kg), alimentaA: n.hijo_id })),
    parcelasOrigen,
    integridad: {
      eventos: eventos.map((e) => ({ seq: Number(e.seq), tipo: e.tipo, loteId: e.lote_id, hash: e.hash })),
      cabezaLedger: cabeza.rows[0] ? { seq: Number(cabeza.rows[0].seq), hash: cabeza.rows[0].hash } : null,
      verificar: 'GET /auditoria/verificacion',
    },
  });
}));

app.get('/lotes/:id', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, (c.lote_id IS NOT NULL) AS consumido FROM lotes l LEFT JOIN lotes_consumidos c ON c.lote_id = l.id WHERE l.id = $1`,
    [req.params.id],
  );
  if (!rows.length) throw new HttpError(404, 'Lote no encontrado');
  const l = rows[0];
  res.json({ id: l.id, tipo: l.tipo, producto: l.producto, kg: Number(l.kg), parcelaId: l.parcela_id, consumido: l.consumido, creadoPor: l.creado_por });
}));

app.get('/auditoria/verificacion', ah(async (req, res) => {
  res.json(await verificarCadena(pool));
}));

app.use(manejadorErrores('trazabilidad-service'));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`[trazabilidad-service] BC3 escuchando en :${PORT}`));
