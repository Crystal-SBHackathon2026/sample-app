// Runs a real pg TLS upgrade over an in-memory stream in its own process, so
// NODE_TLS_REJECT_UNAUTHORIZED cannot leak into other tests. No socket opens.
// Usage: node pg-tls-upgrade-probe.js [<ssl as JSON> | --from-env]
//   <ssl as JSON>: core options (omit: ssl stays unset).
//   --from-env: both pools use postgresOptionsFromEnv(process.env).
// PROBE_INITIAL_QUERY and PROBE_REPLACEMENT_QUERY append a URL query to the
// first pool and to replaceConnection respectively (core options only).
// stdout: JSON {initial, replacement}. Each value is null when TLS stays off,
// otherwise {rejectUnauthorized, ca}: the rejectUnauthorized that tls.connect
// applied after Node's environment defaults and the CA pg handed to it.
const tls = require('node:tls');
const {PassThrough} = require('node:stream');
const {Client} = require('pg');
const {
  createPostgresRequestStore, postgresOptionsFromEnv,
} = require('../../packages/request-store');

const PROBE_URL = 'postgres://probe:probe@db.invalid/demo';

function upgradedTls(poolConfig) {
  const client = new Client(poolConfig);
  if (!client.connectionParameters.ssl) return null;
  let requested;
  const connect = tls.connect;
  tls.connect = (options) => {
    requested = options;
    return connect.call(tls, options);
  };
  const {connection} = client;
  connection.stream = new PassThrough();
  try {
    connection.upgradeToSSL('db.invalid', () => {});
  } finally {
    tls.connect = connect;
  }
  const secure = connection.stream;
  // tls.connect has no public getter for the value it resolved.
  const rejectUnauthorized = secure._tlsOptions.rejectUnauthorized;
  secure.destroy();
  return {rejectUnauthorized, ca: requested.ca ?? null};
}

function coreOptions(sslJson, query) {
  const ssl = sslJson === undefined ? {} : {ssl: JSON.parse(sslJson)};
  const suffix = query ? `?${query}` : '';
  return {connectionString: `${PROBE_URL}${suffix}`, ...ssl};
}

async function main([mode]) {
  const fromEnv = mode === '--from-env';
  const initial = fromEnv ? postgresOptionsFromEnv(process.env) :
      coreOptions(mode, process.env.PROBE_INITIAL_QUERY);
  const replacement = fromEnv ? postgresOptionsFromEnv(process.env) :
      coreOptions(mode, process.env.PROBE_REPLACEMENT_QUERY);
  const configs = [];
  const store = createPostgresRequestStore({
    ...initial,
    poolFactory: (config) => {
      configs.push(config);
      return {on() {}, query: async () => ({rows: []}), end: async () => {}};
    },
  });
  await store.pauseWrites();
  await store.replaceConnection(replacement);
  await store.close();
  const [first, second] = configs.map(upgradedTls);
  process.stdout.write(JSON.stringify({initial: first, replacement: second}));
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.code || error.name}\n`);
  process.exit(1);
});
