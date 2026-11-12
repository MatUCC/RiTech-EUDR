/** Utilidades HTTP mínimas (copiadas en cada servicio a propósito: sin librerías compartidas entre microservicios). */
class HttpError extends Error {
  constructor(status, message, detalle) {
    super(message);
    this.status = status;
    this.detalle = detalle;
  }
}

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function manejadorErrores(servicio) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    // 22P02 = uuid u otro valor con formato inválido en PostgreSQL
    const status = err.status || (err.code === '22P02' ? 400 : 500);
    if (status >= 500) console.error(`[${servicio}]`, err);
    res.status(status).json({ error: err.message, ...(err.detalle ? { detalle: err.detalle } : {}) });
  };
}

module.exports = { HttpError, ah, manejadorErrores };
