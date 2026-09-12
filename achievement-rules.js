/* Phase 1 Vault achievement rules. Pure functions: the HTTP layer owns identity,
 * persistence, idempotency and snapshots; this module only evaluates facts. */
'use strict';

const LEVELS = {
  archivist: [10, 25, 50, 100, 250],
  genre_explorer: [5, 12, 20]
};

const DEFINITIONS = [
  ['the_beginning','The Beginning','Common',1], ['archivist','Archivist','Common',5],
  ['masterpiece','Masterpiece','Rare',1], ['savage','Savage','Rare',1],
  ['second_thoughts','Second Thoughts','Common',1], ['it_grew_on_me','It Grew On Me','Rare',1],
  ['what_was_i_thinking','What Was I Thinking?','Rare',1], ['antifragile','ANTIFRAGILE','Rare',3],
  ['aged_like_wine','Aged Like Wine','Epic',1], ['no_skip','No Skip','Epic',1],
  ['perfectly_balanced','Perfectly Balanced','Epic',1], ['roller_coaster','Roller Coaster','Rare',1],
  ['one_good_song','One Good Song','Rare',1], ['genre_explorer','Genre Explorer','Common',3],
  ['curator','Curator','Epic',1], ['tier_collector','Tier Collector','Epic',1], ['talk_that_talk','Talk That Talk','Epic',1]
].map(([key, title, rarity, maxLevel]) => ({ key, title, category: 'Vault', rarity, maxLevel, ruleVersion: 1 }));

function score(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
}
function tier(s) {
  s = score(s); if (s === null) return null;
  if (s === 10) return 'SS'; if (s >= 9.8) return 'S+'; if (s >= 9.4) return 'S'; if (s >= 9) return 'S−';
  if (s >= 8.9) return 'A+'; if (s >= 8.8) return 'A'; if (s >= 8.7) return 'A−'; if (s >= 8.5) return 'B+';
  if (s >= 8) return 'B−'; if (s >= 7.5) return 'C+'; return 'C−';
}
function isSMinusOrHigher(s) { return score(s) >= 9; }
function normText(v) { return String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase(); }
function genre(v) {
  const g = String(v || '').trim().replace(/\s+/g, ' ');
  if (/^k[ -]?pop$/i.test(g)) return 'K-pop';
  return g ? g.replace(/\b\w/g, c => c.toUpperCase()) : '';
}
function albumId(a) { return String(a?.id ?? a?._dbId ?? `${normText(a?.artist)}::${normText(a?.title)}`); }
function ratedAlbums(collection) { return (collection?.albums || []).filter(a => a?.status === 'listened' && score(a.score) !== null); }
function trackNumbers(a) { return Object.values(a?.trackScores || {}).map(score).filter(n => n !== null); }
function metrics(collection) {
  const albums = ratedAlbums(collection); const artists = new Map(), genres = new Set(), decades = new Set(), tiers = new Set();
  albums.forEach(a => {
    const artist = normText(a.artist); if (artist) artists.set(artist, (artists.get(artist) || 0) + 1);
    (Array.isArray(a.genres) ? a.genres : String(a.genre || '').split(/[,/]/)).map(genre).filter(Boolean).forEach(g => genres.add(g));
    const y = Number(a.year); if (Number.isInteger(y) && y >= 1900 && y <= 2099) decades.add(Math.floor(y / 10) * 10);
    tiers.add(tier(a.score));
  });
  return { albums, artists, genres, decades, tiers };
}
function substantialReview(text, a) {
  const plain = String(text || '').replace(/<[^>]*>|[`*_~]/g,' ').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
  const tokens = plain.match(/[\p{L}\p{N}]+/gu) || [];
  const letters = (plain.match(/\p{L}/gu) || []).length;
  const normalized = normText(plain), forbidden = [normText(a?.title), normText(a?.artist), normText(`${a?.title || ''} ${a?.artist || ''}`)].filter(Boolean);
  return letters >= 16 && tokens.length >= 3 && !forbidden.includes(normalized);
}
function eventAlbum(event, collection) {
  const p = event?.payload || {}; const id = String(p.album_id || p.album?.id || '');
  return p.album || (collection?.albums || []).find(a => albumId(a) === id) || null;
}
function candidate(key, level, snapshot, currentValue, targetValue) { return { key, level, snapshot, currentValue, targetValue }; }
function evaluate({ collection, event, priorEvents = [] }) {
  const out = []; const m = metrics(collection); const a = eventAlbum(event, collection); const s = score(a?.score); const type = event?.type;
  const total = m.albums.length;
  if (total) out.push(candidate('the_beginning', 1, { album: brief(a), score:s, tier:tier(s) }, total, 1));
  LEVELS.archivist.forEach((n,i) => { if (total >= n) out.push(candidate('archivist', i + 1, { total, album:brief(a) }, total, n)); });
  if (m.albums.some(x => score(x.score) === 10)) out.push(candidate('masterpiece', 1, { album:brief(m.albums.find(x => score(x.score) === 10)), score:10, tier:'SS' }));
  if (m.albums.some(x => score(x.score) <= 3)) out.push(candidate('savage', 1, { album:brief(m.albums.find(x => score(x.score) <= 3)), score:score(m.albums.find(x => score(x.score) <= 3).score) }));
  LEVELS.genre_explorer.forEach((n,i) => { if (m.genres.size >= n) out.push(candidate('genre_explorer', i + 1, { genres:[...m.genres].sort(), total:m.genres.size, album:brief(a) }, m.genres.size, n)); });
  const largestArtist = Math.max(0, ...m.artists.values());
  if (total >= 30 && m.artists.size >= 12 && m.genres.size >= 8 && m.decades.size >= 3 && largestArtist / total <= .25) out.push(candidate('curator', 1, { total, artists:m.artists.size, genres:m.genres.size, decades:[...m.decades].sort(), album:brief(a) }));
  if (total >= 25 && m.tiers.size >= 8) out.push(candidate('tier_collector', 1, { total, tiers:[...m.tiers], album:brief(a) }));
  (type === 'track_scores_saved' || type === 'album_rated' || type === 'album_added' || type === 'collection_baselined') && m.albums.forEach(x => {
    const tracks = trackNumbers(x); if (tracks.length < 5) return; const min = Math.min(...tracks), max = Math.max(...tracks);
    if (tracks.length >= 6 && min >= 9) out.push(candidate('no_skip', 1, { album:brief(x), min_track_score:min, track_count:tracks.length }));
    if (tracks.length >= 6 && max - min <= .25) out.push(candidate('perfectly_balanced', 1, { album:brief(x), min_track_score:min, max_track_score:max, average:score(tracks.reduce((q,n)=>q+n,0)/tracks.length), track_count:tracks.length }));
    if (tracks.length >= 6 && max - min >= 4) out.push(candidate('roller_coaster', 1, { album:brief(x), min_track_score:min, max_track_score:max, delta:score(max-min), track_count:tracks.length }));
    if (score(x.score) < 6 && tracks.length >= 5 && max >= 9) out.push(candidate('one_good_song', 1, { album:brief(x), album_score:score(x.score), best_track_score:max, track_count:tracks.length }));
  });
  if (type === 'album_rescored' && a) {
    const p = event.payload || {}, before = score(p.previous_score), after = score(p.new_score ?? a.score), delta = score(p.delta ?? (after - before));
    const base = { album:brief(a), before, after, delta, previous_at:p.previous_at || null };
    if (Math.abs(delta) >= .01) out.push(candidate('second_thoughts', 1, base));
    if (delta >= 1) out.push(candidate('it_grew_on_me', 1, base)); if (delta <= -1) out.push(candidate('what_was_i_thinking', 1, base));
    const days = p.previous_at ? Math.floor((Date.parse(event.occurred_at) - Date.parse(p.previous_at)) / 86400000) : 0;
    if (delta >= 1 && days >= 180) out.push(candidate('aged_like_wine', 1, { ...base, days }));
    const same = priorEvents.filter(e => e.type === 'album_rescored' && String(e.payload?.album_id) === albumId(a)).concat(event).sort((x,y) => Date.parse(x.occurred_at)-Date.parse(y.occurred_at));
    const positive = same.filter(e => score(e.payload?.delta) >= .25);
    const separated = positive.filter((e,i) => !i || Date.parse(e.occurred_at)-Date.parse(positive[i-1].occurred_at) >= 14*86400000);
    const initial = priorEvents.concat(event).filter(e => e.type === 'album_rated' && String(e.payload?.album_id) === albumId(a)).sort((x,y)=>Date.parse(x.occurred_at)-Date.parse(y.occurred_at))[0];
    const initialScore = score(initial?.payload?.score ?? initial?.payload?.album?.score ?? before);
    const gain = initialScore === null ? 0 : score(after-initialScore);
    if (separated.length >= 2 && gain >= .5) out.push(candidate('antifragile', 1, { ...base, timeline: same.map(e => ({ at:e.occurred_at, before:score(e.payload?.previous_score), after:score(e.payload?.new_score), delta:score(e.payload?.delta) })), total_gain:gain }));
    if (separated.length >= 3 && gain >= 1) out.push(candidate('antifragile', 2, { ...base, timeline: same.map(e => ({ at:e.occurred_at, before:score(e.payload?.previous_score), after:score(e.payload?.new_score), delta:score(e.payload?.delta) })), total_gain:gain }));
    if (separated.length >= 3 && gain >= 1 && isSMinusOrHigher(after)) out.push(candidate('antifragile', 3, { ...base, total_gain:gain, tier:tier(after), timeline: same.map(e => ({ at:e.occurred_at, before:score(e.payload?.previous_score), after:score(e.payload?.new_score), delta:score(e.payload?.delta) })) }));
    const review = priorEvents.filter(e => e.type === 'review_written' && String(e.payload?.album_id) === albumId(a) && e.payload?.substantial && Date.parse(event.occurred_at)-Date.parse(e.occurred_at) >= 30*86400000).sort((x,y)=>Date.parse(y.occurred_at)-Date.parse(x.occurred_at))[0];
    if (review && Math.abs(delta) >= .75) out.push(candidate('talk_that_talk', 1, { ...base, review_at:review.occurred_at, days_since_review:Math.floor((Date.parse(event.occurred_at)-Date.parse(review.occurred_at))/86400000), review_excerpt:review.payload?.excerpt || null }));
  }
  return out;
}
function brief(a) { if (!a) return null; return { id:albumId(a), title:a.title || '', artist:a.artist || '', artwork:a.coverUrl || null, year:a.year || null }; }
module.exports = { DEFINITIONS, LEVELS, score, tier, normText, genre, albumId, ratedAlbums, metrics, substantialReview, evaluate, brief };
