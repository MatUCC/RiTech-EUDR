-- ADR-001: una base de datos lógica por servicio, cada una con su propio usuario.
-- Ningún servicio puede conectarse a la base de otro.

CREATE ROLE registro     LOGIN PASSWORD 'registro_pw';
CREATE ROLE geo          LOGIN PASSWORD 'geo_pw';
CREATE ROLE trazabilidad LOGIN PASSWORD 'traza_pw';
CREATE ROLE dds          LOGIN PASSWORD 'dds_pw';

CREATE DATABASE registro     OWNER registro;
CREATE DATABASE geo          OWNER geo;
-- ADR-002: la BD del ledger NO pertenece al servicio. Así el servicio no puede
-- borrar tablas, desactivar triggers ni otorgarse UPDATE/DELETE.
CREATE DATABASE trazabilidad OWNER postgres;
CREATE DATABASE dds          OWNER dds;

REVOKE ALL ON DATABASE registro, geo, trazabilidad, dds FROM PUBLIC;
GRANT CONNECT ON DATABASE trazabilidad TO trazabilidad;
