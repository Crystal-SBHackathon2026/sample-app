// Read-only probe. Never writes a request or changes either application.
async function main() {
  const report = {at: new Date().toISOString(), passed: true, targets: {}};
  for (const name of ['SOURCE', 'TARGET']) {
    const base = process.env[name + '_URL'];
    const token = process.env[name + '_API_TOKEN'];
    const expectedDb = process.env[name + '_DATABASE'];
    if (!base || !expectedDb) throw new Error('URL and expected database required');
    const url = new URL(base);
    if (url.username || url.password || (token && url.protocol !== 'https:')) {
      throw new Error('unsafe URL/token transport');
    }
    const checks = {};
    for (const path of ['/readyz', '/api/info', '/api/requests/00000000-0000-0000-0000-000000000001']) {
      try {
        const r = await fetch(base.replace(/\/$/, '') + path, {
          redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: token ? {Authorization: `Bearer ${token}`} : {},
        });
        const b = await r.json().catch(() => ({}));
        const ok = path === '/readyz' ? r.status === 200 && b.status === 'ok' :
          path === '/api/info' ? r.status === 200 && b.database?.name === expectedDb &&
            b.write_control?.healthy === true &&
            (name !== 'TARGET' || (b.writes_paused === true && b.environment === 'aws')) :
          r.status === 404 && b.error?.code === 'REQUEST_NOT_FOUND';
        checks[path] = {http: r.status, passed: ok,
          ...(path === '/api/info' ? {environment: b.environment,
            database: b.database?.name, writes_paused: b.writes_paused} : {})};
        if (!ok) report.passed = false;
      } catch { checks[path] = {passed: false, error: 'TRANSPORT_FAILED'}; report.passed = false; }
    }
    report.targets[name.toLowerCase()] = checks;
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
main().catch(() => { console.error('PREFLIGHT_CONFIGURATION_ERROR'); process.exitCode = 2; });
