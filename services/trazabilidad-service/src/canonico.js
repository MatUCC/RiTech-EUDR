const crypto = require('crypto');

/**
 * JSON canónico: claves ordenadas y sin undefined. Es estable aunque jsonb reordene las claves.
 * Se usa para el hash de entrada (T7) y la cadena de hashes (T2).
 */
function canonico(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonico(x))).join(',')}]`;
  const claves = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
}

const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

module.exports = { canonico, sha256 };
