const {spawnSync} = require('node:child_process');
const {readdirSync} = require('node:fs');
const files = readdirSync('test').filter((name) => name.endsWith('.test.js'))
    .map((name) => `test/${name}`);

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL must point to a disposable test database.');
  process.exit(1);
}
const initialized = spawnSync(process.execPath,
    ['packages/request-store/bin/init-db.js'], {
      env: {...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL},
      stdio: 'inherit',
    });
if (initialized.status !== 0) process.exit(initialized.status || 1);
const result = spawnSync(process.execPath, ['--test', ...files], {
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status === 0 ? 0 : result.status || 1);
