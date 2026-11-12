/**
 * Recorrido automático del walking skeleton de RiTech EUDR.
 * Todo pasa por el api-gateway (como un cliente real), salvo:
 *   - el control del simulador de la UE (eu-is-mock), y
 *   - la simulación de ataques al ledger, que se conecta directamente a PostgreSQL.
 */
const { Client } = require('pg');

const GW = process.env.GATEWAY_URL;
const EU = process.env.EU_IS_URL;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;

const titulo = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const paso = (t) => console.log(`\n-- ${t}`);
function comprobar(ok, texto) {
  console.log(`   ${ok ? '[OK]  ' : '[FALLO]'} ${texto}`);
  if (!ok) fallos += 1;
}

async function http(metodo, url, { token, body } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const texto = await r.text();
  let datos;
  try { datos = JSON.parse(texto); } catch { datos = texto; }
  return { status: r.status, datos };
}
const api = (metodo, ruta, token, body) => http(metodo, `${GW}${ruta}`, { token, body });
const modoUE = (modo) => http('POST', `${EU}/_control/modo`, { body: { modo } });
const statsUE = async () => (await http('GET', `${EU}/_control/estadisticas`)).datos;

const poligono = (x1, y1, x2, y2) => ({
  type: 'Polygon', coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]],
});

async function hasta(fn, { cada = 1000, max = 30000 } = {}) {
  const fin = Date.now() + max;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > fin) return null;
    await esperar(cada);
  }
}

async function main() {
  titulo('RiTech EUDR — Walking Skeleton: recorrido de la arquitectura');

  paso('Topología: el gateway consulta /health de cada microservicio por la red');
  const salud = await http('GET', `${GW}/health`);
  for (const [nombre, s] of Object.entries(salud.datos.servicios)) console.log(`   ${nombre.padEnd(22)} ${s.contexto || ''} ${s.estado}`);
  comprobar(salud.status === 200, '4 servicios de dominio + gateway responden');

  paso('BC5: tokens JWT por rol');
  const tk = {};
  for (const [u, rol] of [['coop-huila', 'AGRICULTOR'], ['exportadora-andes', 'EXPORTADOR'], ['auditor-ca-nl', 'AUDITOR']]) {
    tk[rol] = (await api('POST', '/auth/token', null, { usuario: u, rol })).datos.token;
  }
  comprobar(Object.keys(tk).length === 3, 'Tokens emitidos para AGRICULTOR, EXPORTADOR y AUDITOR');

  // ------------------------------------------------------------------ E2
  titulo('E2 / D2 — Corrección geoespacial (registro-service → geo-service, síncrono)');
  const prod = await api('POST', '/api/registro/productores', tk.AGRICULTOR, { nombre: 'María Pérez', documento: 'CC-1001', cooperativa: 'Coop. Huila' });
  const productorId = prod.datos.id;

  const casos = [
    { clave: 'A', nombre: 'Parcela A — limpia', geometria: poligono(-75.5700, 2.2000, -75.5675, 2.2025), esperado: 'CONFORME' },
    { clave: 'B', nombre: 'Parcela B — ~4 % sobre deforestación 2022', geometria: poligono(-75.5901, 2.2000, -75.5876, 2.2025), esperado: 'NO_CONFORME' },
    { clave: 'C', nombre: 'Parcela C — polígono auto-intersectado', geometria: { type: 'Polygon', coordinates: [[[-75.58, 2.20], [-75.575, 2.205], [-75.575, 2.20], [-75.58, 2.205], [-75.58, 2.20]]] }, esperado: 'INVALIDA' },
    { clave: 'D', nombre: 'Parcela D — punto declarado de 6 ha', geometria: { type: 'Point', coordinates: [-75.565, 2.21] }, areaDeclaradaHa: 6, esperado: 'INVALIDA' },
    { clave: 'E', nombre: 'Parcela E — sobre deforestación de 2019 (pre-corte)', geometria: poligono(-75.5450, 2.2050, -75.5425, 2.2075), esperado: 'CONFORME' },
  ];
  const parcelas = {};
  let aciertos = 0;
  for (const caso of casos) {
    const r = await api('POST', '/api/registro/parcelas', tk.AGRICULTOR, { productorId, nombre: caso.nombre, geometria: caso.geometria, areaDeclaradaHa: caso.areaDeclaradaHa });
    const v = r.datos.veredicto || {};
    parcelas[caso.clave] = r.datos.parcela.id;
    const ok = r.datos.estado === caso.esperado;
    if (ok) aciertos += 1;
    console.log(`   ${caso.nombre}\n      → ${r.datos.estado} (esperado ${caso.esperado}) | ${v.motivo || r.datos.aviso}`);
  }
  comprobar(aciertos === casos.length, `Golden dataset mínimo (R-2): ${aciertos}/${casos.length} veredictos correctos, 0 falsos negativos`);

  paso('Determinismo (T7): re-evaluar la parcela A dos veces');
  const r1 = (await api('POST', `/api/registro/parcelas/${parcelas.A}/reevaluar`, tk.AGRICULTOR)).datos.veredicto;
  const r2 = (await api('POST', `/api/registro/parcelas/${parcelas.A}/reevaluar`, tk.AGRICULTOR)).datos.veredicto;
  comprobar(r1.estado === r2.estado && r1.hashEntrada === r2.hashEntrada,
    `Mismo estado (${r1.estado}) y mismo hashEntrada (${r1.hashEntrada.slice(0, 16)}…), dataset ${r1.datasetVersion}, regla ${r1.reglaVersion}`);

  // ------------------------------------------------------------------ E1
  titulo('E1 / D1 — Trazabilidad de mezclas (geo-service ⇢ outbox ⇢ trazabilidad-service)');
  paso('Consistencia eventual: registrar la parcela F y pedir su recepción de inmediato');
  const regF = await api('POST', '/api/registro/parcelas', tk.AGRICULTOR, { productorId, nombre: 'Parcela F — limpia, recién registrada', geometria: poligono(-75.5650, 2.2000, -75.5625, 2.2025) });
  const t409 = Date.now();
  let intentos409 = 0;
  const loteF = await hasta(async () => {
    const r = await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AGRICULTOR, { parcelaId: regF.datos.parcela.id, producto: 'CAFE', kg: 100 });
    if (r.status === 409) { intentos409 += 1; return null; }
    return r.datos;
  }, { cada: 200 });
  console.log(`   Veredicto en BC2: ${regF.datos.estado}; BC3 respondió 409 "aún no replicado" ${intentos409} vez/veces durante ${Date.now() - t409} ms`);
  comprobar(Boolean(loteF?.id), 'Mientras el veredicto no llega por el outbox, la parcela no puede usarse (fail-closed); después, la recepción se acepta');
  const loteA1 = (await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AGRICULTOR, { parcelaId: parcelas.A, producto: 'CAFE', kg: 1200 })).datos;
  const loteA2 = (await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AGRICULTOR, { parcelaId: parcelas.A, producto: 'CAFE', kg: 800 })).datos;
  const loteE1 = await hasta(async () => {
    const r = await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AGRICULTOR, { parcelaId: parcelas.E, producto: 'CAFE', kg: 500 });
    return r.status === 201 ? r.datos : null;
  });

  paso('Invariante I1: la cosecha de la parcela B (NO_CONFORME) no puede entrar');
  const rb = await hasta(async () => {
    const r = await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AGRICULTOR, { parcelaId: parcelas.B, producto: 'CAFE', kg: 300 });
    return r.status === 409 ? null : r;
  });
  comprobar(rb.status === 422, `HTTP ${rb.status}: ${rb.datos.error}`);

  paso('3 niveles: mezcla(A1,A2) → división en 2 → mezcla(parte1, E1) = lote de exportación');
  const m1 = (await api('POST', '/api/trazabilidad/lotes/mezcla', tk.AGRICULTOR, { lotesOrigen: [loteA1.id, loteA2.id] })).datos;
  const div = (await api('POST', `/api/trazabilidad/lotes/${m1.id}/division`, tk.EXPORTADOR, { partesKg: [1500, 500] })).datos;
  const exp = (await api('POST', '/api/trazabilidad/lotes/mezcla', tk.EXPORTADOR, { lotesOrigen: [div.lotes[0].id, loteE1.id] })).datos;
  console.log(`   Mezcla 1: ${m1.kg} kg | División: ${div.lotes.map((l) => l.kg).join(' + ')} kg | Exportación: ${exp.kg} kg (${exp.id})`);

  paso('Invariante I3: reutilizar un lote ya consumido');
  const reuso = await api('POST', '/api/trazabilidad/lotes/mezcla', tk.EXPORTADOR, { lotesOrigen: [loteA1.id, div.lotes[1].id] });
  comprobar(reuso.status === 409, `HTTP ${reuso.status}: ${reuso.datos.error}`);

  paso('El AUDITOR consulta el linaje (solo lectura)');
  const lin = (await api('GET', `/api/trazabilidad/lotes/${exp.id}/linaje`, tk.AUDITOR)).datos;
  for (const n of lin.nodos) console.log(`   ${'   '.repeat(n.nivel)}└ nivel ${n.nivel}: ${n.tipo.padEnd(9)} ${String(n.kg).padStart(6)} kg  ${n.loteId.slice(0, 8)}`);
  for (const p of lin.parcelasOrigen) {
    console.log(`   Recepción ${p.loteRecepcion.slice(0, 8)} ← parcela ${p.parcelaId.slice(0, 8)}: veredicto en recepción ${p.veredictoEnRecepcion.estado} (${p.veredictoEnRecepcion.datasetVersion}), actual ${p.veredictoActual.estado}, geometría ${p.geometria.type}`);
  }
  const esperadas = new Set([parcelas.A, parcelas.E]);
  const obtenidas = new Set(lin.parcelasOrigen.map((p) => p.parcelaId));
  comprobar(lin.niveles === 3 && obtenidas.size === esperadas.size && [...esperadas].every((p) => obtenidas.has(p)),
    `Linaje de ${lin.niveles} niveles hasta ${obtenidas.size} parcelas de origen (0 huérfanas), ${lin.integridad.eventos.length} eventos con hash`);
  const intentoAuditor = await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AUDITOR, { parcelaId: parcelas.A, producto: 'CAFE', kg: 1 });
  comprobar(intentoAuditor.status === 403, `RBAC: el AUDITOR no puede escribir (HTTP ${intentoAuditor.status})`);
  const interno = await api('POST', '/api/trazabilidad/internal/eventos', tk.EXPORTADOR, {});
  comprobar(interno.status === 404, `El gateway no expone /internal (HTTP ${interno.status})`);

  paso('Integridad del ledger (ADR-002)');
  let ver = (await api('GET', '/api/trazabilidad/auditoria/verificacion', tk.AUDITOR)).datos;
  comprobar(ver.integra, `Cadena íntegra: ${ver.eventosVerificados} eventos, cabeza ${ver.hashCabeza.slice(0, 16)}…`);

  paso('Ataque 1: el propio servicio intenta modificar un evento (credenciales de trazabilidad)');
  const svc = new Client({ connectionString: process.env.TRAZA_DB_URL });
  await svc.connect();
  try {
    await svc.query(`UPDATE eventos SET payload = jsonb_set(payload, '{kg}', '99999') WHERE lote_id = $1`, [loteA1.id]);
    comprobar(false, 'El UPDATE debería haber sido rechazado');
  } catch (e) {
    comprobar(/permission denied/i.test(e.message), `Rechazado por PostgreSQL: "${e.message}"`);
  } finally { await svc.end(); }

  paso('Ataque 2: un superusuario salta el trigger y altera los kg de una recepción');
  const adm = new Client({ connectionString: process.env.ADMIN_DB_URL });
  await adm.connect();
  try {
    const { rows: [orig] } = await adm.query(`SELECT seq, payload FROM eventos WHERE lote_id = $1 AND tipo = 'LoteRecibido'`, [loteA1.id]);
    try {
      await adm.query(`UPDATE eventos SET payload = jsonb_set(payload, '{kg}', '99999') WHERE seq = $1`, [orig.seq]);
      comprobar(false, 'El trigger debería haber bloqueado incluso al superusuario');
    } catch (e) {
      comprobar(/append-only/.test(e.message), `Trigger append-only: "${e.message}"`);
    }
    await adm.query('SET session_replication_role = replica'); // desactiva triggers en esta sesión
    await adm.query(`UPDATE eventos SET payload = jsonb_set(payload, '{kg}', '99999') WHERE seq = $1`, [orig.seq]);
    ver = (await api('GET', '/api/trazabilidad/auditoria/verificacion', tk.AUDITOR)).datos;
    comprobar(!ver.integra && ver.primerEventoAlterado.seq === Number(orig.seq),
      `Manipulación DETECTADA en el evento seq=${ver.primerEventoAlterado?.seq} (${ver.primerEventoAlterado?.tipo})`);
    await adm.query('UPDATE eventos SET payload = $2 WHERE seq = $1', [orig.seq, JSON.stringify(orig.payload)]);
    await adm.query('SET session_replication_role = origin');
    ver = (await api('GET', '/api/trazabilidad/auditoria/verificacion', tk.AUDITOR)).datos;
    comprobar(ver.integra, 'Payload original restaurado: la cadena vuelve a verificar (el hash depende solo del contenido)');
  } finally { await adm.end(); }

  // ------------------------------------------------------------------ E3
  titulo('E3 / D3 — El Sistema de Información UE se cae (dds-service ⇢ eu-is-mock)');
  await modoUE('NORMAL');
  const base = await statsUE();
  const lotesExp = [exp.id];
  for (const kg of [700, 900]) {
    const r = (await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AGRICULTOR, { parcelaId: parcelas.A, producto: 'CAFE', kg })).datos;
    lotesExp.push(r.id);
  }

  paso('Simulador UE en modo CAIDO (503); el exportador envía 3 DDS');
  await modoUE('CAIDO');
  const ddsIds = [];
  for (const loteId of lotesExp) {
    const r = await api('POST', '/api/dds/dds', tk.EXPORTADOR, { loteId });
    ddsIds.push(r.datos.id);
    console.log(`   HTTP ${r.status} ${r.datos.estado} — ${r.datos.id}`);
  }
  comprobar(ddsIds.every(Boolean), 'Las 3 DDS se aceptaron (202) a pesar de la caída: nada se pierde');

  paso('Durante la caída, el resto del sistema sigue funcionando (bulkhead)');
  const durante = await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AGRICULTOR, { parcelaId: parcelas.E, producto: 'CAFE', kg: 50 });
  comprobar(durante.status === 201, `Recepción de cosecha durante la caída: HTTP ${durante.status}`);

  await esperar(6000);
  const pendientes = await Promise.all(ddsIds.map(async (id) => (await api('GET', `/api/dds/dds/${id}`, tk.EXPORTADOR)).datos));
  for (const d of pendientes) console.log(`   ${d.id.slice(0, 8)}: ${d.estado}, intentos=${d.intentos}, último error="${d.ultimoError}"`);
  comprobar(pendientes.every((d) => d.estado === 'PENDIENTE_ENVIO' && d.intentos >= 2), 'Siguen PENDIENTE_ENVIO, reintentando con backoff');

  paso('La UE se recupera (modo NORMAL)');
  await modoUE('NORMAL');
  const t0 = Date.now();
  const finales = await hasta(async () => {
    const ds = await Promise.all(ddsIds.map(async (id) => (await api('GET', `/api/dds/dds/${id}`, tk.EXPORTADOR)).datos));
    return ds.every((d) => d.estado === 'REGISTRADA') ? ds : null;
  }, { max: 60000 });
  comprobar(Boolean(finales), `Las 3 DDS quedaron REGISTRADAS ${((Date.now() - t0) / 1000).toFixed(1)} s después de la recuperación (medida E3: ≤ 15 min)`);
  for (const d of finales || []) console.log(`   ${d.id.slice(0, 8)}: ${d.numeroReferencia} (intentos=${d.intentos})`);
  const tras = await statsUE();
  comprobar(tras.declaracionesRegistradas - base.declaracionesRegistradas === 3, `La UE registró exactamente 3 DDS (0 perdidas, 0 duplicadas); rechazó ${tras.rechazadas503 - base.rechazadas503} peticiones con 503`);

  // ------------------------------------------------------------------ R-1
  titulo('R-1 — Timeout ambiguo: la UE registra pero responde tarde (modo LENTO)');
  await modoUE('LENTO');
  const antes = await statsUE();
  const lx = (await api('POST', '/api/trazabilidad/lotes/recepcion', tk.AGRICULTOR, { parcelaId: parcelas.E, producto: 'CAFE', kg: 120 })).datos;
  const ddsLenta = (await api('POST', '/api/dds/dds', tk.EXPORTADOR, { loteId: lx.id })).datos;
  await esperar(7000); // primer intento: timeout de 5 s en el cliente
  await modoUE('NORMAL');
  const reg = await hasta(async () => {
    const d = (await api('GET', `/api/dds/dds/${ddsLenta.id}`, tk.EXPORTADOR)).datos;
    return d.estado === 'REGISTRADA' ? d : null;
  }, { max: 60000 });
  const despues = await statsUE();
  comprobar(Boolean(reg) && reg.intentos >= 2, `DDS registrada tras ${reg?.intentos} intentos con la misma Idempotency-Key → ${reg?.numeroReferencia}`);
  comprobar(despues.declaracionesRegistradas - antes.declaracionesRegistradas === 1 && despues.duplicadasEvitadas > antes.duplicadasEvitadas,
    `La UE tiene 1 sola DDS nueva; duplicados evitados por idempotencia: ${despues.duplicadasEvitadas - antes.duplicadasEvitadas}`);

  titulo(fallos === 0 ? 'RESULTADO: todas las comprobaciones pasaron' : `RESULTADO: ${fallos} comprobación(es) fallaron`);
  console.log('El sistema sigue activo: API en http://localhost:8080 y simulador UE en http://localhost:8090');
  process.exitCode = fallos === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('La demo se interrumpió:', e);
  process.exitCode = 1;
});
