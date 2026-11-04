// The shared image can run either app or bot. Inspect PID1's command line.
const {readFileSync} = require('node:fs');
const command = readFileSync('/proc/1/cmdline', 'utf8');
const bot = command.includes('traffic-bot');
const port = bot ? process.env.BOT_METRICS_PORT || 9091 :
    process.env.PORT || 8080;
fetch(`http://127.0.0.1:${port}/healthz`, {signal: AbortSignal.timeout(2000)})
    .then((response) => { process.exitCode = response.ok ? 0 : 1; })
    .catch(() => { process.exitCode = 1; });
