// Runs a real pg TLS upgrade over an in-memory stream in its own process, so
// NODE_TLS_REJECT_UNAUTHORIZED cannot leak into other tests. No socket opens.
// Usage: node pg-tls-upgrade-probe.js [<ssl as JSON>]  (omit: ssl stays unset)
// stdout: JSON {initial, replacement}. Each value is null when TLS stays off,
// otherwise the rejectUnauthorized that tls.connect applied after Node's
// environment defaults, for the first pool and for replaceConnection.
const {PassThrough} = require('node:stream');
const {Client} = require('pg');
const {createPostgresRequestStore} = require('../../packages/request-store');

const PROBE_URL = 'postgres://probe:probe@db.invalid/demo';

function upgradedRejectUnauthorized(poolConfig) {
  const client = new Client(poolConfig);
  if (!client.connectionParameters.ssl) return null;
  const {connection} = client;
  connection.stream = new PassThrough();
  connection.upgradeToSSL('db.invalid', () => {});
  const secure = connection.stream;
  // tls.connect has no public getter for the value it resolved.
  const value = secure._tlsOptions.rejectUnauthorized;
  secure.destroy();
  return value;
}

async function main([sslJson]) {
  const sslOption = sslJson === undefined ? {} : {ssl: JSON.parse(sslJson)};
  const configs = [];
  const store = createPostgresRequestStore({
    connectionString: PROBE_URL, ...sslOption,
    poolFactory: (config) => {
      configs.push(config);
      return {on() {}, query: async () => ({rows: []}), end: async () => {}};
    },
  });
  await store.pauseWrites();
  await store.replaceConnection({connectionString: PROBE_URL, ...sslOption});
  await store.close();
  const [initial, replacement] = configs.map(upgradedRejectUnauthorized);
  process.stdout.write(JSON.stringify({initial, replacement}));
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.code || error.name}\n`);
  process.exit(1);
});
