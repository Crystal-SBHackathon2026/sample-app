#!/usr/bin/env node
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {Pool} = require('pg');
const {postgresOptionsFromEnv} = require('./config');

async function initializeSchema() {
  const {statementTimeoutMillis, ...options} = postgresOptionsFromEnv();
  const pool = new Pool({...options, statement_timeout: statementTimeoutMillis});
  pool.on('error', () => {});
  try {
    await pool.query(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
    console.log('migration_demo schema initialized');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  initializeSchema().catch(() => {
    console.error('Schema initialization failed; check database access/config');
    process.exitCode = 1;
  });
}

module.exports = {initializeSchema};
