const {readFileSync} = require('node:fs');
const {RequestStoreError} = require('./request');

function configuration(message) {
  return new RequestStoreError('INVALID_CONFIGURATION', message, 500);
}

function positiveInteger(value, fallback, max) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw configuration('PostgreSQL limits must be positive bounded integers');
  }
  return number;
}

/**
 * True for URL query keys that pg-connection-string turns into TLS settings
 * (every ssl* key and uselibpqcompat), compared case-insensitively.
 * @param {string} name
 * @return {boolean}
 */
function isUrlTlsKey(name) {
  const key = name.toLowerCase();
  return key.startsWith('ssl') || key === 'uselibpqcompat';
}

/** Build explicit TLS settings without URL SSL parameters overriding them. */
function postgresOptionsFromEnv(env = process.env) {
  if (!env.DATABASE_URL) {
    throw configuration('DATABASE_URL is required');
  }
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw configuration('DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw configuration('DATABASE_URL must be a PostgreSQL URL');
  }
  const mode = env.PGSSLMODE || url.searchParams.get('sslmode') ||
      (env.DB_SSL === 'true' ? 'verify-full' : 'disable');
  if (mode === 'disable' && (env.DB_SSL === 'true' ||
      env.PGSSLROOTCERT || env.DB_SSL_CA)) {
    throw configuration('TLS-required settings conflict with disabled TLS');
  }
  if (!['disable', 'require', 'verify-ca', 'verify-full'].includes(mode)) {
    throw configuration('TLS mode must disable TLS or verify certificates');
  }
  if ([...url.searchParams.keys()].some(
      (name) => name !== 'sslmode' && isUrlTlsKey(name))) {
    throw configuration('Use PGSSLROOTCERT for TLS and remove URL SSL options');
  }
  url.searchParams.delete('sslmode');
  const ssl = mode === 'disable' ? false : {rejectUnauthorized: true};
  if (ssl && env.PGSSLROOTCERT) {
    ssl.ca = readFileSync(env.PGSSLROOTCERT, 'utf8');
  } else if (ssl && env.DB_SSL_CA) {
    ssl.ca = env.DB_SSL_CA;
  }
  return {
    connectionString: url.toString(), ssl,
    connectionTimeoutMillis: positiveInteger(env.DB_CONNECT_TIMEOUT_MS, 3000,
        60000),
    statementTimeoutMillis: positiveInteger(env.DB_STATEMENT_TIMEOUT_MS, 5000,
        60000),
    max: positiveInteger(env.DB_POOL_MAX, 5, 100),
  };
}

module.exports = {isUrlTlsKey, postgresOptionsFromEnv};
