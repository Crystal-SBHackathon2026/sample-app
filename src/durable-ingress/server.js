const {createClient} = require('redis');
const {createIngress} = require('./service');

async function main() {
  const targets = JSON.parse(process.env.INGRESS_TARGETS || '{}');
  for (const target of Object.values(targets)) {
    if (target.token_env) {
      target.token = process.env[target.token_env];
      if (!target.token) throw new Error('Missing target token');
    }
  }
  const redis = createClient({url: process.env.REDIS_URL,
    disableOfflineQueue: true, socket: {connectTimeout: 3000}});
  redis.on('error', () => {});
  await redis.connect();
  const app = await createIngress({redis, targets});
  const api = app.api.listen(8080, '0.0.0.0');
  const control = app.control.listen(9092, '127.0.0.1');
  process.once('SIGTERM', async () => {
    api.close(); control.close(); await app.close(); await redis.quit();
  });
}
main().catch(() => { console.error('INGRESS_START_FAILED'); process.exit(1); });
