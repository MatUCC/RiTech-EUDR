/**
 * eu-is-mock — simulador del Sistema de Información EUDR (sistema EXTERNO, fuera de nuestro control).
 * Modos de funcionamiento (para E3 y R-1):
 *   NORMAL : registra y responde al instante.
 *   CAIDO  : responde 503 a todo (E3: caída de horas).
 *   LENTO  : registra la DDS y responde después del timeout del cliente (R-1: timeout ambiguo).
 * Respeta Idempotency-Key: una misma clave devuelve siempre la misma referencia.
 */
const express = require('express');
const { randomInt } = require('crypto');
const { manejadorErrores } = require('./http');

const MODOS = ['NORMAL', 'CAIDO', 'LENTO'];
let modo = 'NORMAL';
const registros = new Map(); // Idempotency-Key -> respuesta
const stats = { peticiones: 0, rechazadas503: 0, duplicadasEvitadas: 0 };

const app = express();
app.use(express.json({ limit: '2mb' }));

app.post('/api/v1/dds', (req, res) => {
  stats.peticiones += 1;
  if (modo === 'CAIDO') {
    stats.rechazadas503 += 1;
    return res.status(503).json({ error: 'Service Unavailable (simulado)' });
  }
  const clave = req.get('Idempotency-Key');
  if (!clave) return res.status(400).json({ error: 'Falta Idempotency-Key' });

  const b = req.body || {};
  const features = b.commodities?.[0]?.geolocation?.features || [];
  if (b.activityType !== 'EXPORT' || !b.commodities?.length || !features.length) {
    return res.status(422).json({ error: 'DDS incompleta: actividad, mercancía y geolocalización son obligatorias' });
  }

  let status = 200;
  if (registros.has(clave)) {
    stats.duplicadasEvitadas += 1;
  } else {
    registros.set(clave, {
      referenceNumber: `26CO${String(registros.size + 1).padStart(6, '0')}`,
      verificationNumber: String(randomInt(10000000, 99999999)),
    });
    status = 201;
  }
  const respuesta = registros.get(clave);
  if (modo === 'LENTO') return setTimeout(() => res.status(status).json(respuesta), 8000);
  return res.status(status).json(respuesta);
});

app.post('/_control/modo', (req, res) => {
  const nuevo = (req.body || {}).modo;
  if (!MODOS.includes(nuevo)) return res.status(400).json({ error: `modo debe ser ${MODOS.join('|')}` });
  modo = nuevo;
  console.log(`[eu-is-mock] modo = ${modo}`);
  return res.json({ modo });
});

app.get('/_control/estadisticas', (req, res) => {
  res.json({ modo, declaracionesRegistradas: registros.size, ...stats });
});

app.use(manejadorErrores('eu-is-mock'));

const PORT = Number(process.env.PORT || 8090);
app.listen(PORT, () => console.log(`[eu-is-mock] Sistema de Información EUDR simulado en :${PORT}`));
