'use strict';

function normalizeDiscordThreadId(value) {
  const threadId = String(value || '').trim();
  return /^\d{17,20}$/.test(threadId) ? threadId : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function discordRateLimitMetadata(response, payload = {}) {
  const header = name => response?.headers?.get?.(name) || null;
  const retryAfterSeconds = numberOrNull(payload?.retry_after) ?? numberOrNull(header('retry-after'));
  return {
    retry_after_seconds: retryAfterSeconds,
    scope: header('x-ratelimit-scope') || null,
    global: payload?.global === true || header('x-ratelimit-global') === 'true',
    bucket: header('x-ratelimit-bucket') || null
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
