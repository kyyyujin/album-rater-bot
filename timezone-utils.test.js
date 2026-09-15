'use strict';
const assert = require('assert');
const { normalizeIanaTimezone, localListeningParts } = require('./timezone-utils');

assert.equal(normalizeIanaTimezone('America/Guayaquil'), 'America/Guayaquil', 'IANA timezone persists canonically');
assert.throws(() => normalizeIanaTimezone('Guayaquil/Local'), RangeError, 'invalid timezone is rejected');

assert.deepEqual(
  localListeningParts('2026-09-15T02:30:00.000Z', 'America/Guayaquil'),
  { local_date: '2026-09-14', local_hour: 21 },
  'UTC converts to the previous local date around midnight'
);
assert.deepEqual(
  localListeningParts('2026-09-15T05:30:00.000Z', 'America/Guayaquil'),
  { local_date: '2026-09-15', local_hour: 0 },
  'UTC converts to local midnight without changing the raw instant'
);

assert.deepEqual(
  localListeningParts('2026-03-08T06:30:00.000Z', 'America/New_York'),
  { local_date: '2026-03-08', local_hour: 1 },
  'DST spring transition retains the pre-jump hour'
);
assert.deepEqual(
  localListeningParts('2026-03-08T07:30:00.000Z', 'America/New_York'),
  { local_date: '2026-03-08', local_hour: 3 },
  'DST spring transition skips local hour two'
);
assert.equal(localListeningParts('2026-11-01T05:30:00.000Z', 'America/New_York').local_hour, 1, 'DST fall first 01:30');
assert.equal(localListeningParts('2026-11-01T06:30:00.000Z', 'America/New_York').local_hour, 1, 'DST fall repeated 01:30');

console.log('PASS persistent IANA timezone, UTC-to-local midnight and DST conversion');
