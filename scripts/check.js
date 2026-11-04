const {readdirSync} = require('node:fs');
const {join} = require('node:path');
const {spawnSync} = require('node:child_process');

function check(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      check(path);
    } else if (path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], {
        stdio: 'inherit',
      });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}

for (const directory of ['src', 'packages', 'scripts', 'test']) check(directory);
