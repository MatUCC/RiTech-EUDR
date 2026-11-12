/**
 * BC2 — Motor de cumplimiento geoespacial (D2 / E2).
 * T6: toda la geometría la resuelve PostGIS, no JavaScript propio.
 * T7: el veredicto es función de (geometría, área declarada, versión de dataset, versión de regla).
 * T8: fail-closed. Ante cualquier duda: INVALIDA o NO_CONFORME, nunca CONFORME por defecto.
 */
const { randomUUID } = require('crypto');
const { canonico, sha256 } = require('./canonico');

const REGLA_VERSION = 'eudr-geo-1.0.0';
const UMBRAL_POLIGONO_HA = 4; // EUDR Art. 2(28): parcelas > 4 ha requieren polígono

async function datasetActivo(c) {
  const { rows } = await c.query('SELECT version FROM datasets_forestales WHERE activo');
  if (!rows.length) throw new Error('No hay dataset forestal activo: no se puede emitir veredicto');
  return rows[0].version;
}

/** Evalúa sin persistir. Devuelve {estado, motivo, areaHa, areaSolapadaM2, ...}. */
async function evaluar(c, { geometria, areaDeclaradaHa }) {
  const datasetVersion = await datasetActivo(c);
  const area = areaDeclaradaHa === undefined || areaDeclaradaHa === null ? null : Number(areaDeclaradaHa);
  const hashEntrada = sha256(canonico({ geometria, areaDeclaradaHa: area, datasetVersion, reglaVersion: REGLA_VERSION }));
  const base = { datasetVersion, reglaVersion: REGLA_VERSION, hashEntrada, areaHa: null, areaSolapadaM2: 0 };
  const invalida = (motivo) => ({ ...base, estado: 'INVALIDA', motivo });

  if (!geometria || !['Polygon', 'Point'].includes(geometria.type)) {
    return invalida('Se requiere una geometría GeoJSON de tipo Polygon o Point');
  }
  if (area !== null && !(area > 0)) return invalida('areaDeclaradaHa debe ser un número positivo');

  // 1) Validez topológica. El SAVEPOINT aísla los errores de parseo para no abortar la transacción.
  const geojson = JSON.stringify(geometria);
  let info;
  await c.query('SAVEPOINT validacion');
  try {
    const r = await c.query(
      `SELECT ST_IsValid(g) AS valida, ST_IsValidReason(g) AS razon, GeometryType(g) AS tipo,
              ST_Area(g::geography) / 10000.0 AS area_ha
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) s`,
      [geojson],
    );
    info = r.rows[0];
    await c.query('RELEASE SAVEPOINT validacion');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT validacion');
    return invalida(`Geometría mal formada: ${e.message}`);
  }
  if (!info.valida) return invalida(`Geometría inválida: ${info.razon}`);

  // 2) Regla de 4 ha.
  let areaHa;
  if (info.tipo === 'POINT') {
    if (area === null) return invalida('Una parcela declarada como punto requiere areaDeclaradaHa');
    if (area > UMBRAL_POLIGONO_HA) {
      return invalida(`EUDR: una parcela de ${area} ha (> ${UMBRAL_POLIGONO_HA} ha) debe declararse como polígono`);
    }
    areaHa = area;
  } else {
    areaHa = Number(Number(info.area_ha).toFixed(4));
  }

  // 3) Deforestación posterior a la fecha de corte del dataset activo.
  //    ST_Intersects incluye el contacto por el borde (fail-closed).
  const d = await c.query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(ST_Area(ST_Intersection(a.geom, p.g)::geography)), 0) AS m2,
            MIN(a.fecha_deteccion)::text AS primera
       FROM areas_deforestadas a
       JOIN datasets_forestales ds ON ds.version = a.dataset_version
       CROSS JOIN (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) p
      WHERE ds.version = $2
        AND a.fecha_deteccion > ds.fecha_corte
        AND ST_Intersects(a.geom, p.g)`,
    [geojson, datasetVersion],
  );
  const { n, m2, primera } = d.rows[0];
  const areaSolapadaM2 = Math.round(Number(m2));
  if (n > 0) {
    return {
      ...base,
      areaHa,
      areaSolapadaM2,
      estado: 'NO_CONFORME',
      motivo: `Solapa ${areaSolapadaM2} m² con ${n} área(s) deforestada(s) después del corte (primera detección ${primera})`,
    };
  }
  return { ...base, areaHa, estado: 'CONFORME', motivo: 'Sin solapamiento con deforestación posterior al corte' };
}

/** Evalúa, persiste el veredicto y encola el evento VeredictoEmitido en la misma transacción (outbox). */
async function evaluarYRegistrar(c, { parcelaId, geometria, areaDeclaradaHa }) {
  const r = await evaluar(c, { geometria, areaDeclaradaHa });
  const eventoId = randomUUID();
  const emitidoAt = new Date().toISOString();
  await c.query(
    `INSERT INTO veredictos (id, parcela_id, estado, motivo, area_ha, area_solapada_m2, dataset_version,
                             regla_version, hash_entrada, geometria, emitido_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [eventoId, parcelaId, r.estado, r.motivo, r.areaHa, r.areaSolapadaM2, r.datasetVersion,
      r.reglaVersion, r.hashEntrada, JSON.stringify(geometria ?? null), emitidoAt],
  );
  const veredicto = { eventoId, parcelaId, ...r, emitidoAt };
  await c.query('INSERT INTO outbox (id, tipo, payload) VALUES ($1, $2, $3)', [
    eventoId, 'VeredictoEmitido', JSON.stringify({ ...veredicto, geometria }),
  ]);
  return veredicto;
}

module.exports = { evaluarYRegistrar, REGLA_VERSION };
