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
  'x-ratelimit-scope': 'global',
  'x-ratelimit-global': 'true',
  'x-ratelimit-bucket': 'message-bucket'
}), { retry_after: 9, global: true });
assert.strictEqual(rateLimited.status, 429);
assert.strictEqual(rateLimited.code, 'discord_rate_limited');
assert.strictEqual(rateLimited.retry_after_seconds, 9);
assert.strictEqual(rateLimited.scope, 'global');
assert.strictEqual(rateLimited.global, true);
assert.strictEqual(rateLimited.bucket, 'message-bucket');

const unavailable = discordPostFailure(response(403), {});
assert.strictEqual(unavailable.status, 502);
assert.strictEqual(unavailable.code, 'discord_destination_unavailable');
assert(!/Discord API error/i.test(unavailable.error));

console.log('discord posting tests passed');
