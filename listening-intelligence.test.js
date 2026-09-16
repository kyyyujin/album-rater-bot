'use strict';
const assert = require('assert');
const Intelligence = require('./listening-intelligence');

const recording = (id, title, length = 180000) => ({ id, title, length });
const release = (overrides = {}) => ({ id: overrides.id || 'release-main', title: overrides.title || 'Album', status: overrides.status || 'Official', date: overrides.date || '2020-01-01', media: overrides.media || [{ position: 1, format: 'Digital Media', tracks: Array.from({ length: 8 }, (_, i) => ({ id: `rt-${i + 1}`, position: i + 1, title: `Track ${i + 1}`, length: 240000, recording: recording(`rec-${i + 1}`, `Track ${i + 1}`, 240000) })) }] });

const selected = Intelligence.chooseRepresentativeRelease([
  release({ id: 'deluxe', title: 'Album (Deluxe)', date: '2021-01-01' }),
  release({ id: 'vinyl', media: [{ position: 1, format: '12" Vinyl', tracks: release().media[0].tracks }] }),
  release({ id: 'main' })
], { title: 'Album', first_release_date: '2020-01-01' });
assert.equal(selected.release.id, 'main', 'main original digital release wins deterministically over deluxe and vinyl');

let list = Intelligence.flattenReleaseTracklist(release());
assert.equal(list.status, 'complete'); assert.equal(list.tracks.length, 8); assert.equal(list.total_duration_ms, 1920000);
const partial = release({ media: [{ position: 1, format: 'CD', tracks: [{ position: 1, title: 'Missing recording' }] }] });
assert.equal(Intelligence.flattenReleaseTracklist(partial).status, 'partial', 'malformed tracklist is partial');
assert.equal(Intelligence.flattenReleaseTracklist({ id: 'empty', media: [] }).status, 'unavailable');
const multi = release({ media: [{ position: 1, format: 'CD', tracks: release().media[0].tracks.slice(0, 4) }, { position: 2, format: 'CD', tracks: release().media[0].tracks.slice(4).map((x, i) => ({ ...x, position: i + 1 })) }] });
assert.equal(Intelligence.flattenReleaseTracklist(multi).tracks.at(-1).absolute_position, 8, 'multi-disc order is absolute and stable');
assert.equal(Intelligence.exactReleaseTrackMatch('Track 2', list.tracks).status, 'resolved');
assert.equal(Intelligence.exactReleaseTrackMatch('Missing', list.tracks).status, 'unresolved');
assert.equal(Intelligence.exactReleaseTrackMatch('Track 2', list.tracks).track.recording_mbid, Intelligence.exactReleaseTrackMatch('Track 2', list.tracks).track.recording_mbid, 'same Recording MBID is stable identity');
const otherArtistRelease = Intelligence.flattenReleaseTracklist(release({ id:'other-release', media:[{position:1,format:'Digital Media',tracks:[{id:'other-track',position:1,title:'Track 2',length:180000,recording:recording('other-artist-recording','Track 2')}]}] }));
assert.notEqual(Intelligence.exactReleaseTrackMatch('Track 2', list.tracks).track.recording_mbid, Intelligence.exactReleaseTrackMatch('Track 2', otherArtistRelease.tracks).track.recording_mbid, 'same title on another canonical release does not merge artists/recordings');
const duplicateTitles = [...list.tracks, { ...list.tracks[0], track_mbid: 'other', recording_mbid: 'other' }];
assert.equal(Intelligence.exactReleaseTrackMatch('Track 1', duplicateTitles).status, 'ambiguous', 'same title with multiple recordings never merges');

const start = Date.parse('2026-09-15T00:00:00Z');
const rows = list.tracks.map((t, i) => ({ id: `s${i + 1}`, track_id: t.recording_mbid, release_group_id: 'rg', representative_position: i + 1, duration_ms: t.duration_ms, played_at: new Date(start + (i + 1) * 240000).toISOString(), local_date: '2026-09-14' }));
const tracklists = { rg: { ...list, release_id: 'main' } };
let runs = Intelligence.detectAlbumRuns(rows, tracklists, []);
assert.equal(runs.length, 1); assert(runs[0].qualifies_dash, 'ordered 8-track/32-minute run within 110% is DASH');
const withForeign = [...rows.slice(0, 3), { id: 'foreign', track_id: 'foreign', release_group_id: 'other', duration_ms: 180000, played_at: new Date(start + 3.5 * 240000).toISOString(), local_date: '2026-09-14' }, ...rows.slice(3)];
runs = Intelligence.detectAlbumRuns(withForeign, tracklists, []);
assert.equal(runs.length, 1); assert(!runs[0].qualifies_dash, 'one foreign track is valid Album Run but never DASH');
assert.equal(Intelligence.detectAlbumRuns(rows.slice(0, 7), tracklists, []).length, 0, 'missing track stays locked');
assert.equal(Intelligence.detectAlbumRuns([{...rows[0],representative_position:2},{...rows[1],representative_position:1},...rows.slice(2)], tracklists, []).length, 0, 'wrong order stays locked');
assert.equal(Intelligence.detectAlbumRuns(rows, { rg: { ...tracklists.rg, status: 'partial' } }, []).length, 0, 'partial tracklist stays locked');
assert.equal(Intelligence.detectAlbumRuns(rows.map(x => ({ ...x, release_group_id: null })), tracklists, []).length, 0, 'unresolved album stays locked');
assert.equal(Intelligence.detectAlbumRuns(rows, tracklists, [{ status: 'coverage_gap', coverage_start: new Date(start).toISOString(), coverage_end: new Date(start + 1000).toISOString() }]).length, 0, 'coverage gap invalidates exact run evidence');

let sessions = Intelligence.buildSessions(rows, []);
assert.equal(sessions.length, 1); assert.equal(sessions[0].identity_status, 'resolved');
assert.equal(Intelligence.buildSessions([rows[0], {...rows[1], played_at:new Date(Date.parse(rows[0].played_at)+11*60000).toISOString()}], []).length, 1, 'small projected interruption remains in the session');
sessions = Intelligence.buildSessions([...rows.slice(0, 2), { ...rows[2], played_at: new Date(start + 2 * 60 * 60 * 1000).toISOString() }], []);
assert.equal(sessions.length, 2, 'excessive interruption splits sessions');
assert.equal(Intelligence.buildSessions([rows[0], {...rows[1],release_group_id:'other'}], []).length, 1, 'an album change is retained as session evidence for sequence analysis');
assert.equal(Intelligence.detectAlbumRuns([rows[0],rows[1],rows[1],...rows.slice(2)], tracklists, []).length, 0, 'a repeated in-album track invalidates the ordered run');
assert.equal(Intelligence.buildSessions([{ ...rows[0], duration_ms: null }, rows[1]], [])[0].duration_status, 'partial', 'unknown duration is explicit');
assert.equal(Intelligence.buildSessions([{...rows[0],track_id:null},rows[1]], [])[0].identity_status, 'partial', 'an unresolved track is explicit');
assert.equal(Intelligence.buildSessions(rows, [{status:'coverage_gap',coverage_start:new Date(start).toISOString(),coverage_end:new Date(start+1000).toISOString()}])[0].coverage_status, 'gap', 'a coverage gap is preserved on the session');

const plays = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, track_id: 'recording-a', played_at: new Date(start + i * HOUR).toISOString() }));
const HOUR = 3600000;
assert.equal(Intelligence.rollingTrackWindow(plays(9)), null, '9/12h locked');
assert.equal(Intelligence.rollingTrackWindow(plays(10)).length, 10, '10/12h unlock');
assert.equal(Intelligence.rollingTrackWindow(Array.from({ length: 10 }, (_, i) => ({ id: `wide${i}`, track_id: 'recording-a', played_at: new Date(start + i * 2 * HOUR).toISOString() }))), null, '10 outside 12h locked');
assert.equal(Intelligence.rollingTrackWindow([...plays(9), plays(9)[0]]), null, 'duplicate cannot create tenth play');
assert.equal(Intelligence.rollingTrackWindow([...plays(5), ...Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, track_id: 'recording-remix', played_at: new Date(start + i * HOUR).toISOString() }))]), null, 'different versions do not merge');

console.log('PASS Phase 3A recording identity, representative tracklists, sessions, Album Run, DASH and rolling track windows');
