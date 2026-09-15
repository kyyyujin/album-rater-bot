'use strict';

function normalizeIanaTimezone(value, fallback = 'UTC') {
  const candidate = String(value || fallback).trim();
  if (!candidate) throw new RangeError('Timezone is required');
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: candidate });
  return formatter.resolvedOptions().timeZone;
}

function localListeningParts(playedAt, timezone) {
  const date = new Date(playedAt);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid listening timestamp');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeIanaTimezone(timezone),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const out = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { local_date: `${out.year}-${out.month}-${out.day}`, local_hour: Number(out.hour) };
}

module.exports = { normalizeIanaTimezone, localListeningParts };
