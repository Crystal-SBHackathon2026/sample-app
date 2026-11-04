// Runs a real pg TLS upgrade over an in-memory stream in its own process, so
// NODE_TLS_REJECT_UNAUTHORIZED cannot leak into other tests. No socket opens.
// Usage: node pg-tls-upgrade-probe.js [<ssl as JSON> | --from-env |
//     --from-defaults]
//   <ssl as JSON>: core options (omit: ssl stays unset).
//   --from-env: both pools use postgresOptionsFromEnv(process.env).
//   --from-defaults: both pools omit ssl and use PROBE_DEFAULT_SSL as JSON.
// PROBE_INITIAL_QUERY and PROBE_REPLACEMENT_QUERY append a URL query to the
// first pool and to replaceConnection respectively (core options only).
// PROBE_HOST selects an IP path; PROBE_REPLACEMENT_SSL overrides only the
// replacement's JSON TLS input. Both apply to core options only.
// stdout: JSON {initial, replacement}. Each value is null when TLS stays off,
// otherwise {rejectUnauthorized, ca}: the rejectUnauthorized that tls.connect
// applied after Node's environment defaults and the CA pg handed to it.
// Each value also reports the final host and Node's identity selection.
// With PROBE_HOST, it additionally reports the requested servername or null.
const tls = require('node:tls');
const {PassThrough} = require('node:stream');
const {Client, defaults} = require('pg');
const {
  createPostgresRequestStore, postgresOptionsFromEnv,
} = require('../../packages/request-store');

const PROBE_HOST = process.env.PROBE_HOST || 'db.invalid';
const PROBE_URL = `postgres://probe:probe@${PROBE_HOST}/demo`;

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
    connection.upgradeToSSL(PROBE_HOST, () => {});
  } finally {
    tls.connect = connect;
  }
  const secure = connection.stream;
  // tls.connect has no public getter for the value it resolved.
  const rejectUnauthorized = secure._tlsOptions.rejectUnauthorized;
  secure.destroy();
  // Node 22 internal/tls/wrap.js getSessionServerIdentity precedence.
  const identityHost = requested.servername || requested.host ||
      requested.socket?._host || 'localhost';
  return {rejectUnauthorized, ca: requested.ca ?? null,
    host: requested.host ?? null, identityHost,
    ...(process.env.PROBE_HOST ?
      {servername: requested.servername ?? null} : {})};
}

function coreOptions(sslJson, query) {
  const ssl = sslJson === undefined ? {} : {ssl: JSON.parse(sslJson)};
  const suffix = query ? `?${query}` : '';
  return {connectionString: `${PROBE_URL}${suffix}`, ...ssl};
}

async function main([mode]) {
  const fromEnv = mode === '--from-env';
  const fromDefaults = mode === '--from-defaults';
  const savedSsl = defaults.ssl;
  let store;
  try {
    if (fromDefaults) {
      defaults.ssl = JSON.parse(process.env.PROBE_DEFAULT_SSL);
      mode = undefined;
    }
    const initial = fromEnv ? postgresOptionsFromEnv(process.env) :
        coreOptions(mode, process.env.PROBE_INITIAL_QUERY);
    const replacement = fromEnv ? postgresOptionsFromEnv(process.env) :
        coreOptions(process.env.PROBE_REPLACEMENT_SSL ?? mode,
            process.env.PROBE_REPLACEMENT_QUERY);
    const configs = [];
    store = createPostgresRequestStore({
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
  } finally {
    defaults.ssl = savedSsl;
    if (store) await store.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.code || error.name}\n`);
  process.exit(1);
});
