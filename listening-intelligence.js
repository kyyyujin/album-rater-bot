'use strict';

const VERSION = 1;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function releasePenalty(release, group = {}) {
  const title = normalize(release?.title);
  const groupTitle = normalize(group?.title);
  const date = String(release?.date || '9999-12-31');
  const first = String(group?.first_release_date || '9999-12-31');
  const format = normalize((release?.media || []).map(x => x?.format).filter(Boolean).join(' '));
  let score = release?.status === 'Official' ? 0 : 1000;
  if (title !== groupTitle) score += 100;
  if (/deluxe|expanded|anniversary|bonus|remaster|reissue/.test(title)) score += 200;
  if (/vinyl|cassette/.test(format)) score += 20;
  else if (!/digital media|cd/.test(format)) score += 10;
  if (date !== first) score += 5;
  return { score, date, id: String(release?.id || '') };
}

function chooseRepresentativeRelease(releases, group = {}) {
  const ranked = (releases || []).filter(x => x?.id).map(release => ({ release, rank: releasePenalty(release, group) }));
  ranked.sort((a, b) => a.rank.score - b.rank.score || a.rank.date.localeCompare(b.rank.date) || a.rank.id.localeCompare(b.rank.id));
  if (!ranked.length) return null;
  const winner = ranked[0];
  return {
    release: winner.release,
    evidence: {
      algorithm: 'main-project-release-v1',
      score: winner.rank.score,
      candidate_count: ranked.length,
      official: winner.release.status === 'Official',
      title_matches_group: normalize(winner.release.title) === normalize(group.title),
      date: winner.release.date || null,
      formats: (winner.release.media || []).map(x => x?.format).filter(Boolean)
    }
  };
}

function flattenReleaseTracklist(release) {
  const tracks = [];
  let absolute = 0;
  let malformed = false;
  const seenSlots = new Set();
  for (const [mediumIndex, medium] of (release?.media || []).entries()) {
    const mediumPosition = Number(medium?.position || mediumIndex + 1);
    for (const [trackIndex, track] of (medium?.tracks || []).entries()) {
      absolute += 1;
      const position = Number(track?.position || trackIndex + 1);
      const slot = `${mediumPosition}:${position}`;
      const recordingMbid = String(track?.recording?.id || '').toLowerCase();
      const trackMbid = String(track?.id || '').toLowerCase();
      if (!recordingMbid || !trackMbid || seenSlots.has(slot)) malformed = true;
      seenSlots.add(slot);
      const duration = Number(track?.length ?? track?.recording?.length);
      tracks.push({
        track_mbid: trackMbid || null,
        recording_mbid: recordingMbid || null,
        title: String(track?.title || track?.recording?.title || '').trim(),
        normalized_title: normalize(track?.title || track?.recording?.title),
        medium_position: mediumPosition,
        position,
        absolute_position: absolute,
        duration_ms: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        artist_credit: track?.['artist-credit'] || track?.recording?.['artist-credit'] || []
      });
    }
  }
  if (!tracks.length) return { status: 'unavailable', tracks: [], duration_complete: false, total_duration_ms: null };
  const status = malformed ? 'partial' : 'complete';
  const durationComplete = status === 'complete' && tracks.every(x => x.duration_ms !== null);
  return { status, tracks, duration_complete: durationComplete, total_duration_ms: durationComplete ? tracks.reduce((n, x) => n + x.duration_ms, 0) : null };
}

function exactReleaseTrackMatch(sourceTitle, tracks) {
  const title = normalize(sourceTitle);
  if (!title) return { status: 'unresolved', reason: 'missing_track_title' };
  const matches = (tracks || []).filter(x => normalize(x.title || x.display_title) === title);
  if (!matches.length) return { status: 'unresolved', reason: 'track_not_in_verified_release' };
  const recordings = new Set(matches.map(x => x.recording_mbid || x.musicbrainz_recording_mbid || x.track_id).filter(Boolean));
  if (recordings.size !== 1 || matches.length !== 1) return { status: 'ambiguous', reason: 'duplicate_title_in_release' };
  return { status: 'resolved', track: matches[0] };
}

function projectedStart(row) {
  const end = Date.parse(row.played_at);
  const duration = Number(row.duration_ms);
  return Number.isFinite(end) && Number.isFinite(duration) && duration > 0 ? end - duration : null;
}

function intersectsGap(start, end, gaps) {
  return (gaps || []).some(g => g.status !== 'covered' && Date.parse(g.coverage_end) > start && Date.parse(g.coverage_start) < end);
}

function buildSessions(scrobbles, coverage = []) {
  const rows = [...(scrobbles || [])].filter(x => Number.isFinite(Date.parse(x.played_at))).sort((a, b) => Date.parse(a.played_at) - Date.parse(b.played_at) || String(a.id).localeCompare(String(b.id)));
  const sessions = [];
  let current = null;
  for (const row of rows) {
    const end = Date.parse(row.played_at);
    const start = projectedStart(row);
    let breakSession = !current;
    if (current) {
      const previous = current.items.at(-1);
      const previousEnd = Date.parse(previous.played_at);
      const projectedSilence = start === null ? null : start - previousEnd;
      breakSession = projectedSilence === null ? end - previousEnd > 20 * MINUTE : projectedSilence > 12 * MINUTE;
    }
    if (breakSession) {
      current = { items: [], started_at: new Date(start ?? end).toISOString(), started_at_is_derived: start !== null };
      sessions.push(current);
    }
    current.items.push(row);
    current.ended_at = new Date(end).toISOString();
  }
  for (const session of sessions) {
    const start = Date.parse(session.started_at), end = Date.parse(session.ended_at);
    session.coverage_status = intersectsGap(start, end, coverage) ? 'gap' : 'covered';
    session.identity_status = session.items.every(x => x.track_id) ? 'resolved' : 'partial';
    session.duration_status = session.items.every(x => Number(x.duration_ms) > 0) ? 'complete' : 'partial';
  }
  return sessions;
}

function detectAlbumRuns(scrobbles, tracklists, coverage = []) {
  const rows = [...(scrobbles || [])].filter(x => Number.isFinite(Date.parse(x.played_at))).sort((a, b) => Date.parse(a.played_at) - Date.parse(b.played_at) || String(a.id).localeCompare(String(b.id)));
  const runs = [];
  const claimed = new Set();
  for (let startIndex = 0; startIndex < rows.length; startIndex += 1) {
    const first = rows[startIndex];
    const list = tracklists?.[first.release_group_id];
    if (!list || list.status !== 'complete' || !list.duration_complete || list.tracks.length < 5) continue;
    if (first.representative_position !== 1 || claimed.has(first.id)) continue;
    const chosen = [first];
    const foreign = [];
    let expected = 2;
    let invalid = false;
    for (let i = startIndex + 1; i < rows.length && expected <= list.tracks.length; i += 1) {
      const row = rows[i];
      if (row.release_group_id === first.release_group_id && row.representative_position === expected) {
        chosen.push(row); expected += 1; continue;
      }
      if (row.release_group_id === first.release_group_id) { invalid = true; break; }
      foreign.push(row);
      if (foreign.length > 1) { invalid = true; break; }
    }
    if (invalid || expected <= list.tracks.length) continue;
    const inferredStart = projectedStart(first);
    const end = Date.parse(chosen.at(-1).played_at);
    if (inferredStart === null || intersectsGap(inferredStart, end, coverage)) continue;
    const elapsed = end - inferredStart;
    if (elapsed > list.total_duration_ms * 1.4) continue;
    const dash = list.tracks.length >= 8 && list.total_duration_ms >= 30 * MINUTE && foreign.length === 0 && elapsed <= list.total_duration_ms * 1.1;
    const run = {
      release_group_id: first.release_group_id,
      release_id: list.release_id,
      local_date: first.local_date,
      started_at: new Date(inferredStart).toISOString(),
      ended_at: new Date(end).toISOString(),
      elapsed_ms: elapsed,
      total_duration_ms: list.total_duration_ms,
      track_count: list.tracks.length,
      foreign_scrobble_count: foreign.length,
      scrobble_ids: chosen.map(x => x.id),
      track_timestamps: chosen.map(x => ({ track_id: x.track_id, position: x.representative_position, played_at: x.played_at })),
      inferred_start: true,
      qualifies_dash: dash,
      evidence_version: VERSION
    };
    runs.push(run);
    chosen.forEach(x => claimed.add(x.id));
  }
  return runs;
}

function rollingTrackWindow(scrobbles, target = 10, windowMs = 12 * HOUR) {
  const byTrack = new Map();
  const unique = new Map();
  for (const row of scrobbles || []) if (row?.id && row?.track_id && Number.isFinite(Date.parse(row.played_at))) unique.set(row.id, row);
  for (const row of unique.values()) {
    if (!byTrack.has(row.track_id)) byTrack.set(row.track_id, []);
    byTrack.get(row.track_id).push(row);
  }
  for (const rows of byTrack.values()) {
    rows.sort((a, b) => Date.parse(a.played_at) - Date.parse(b.played_at));
    let left = 0;
    for (let right = 0; right < rows.length; right += 1) {
      while (Date.parse(rows[right].played_at) - Date.parse(rows[left].played_at) > windowMs) left += 1;
      if (right - left + 1 >= target) return rows.slice(left, left + target);
    }
  }
  return null;
}

module.exports = { VERSION, normalize, chooseRepresentativeRelease, flattenReleaseTracklist, exactReleaseTrackMatch, buildSessions, detectAlbumRuns, rollingTrackWindow };
