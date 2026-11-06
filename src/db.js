const {readFileSync} = require('node:fs');
const {
  createPostgresRequestStore,
  postgresOptionsFromEnv,
} = require('@team-ghost/request-store');

/** Build the app's store. The reusable package owns all DB behavior. */
function createStoreFromEnv(env = process.env, onObservation) {
  const databaseUrl = env.DATABASE_URL_FILE ?
      readFileSync(env.DATABASE_URL_FILE, 'utf8').trim() : env.DATABASE_URL;
  if (!databaseUrl) return null;
  return createPostgresRequestStore({
    ...postgresOptionsFromEnv({...env, DATABASE_URL: databaseUrl}),
    onObservation,
  });
}

module.exports = {createStoreFromEnv};
