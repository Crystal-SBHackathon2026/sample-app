const {createApp} = require('./app');

async function main() {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`sample-app listening on ${port}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    app.locals.draining = true;
    const timeout = setTimeout(() => process.exit(1), 15000);
    timeout.unref();
    server.close(async () => {
      try {
        await app.locals.close();
        clearTimeout(timeout);
      } catch { process.exitCode = 1; }
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.on('error', () => {
    console.error('HTTP server failed to start');
    process.exitCode = 1;
    stop();
  });
}

main().catch(() => {
  console.error('Invalid application configuration');
  process.exitCode = 1;
});
