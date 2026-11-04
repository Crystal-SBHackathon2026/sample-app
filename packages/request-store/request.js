const FIELDS = [
  'request_id', 'run_id', 'phase', 'request_no', 'payload', 'created_at',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

class RequestStoreError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.name = 'RequestStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalid(message) {
  return new RequestStoreError('INVALID_REQUEST', message, 400);
}

function normalizeId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw invalid('request_id must be a UUID');
  }
  return id.toLowerCase();
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string') {
    throw invalid('created_at must be an ISO timestamp');
  }
  const match = value.match(TIMESTAMP);
  if (!match) {
    throw invalid('created_at requires timezone and millisecond precision');
  }
  const [, year, month, day, hour, minute, second, , zone] = match;
  const leap = Number(year) % 4 === 0 &&
      (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(year) === 0 || Number(month) < 1 || Number(month) > 12 ||
      Number(day) < 1 || Number(day) > days[Number(month) - 1] ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 ||
      Number(zone.slice(4)) > 59 ||
      (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0)))) {
    throw invalid('created_at is not a valid timestamp');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw invalid('created_at is not a valid timestamp');
  }
  return parsed.toISOString();
}

function normalizeRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !FIELDS.includes(key))) {
    throw invalid('request must contain only the six documented fields');
  }
  const result = {request_id: normalizeId(input.request_id)};
  for (const [field, max] of [['run_id', 200], ['phase', 100],
    ['payload', 65536]]) {
    const value = input[field];
    if (typeof value !== 'string' || value.includes('\0') ||
        (field === 'payload' ? Buffer.byteLength(value, 'utf8') :
        value.length) > max || (field !== 'payload' && value.length === 0)) {
      throw invalid(`${field} exceeds the documented string size limit`);
    }
    result[field] = value;
  }
  const no = input.request_no;
  if (!(typeof no === 'string' && /^-?\d+$/.test(no)) &&
      !(typeof no === 'number' && Number.isSafeInteger(no))) {
    throw invalid('request_no must be a bigint decimal string');
  }
  if (String(no).length > 21) {
    throw invalid('request_no is outside PostgreSQL bigint range');
  }
  const integer = BigInt(no);
  if (integer < -9223372036854775808n || integer > 9223372036854775807n) {
    throw invalid('request_no is outside PostgreSQL bigint range');
  }
  result.request_no = String(integer);
  result.created_at = normalizeTimestamp(input.created_at);
  return Object.fromEntries(FIELDS.map((field) => [field, result[field]]));
}

module.exports = {
  FIELDS, RequestStoreError, normalizeId, normalizeRequest,
};
