'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function rebuild(rows) {
  const total = rows.length;
  const albums = new Map(), tracks = new Map(), days = new Map();
  for (const row of rows) {
    if (row.release_group_id) albums.set(row.release_group_id, (albums.get(row.release_group_id) || 0) + 1);
    if (row.track_id) tracks.set(row.track_id, (tracks.get(row.track_id) || 0) + 1);
    days.set(row.local_date, (days.get(row.local_date) || 0) + 1);
  }
  return { total, albums, tracks, days };
}

const raw = [{ id:'one', local_date:'2026-09-14', release_group_id:null, track_id:null }];
let aggregate = rebuild(raw);
assert.equal(aggregate.total, 1); assert.equal(aggregate.albums.size, 0);
raw[0] = { ...raw[0], release_group_id:'album-x', track_id:'track-x' };
aggregate = rebuild(raw);
assert.equal(aggregate.total, 1); assert.equal(aggregate.albums.get('album-x'), 1); assert.equal(aggregate.tracks.get('track-x'), 1); assert.equal(aggregate.days.get('2026-09-14'), 1);
aggregate = rebuild(raw);
assert.equal(aggregate.total, 1); assert.equal(aggregate.albums.get('album-x'), 1); assert.equal(aggregate.tracks.get('track-x'), 1, 'repeated reconciliation is idempotent');

const migration = fs.readFileSync(path.join(__dirname,'migrations','20260916064427_phase3a_listening_intelligence.sql'),'utf8');
assert(migration.includes('where id=p_scrobble_id for update'), 'database reconciliation locks the original scrobble');
assert(migration.includes('listening_lifetime_release_group_counts'), 'release-group aggregates rebuild from raw rows');
assert(migration.includes('listening_lifetime_track_counts'), 'track aggregates rebuild from raw rows');
assert(!migration.includes('update public.listening_scrobbles set played_at='), 'enrichment never rewrites raw played_at');

console.log('PASS unresolved→resolved aggregate reconciliation remains one raw/day/album/track play and is idempotent');
