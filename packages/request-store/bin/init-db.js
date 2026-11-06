#!/usr/bin/env node
require('../init').initializeSchema().catch(() => {
  console.error('Schema initialization failed; check database access/config');
  process.exitCode = 1;
});
