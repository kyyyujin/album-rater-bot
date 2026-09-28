'use strict';

function normalizeDiscordThreadId(value) {
  const threadId = String(value || '').trim();
  return /^\d{17,20}$/.test(threadId) ? threadId : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function discordRateLimitMetadata(response, payload = {}) {
  const header = name => response?.headers?.get?.(name) || null;
  const retryAfterSeconds = numberOrNull(payload?.retry_after) ?? numberOrNull(header('retry-after'));
  const responseDate = header('date');
  const responseDateMs = Date.parse(responseDate || '');
  const blockedUntilMs = retryAfterSeconds === null
    ? null
    : (Number.isFinite(responseDateMs) ? responseDateMs : Date.now()) + retryAfterSeconds * 1000;
  return {
    retry_after_seconds: retryAfterSeconds,
    blocked_until: blockedUntilMs === null ? null : new Date(blockedUntilMs).toISOString(),
    scope: header('x-ratelimit-scope') || null,
    global: payload?.global === true || header('x-ratelimit-global') === 'true',
    bucket: header('x-ratelimit-bucket') || null,
    discord_code: numberOrNull(payload?.code),
    discord_message: typeof payload?.message === 'string' ? payload.message.slice(0, 500) : null,
    rate_limit_headers: {
      retry_after: header('retry-after'),
      limit: header('x-ratelimit-limit'),
      remaining: header('x-ratelimit-remaining'),
      reset: header('x-ratelimit-reset'),
      reset_after: header('x-ratelimit-reset-after'),
      bucket: header('x-ratelimit-bucket'),
      global: header('x-ratelimit-global'),
      scope: header('x-ratelimit-scope')
    }
  };
}

function discordPostFailure(response, payload = {}) {
  const status = Number(response?.status || 0);
  const rateLimit = discordRateLimitMetadata(response, payload);

  if (status === 429) {
    return {
      status: 429,
      error: 'Discord está limitando temporalmente los envíos. Intentá cuando Discord lo permita.',
      code: 'discord_rate_limited',
      ...rateLimit
    };
  }

  if (status === 401) {
    return { status: 502, error: 'Discord rechazó la credencial del bot.', code: 'discord_bot_unauthorized', ...rateLimit };
  }

  if (status === 403 || status === 404) {
    return { status: 502, error: 'El bot no puede publicar en el Thread configurado.', code: 'discord_destination_unavailable', ...rateLimit };
  }

  return { status: 502, error: 'Discord rechazó el envío.', code: 'discord_post_failed', ...rateLimit };
}

module.exports = {
  normalizeDiscordThreadId,
  discordRateLimitMetadata,
  discordPostFailure
};
