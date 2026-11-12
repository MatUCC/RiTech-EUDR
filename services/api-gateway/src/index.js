/**
 * api-gateway — punto de entrada único + BC5 Identidad y Acceso (genérico).
 * T15: JWT + RBAC. AUDITOR = solo lectura. Las rutas /internal/* nunca se exponen.
 * En el esqueleto, /auth/token emite tokens de demostración. En producción se sustituiría por un IdP estándar
 * (p. ej. Keycloak/OIDC) sin tocar los servicios de dominio.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { HttpError, ah, manejadorErrores } = require('./http');

const SECRET = process.env.JWT_SECRET;
const ROLES = ['AGRICULTOR', 'EXPORTADOR', 'AUDITOR'];

// Tabla de enrutamiento = mapa de bounded contexts expuestos.
const RUTAS = [
  { prefijo: '/api/registro', destino: process.env.REGISTRO_URL, escritura: ['AGRICULTOR'] },
  { prefijo: '/api/trazabilidad', destino: process.env.TRAZABILIDAD_URL, escritura: ['AGRICULTOR', 'EXPORTADOR'] },
  { prefijo: '/api/dds', destino: process.env.DDS_URL, escritura: ['EXPORTADOR'] },
];
const SERVICIOS = {
  'registro-service': process.env.REGISTRO_URL,
  'geo-service': process.env.GEO_URL,
  'trazabilidad-service': process.env.TRAZABILIDAD_URL,
  'dds-service': process.env.DDS_URL,
};

const app = express();
app.use(express.json({ limit: '1mb' }));

/** Estado de la topología: muestra que hay servicios reales detrás del gateway. */
app.get('/health', ah(async (req, res) => {
  const resultados = await Promise.all(Object.entries(SERVICIOS).map(async ([nombre, url]) => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      return [nombre, r.ok ? await r.json() : { estado: `HTTP ${r.status}` }];
    } catch (e) {
      return [nombre, { estado: 'caido', error: e.message }];
    }
  }));
  const servicios = Object.fromEntries(resultados);
  const ok = Object.values(servicios).every((s) => s.estado === 'ok');
  res.status(ok ? 200 : 503).json({ gateway: 'ok', servicios });
}));

app.post('/auth/token', (req, res) => {
  const { usuario, rol } = req.body || {};
  if (!usuario || !ROLES.includes(rol)) {
    return res.status(400).json({ error: `usuario y rol (${ROLES.join('|')}) son obligatorios` });
  }
  const token = jwt.sign({ sub: usuario, rol }, SECRET, { expiresIn: '8h' });
  return res.json({ token, rol, aviso: 'Token de demostración: en producción lo emitiría un IdP' });
});

function autenticar(req, res, next) {
  const [, token] = (req.get('Authorization') || '').split(' ');
  try {
    req.usuario = jwt.verify(token, SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Token ausente o inválido' });
  }
}

for (const ruta of RUTAS) {
  app.use(ruta.prefijo, autenticar, ah(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://gateway');
    if (pathname.startsWith('/internal')) throw new HttpError(404, 'No encontrado');
    if (req.method !== 'GET' && !ruta.escritura.includes(req.usuario.rol)) {
      throw new HttpError(403, `El rol ${req.usuario.rol} no puede ejecutar ${req.method} en ${ruta.prefijo}`);
    }
    const init = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Usuario': req.usuario.sub,
        'X-Rol': req.usuario.rol,
        'X-Request-Id': req.get('X-Request-Id') || randomUUID(),
      },
      signal: AbortSignal.timeout(15000),
    };
    if (!['GET', 'HEAD'].includes(req.method)) init.body = JSON.stringify(req.body ?? {});
    let r;
    try {
      r = await fetch(`${ruta.destino}${req.url}`, init);
    } catch (e) {
      throw new HttpError(502, `Servicio no disponible (${ruta.prefijo}): ${e.message}`);
    }
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(await r.text());
  }));
}

app.use(manejadorErrores('api-gateway'));

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log(`[api-gateway] escuchando en :${PORT}`));
