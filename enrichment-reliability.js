'use strict';

const RETRYABLE_TRANSPORT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
  'ENOTFOUND', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'ABORT_ERR'
]);

const CANONICAL_UNRESOLVED_REASONS = new Set([
  'musicbrainz_no_unequivocal_album_match',
  'track_not_in_verified_release',
  'missing_album',
  'missing_track_title',
  'release_group_unresolved',
  'release_without_release_group',
  'musicbrainz_not_found'
]);

function httpStatus(error) {
  const direct = Number(error?.status || error?.statusCode || error?.response?.status);
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  const match = String(error?.message || error || '').match(/MusicBrainz\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function isRetryableTransportError(error) {
  const codes = [error?.code, error?.cause?.code].filter(Boolean).map(String);
  if (codes.some(code => RETRYABLE_TRANSPORT_CODES.has(code.toUpperCase()))) return true;
  const name = String(error?.name || '').toLowerCase();
  if (name === 'aborterror' || name === 'timeouterror') return true;
  const message = String(error?.message || error || '').toLowerCase();
  return [
    'network timeout', 'network error', 'fetch failed', 'socket hang up',
    'connection reset', 'connection refused', 'getaddrinfo', 'dns',
    'request aborted', 'operation was aborted', 'request to https://musicbrainz.org/'
  ].some(fragment => message.includes(fragment));
}

function classifyEnrichmentError(error) {
  const resolution = String(error?.resolution || '').trim();
  if (resolution.startsWith('ambiguous')) {
    return { status: 'ambiguous', reason: resolution, retryable: false, category: 'canonical_ambiguous' };
  }
  if (CANONICAL_UNRESOLVED_REASONS.has(resolution)) {
    return { status: 'unresolved', reason: resolution, retryable: false, category: 'canonical_unresolved' };
  }

  const status = httpStatus(error);
  if (status === 429) {
    return { status: 'retry', reason: 'musicbrainz_rate_limited', retryable: true, category: 'external_rate_limit' };
  }
  if (status !== null && status >= 500) {
    return { status: 'retry', reason: 'musicbrainz_temporary_error', retryable: true, category: 'external_http' };
  }
  if (status === 404 || status === 410) {
    return { status: 'unresolved', reason: 'musicbrainz_not_found', retryable: false, category: 'canonical_unresolved' };
  }
  if (isRetryableTransportError(error)) {
    return { status: 'retry', reason: 'musicbrainz_transport_error', retryable: true, category: 'external_transport' };
  }
  if (error?.retry === true) {
    return { status: 'retry', reason: resolution || 'external_temporary_error', retryable: true, category: 'external_temporary' };
  }
  return { status: 'failed', reason: resolution || 'enrichment_internal_error', retryable: false, category: 'permanent_internal' };
}

function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function retryDelayMs(attempts, retryAfterMs = null) {
  const attempt = Math.max(1, Number(attempts) || 1);
  const exponential = Math.min(24 * 60 * 60 * 1000, 15 * 60 * 1000 * (2 ** Math.min(7, attempt - 1)));
  const providerDelay = Number.isFinite(Number(retryAfterMs)) ? Math.max(0, Number(retryAfterMs)) : 0;
  // Attempts never turn a transient provider failure into canonical unresolved.
  // The 24-hour cap is a recoverable cooldown, not a terminal state.
  return Math.max(exponential, providerDelay);
}

module.exports = {
  CANONICAL_UNRESOLVED_REASONS,
  RETRYABLE_TRANSPORT_CODES,
  classifyEnrichmentError,
  httpStatus,
  isRetryableTransportError,
  parseRetryAfter,
  retryDelayMs
};
