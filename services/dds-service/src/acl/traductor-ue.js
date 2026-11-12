/**
 * T13 — Anti-Corruption Layer hacia el Sistema de Información EUDR.
 * Es el ÚNICO módulo que conoce el formato de la UE. Si la Comisión cambia el esquema, solo cambia este archivo.
 * El formato es un subconjunto simplificado e ilustrativo del esquema de DDS; no es el esquema oficial.
 */
const CODIGO_SA = { CAFE: '0901', CACAO: '1801' }; // partidas del Sistema Armonizado

function aFormatoUE({ id, operador, pais, linaje }) {
  return {
    internalReferenceNumber: id,
    activityType: 'EXPORT',
    operator: { identifier: operador },
    countryOfActivity: pais,
    commodities: [
      {
        hsHeading: CODIGO_SA[linaje.lote.producto],
        descriptionOfGoods: `${linaje.lote.producto} — lote ${linaje.lote.id}`,
        netWeightKg: linaje.lote.kg,
        countryOfProduction: pais,
        geolocation: {
          type: 'FeatureCollection',
          features: linaje.parcelasOrigen.map((p) => ({
            type: 'Feature',
            geometry: p.geometria,
            properties: { plotId: p.parcelaId },
          })),
        },
      },
    ],
  };
}

/** Traduce la respuesta de la UE al lenguaje interno. */
function desdeRespuestaUE(body) {
  return { numeroReferencia: body.referenceNumber, numeroVerificacion: body.verificationNumber };
}

module.exports = { aFormatoUE, desdeRespuestaUE };
