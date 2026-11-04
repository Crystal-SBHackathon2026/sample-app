const {createHash, timingSafeEqual} = require('node:crypto');

const MIN_API_TOKEN_LENGTH = 32;
/** RFC 6750 2.1 b64token: 1*( ALPHA / DIGIT / "-._~+/" ) *"=". */
const B64TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;
/** The auth scheme is case-insensitive and followed by 1*SP. */
const BEARER_PATTERN = /^Bearer(?: +(.*))?$/i;
const AUTH_REALM = 'request-api';
const CHALLENGE = `Bearer realm="${AUTH_REALM}"`;
const INVALID_TOKEN_CHALLENGE = `${CHALLENGE}, error="invalid_token"`;
const STARTUP_WARNINGS = {
  open: 'request API is unauthenticated; do not expose publicly',
  closed: 'request API auth unconfigured; ' +
      'writes and reads on /api/requests are closed',
};

/** Returns the SHA-256 digest so tokens compare at a fixed length. */
function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Returns whether a configured token is long enough and a b64token. */
function isValidApiToken(token) {
  return token.length >= MIN_API_TOKEN_LENGTH && B64TOKEN_PATTERN.test(token);
}

/**
 * Decides the request API exposure once at startup. Only the token's SHA-256
 * digest is kept; the token itself is never returned.
 * @param {!Object<string, (string|undefined)>} env
 * @return {{mode: string, tokenDigest: ?Buffer}} mode is open, enforced or
 *     closed. Unknown or invalid settings are closed, never open.
 */
function readRequestApiAuthConfig(env) {
  const policy = env.REQUEST_API_AUTH;
  const token = env.REQUEST_API_TOKEN;
  if (policy !== undefined && policy !== 'optional' &&
      policy !== 'required') {
    return {mode: 'closed', tokenDigest: null};
  }
  if (token === undefined) {
    const mode = policy === 'required' ? 'closed' : 'open';
    return {mode, tokenDigest: null};
  }
  if (!isValidApiToken(token)) {
    return {mode: 'closed', tokenDigest: null};
  }
  return {mode: 'enforced', tokenDigest: digest(token)};
}

/**
 * Returns null when the Authorization header carries the expected token,
 * otherwise the WWW-Authenticate challenge to send.
 */
function rejectionChallenge(authorization, tokenDigest) {
  const match = BEARER_PATTERN.exec(authorization || '');
  if (!match) {
    return CHALLENGE;
  }
  const token = match[1] || '';
  if (B64TOKEN_PATTERN.test(token) &&
      timingSafeEqual(digest(token), tokenDigest)) {
    return null;
  }
  return INVALID_TOKEN_CHALLENGE;
}

/**
 * Builds the guard mounted in front of the request API. It answers before
 * the write control, the body parser and the store are reached.
 * @return {{mode: string, middleware: function(*, *, function())}}
 */
function createRequestApiAuth({env, logger, metrics}) {
  const {mode, tokenDigest} = readRequestApiAuthConfig(env);
  metrics.setRequestApiAuthMode(mode);
  if (STARTUP_WARNINGS[mode]) {
    logger.warn(STARTUP_WARNINGS[mode]);
  }
  function middleware(req, res, next) {
    if (mode === 'open') {
      return next();
    }
    if (mode === 'closed') {
      metrics.countRequestApiAuthRejection('unconfigured');
      return res.status(503).json({error: {
        code: 'API_AUTH_UNCONFIGURED',
        message: 'Request API authentication is not configured',
      }});
    }
    const challenge = rejectionChallenge(req.get('authorization'),
        tokenDigest);
    if (challenge === null) {
      return next();
    }
    metrics.countRequestApiAuthRejection('unauthorized');
    res.set('WWW-Authenticate', challenge);
    return res.status(401).json({error: {
      code: 'UNAUTHORIZED', message: 'Missing or invalid API token',
    }});
  }
  return {mode, middleware};
}

module.exports = {createRequestApiAuth, readRequestApiAuthConfig};
