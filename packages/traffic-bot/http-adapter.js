/** An HTTP failure safe to record without leaking server bodies or URLs. */
class HttpError extends Error {
  constructor(status, {retryAfterMs = 0, notCommitted = false} = {}) {
    super(`HTTP_${status}`);
    this.code = `HTTP_${status}`;
    this.status = status;
    this.terminal = status >= 400 && status < 500 &&
      ![408, 425, 429].includes(status);
    this.retryAfterMs = retryAfterMs;
    this.notCommitted = notCommitted;
    if (notCommitted) this.code = 'WRITES_PAUSED';
  }
}

/**
 * A 2xx arrived but its body was unusable. The server may still have
 * committed, so this is not terminal; the bot settles it with a GET.
 */
function afterResponseError(code) {
  const error = new Error(code);
  error.code = code;
  error.afterResponse = true;
  return error;
}

/**
 * Raw characters the URL parser rewrites (backslash becomes '/') or drops
 * (tab, CR, LF) can turn a path into '//host', and controls, spaces, '?' and
 * '#' have no place in a plain path. They are refused, never repaired.
 */
const UNSAFE_PATH_CHARACTERS = /[\\\u0000- \u007f?#]/;

/** Adapt a compatible request API to the bot's write/read interface. */
function createHttpAdapter({baseUrl, requestsPath = '/api/requests',
  headers = {}, maxResponseBytes = 512 * 1024} = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) ||
      base.username || base.password || base.search || base.hash) {
    throw new TypeError(
        'baseUrl must be HTTP(S) without credentials/query/hash');
  }
  if (typeof requestsPath !== 'string' ||
      !requestsPath.startsWith('/') || requestsPath.startsWith('//') ||
      UNSAFE_PATH_CHARACTERS.test(requestsPath)) {
    throw new TypeError('requestsPath must be an absolute URL path');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError('maxResponseBytes must be positive');
  }
  const endpoint = new URL(requestsPath.replace(/\/$/, ''), base);
  // Custom headers (for example credentials) must never reach another origin.
  if (endpoint.origin !== base.origin) {
    throw new TypeError('requestsPath must stay on the baseUrl origin');
  }

  async function invoke(method, suffix, request, {signal} = {}) {
    let response;
    try {
      response = await fetch(`${endpoint.href}${suffix}`, {
        method, signal, redirect: 'error',
        headers: {...headers, 'Content-Type': 'application/json'},
        ...(request ? {body: JSON.stringify(request)} : {}),
      });
    } catch (cause) {
      const error = new Error('HTTP_TRANSPORT_ERROR');
      error.code = 'HTTP_TRANSPORT_ERROR';
      throw error;
    }
    if (method === 'GET' && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      const value = response.headers.get('retry-after');
      let retryAfterMs = Number(value) * 1000;
      if (!Number.isFinite(retryAfterMs)) {
        retryAfterMs = Math.max(0, Date.parse(value) - Date.now()) || 0;
      }
      retryAfterMs = Math.min(Number.MAX_SAFE_INTEGER,
          Math.max(0, Math.ceil(retryAfterMs)));
      // Only the explicit pause contract proves this POST did not store data.
      // Never retain or log arbitrary error bodies from the remote service.
      let notCommitted = false;
      if (method === 'POST' && response.status === 503 && response.body) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) break;
            chunks.push(value);
          }
          if (size <= 4096) {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            notCommitted = body?.error?.code === 'WRITES_PAUSED';
          }
        } catch (error) {
          // A missing, truncated or non-JSON body is an ordinary ambiguous 503.
        } finally {
          await reader.cancel().catch(() => {});
        }
      } else {
        await response.body?.cancel();
      }
      throw new HttpError(response.status, {retryAfterMs, notCommitted});
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxResponseBytes) {
        throw afterResponseError('RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (cause) {
      throw afterResponseError('INVALID_JSON_RESPONSE');
    }
  }

  return {
    write: (request, options) => invoke('POST', '', request, options),
    read: (id, options) => invoke('GET', `/${encodeURIComponent(id)}`,
        null, options),
  };
}

module.exports = {createHttpAdapter, HttpError};
