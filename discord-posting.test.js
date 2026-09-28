'use strict';

const assert = require('assert');
const {
  normalizeDiscordThreadId,
  discordPostFailure
} = require('./discord-posting');

function response(status, headers = {}) {
  return {
    status,
    headers: { get: name => headers[String(name).toLowerCase()] || null }
  };
}

assert.strictEqual(normalizeDiscordThreadId('1315912659295666286'), '1315912659295666286');
assert.strictEqual(normalizeDiscordThreadId(' 1315912659295666286 '), '1315912659295666286');
assert.strictEqual(normalizeDiscordThreadId('abc'), null);
assert.strictEqual(normalizeDiscordThreadId('1234'), null);

const rateLimited = discordPostFailure(response(429, {
  'retry-after': '12.5',
  'date': 'Sun, 28 Sep 2026 20:00:00 GMT',
  'x-ratelimit-limit': '5',
  'x-ratelimit-remaining': '0',
  'x-ratelimit-reset': '1790625612.5',
  'x-ratelimit-reset-after': '12.5',
  'x-ratelimit-scope': 'global',
  'x-ratelimit-global': 'true',
  'x-ratelimit-bucket': 'message-bucket'
}), { retry_after: 9, global: true, code: 20029, message: 'The write action has hit the write rate limit.' });
assert.strictEqual(rateLimited.status, 429);
assert.strictEqual(rateLimited.code, 'discord_rate_limited');
assert.strictEqual(rateLimited.retry_after_seconds, 9);
assert.strictEqual(rateLimited.blocked_until, '2026-09-28T20:00:09.000Z');
assert.strictEqual(rateLimited.scope, 'global');
assert.strictEqual(rateLimited.global, true);
assert.strictEqual(rateLimited.bucket, 'message-bucket');
assert.strictEqual(rateLimited.discord_code, 20029);
assert.strictEqual(rateLimited.discord_message, 'The write action has hit the write rate limit.');
assert.deepStrictEqual(rateLimited.rate_limit_headers, {
  retry_after: '12.5',
  limit: '5',
  remaining: '0',
  reset: '1790625612.5',
  reset_after: '12.5',
  bucket: 'message-bucket',
  global: 'true',
  scope: 'global'
});

const unavailable = discordPostFailure(response(403), {});
assert.strictEqual(unavailable.status, 502);
assert.strictEqual(unavailable.code, 'discord_destination_unavailable');
assert.strictEqual(unavailable.retry_after_seconds, null);
assert.strictEqual(unavailable.blocked_until, null);
assert(!/Discord API error/i.test(unavailable.error));

console.log('discord posting tests passed');
