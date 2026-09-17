'use strict';
const assert=require('assert');
const Period=require('./period-intelligence');

assert.strictEqual(Period.weekStart('2026-09-16'),'2026-09-14');
assert.strictEqual(Period.nextMonth('2026-12-03'),'2027-01-01');
assert.strictEqual(Period.zonedDateToUtc('2026-09-16','America/Guayaquil'),'2026-09-16T05:00:00.000Z');
assert.strictEqual(Period.zonedDateToUtc('2026-03-08','America/New_York'),'2026-03-08T05:00:00.000Z');
assert.strictEqual(Period.zonedDateToUtc('2026-03-09','America/New_York'),'2026-03-09T04:00:00.000Z','DST boundary uses the real IANA offset');

const specs=Period.closedPeriodSpecs('2026-09-16T18:00:00Z','2026-10-05T06:00:00Z','America/Guayaquil');
const firstWeek=specs.find(x=>x.period_type==='week'); assert(firstWeek.initial_partial); assert.strictEqual(firstWeek.local_start,'2026-09-14');
const secondWeek=specs.filter(x=>x.period_type==='week')[1]; assert(secondWeek&&!secondWeek.initial_partial);
const firstMonth=specs.find(x=>x.period_type==='month'); assert(firstMonth.initial_partial,'the activation month is not eligible');

const snapshot=Period.buildSnapshot(secondWeek,{
  epochId:'e1',coverageRatio:.95,coverageContinuous:true,
  dailyTotals:[{local_date:secondWeek.local_start,scrobble_count:30}],
  dailyReleases:[{local_date:secondWeek.local_start,release_group_id:'g2',scrobble_count:10},{local_date:secondWeek.local_start,release_group_id:'g1',scrobble_count:20}],
  dailyArtists:[{local_date:secondWeek.local_start,artist_id:'a1',scrobble_count:22}],
  artistSegments:[{metric_key:`week:${secondWeek.local_start}`,segment:'day',artist_id:'a1',scrobble_count:20},{metric_key:`week:${secondWeek.local_start}`,segment:'night',artist_id:'a2',scrobble_count:20},{metric_key:`week:${secondWeek.local_start}`,segment:'night',artist_id:null,scrobble_count:2}],
  releaseMeta:{g1:{release_group:{id:'g1',title:'One'}}},artistMeta:{a1:{artist:{id:'a1',name:'Artist'}}}
});
assert.strictEqual(snapshot.completeness,'complete'); assert.strictEqual(snapshot.scrobble_total,30); assert.deepStrictEqual(snapshot.rankings.release_groups.map(x=>x.id),['g1','g2']);
assert.strictEqual(snapshot.coverage_continuous,true);
assert.strictEqual(snapshot.rankings.artist_segments.day[0].id,'a1'); assert.strictEqual(snapshot.rankings.artist_segments.night[0].id,'a2');
assert.strictEqual(snapshot.rankings.artist_segment_unresolved.night,2);
assert.strictEqual(Period.buildSnapshot({...secondWeek,initial_partial:true},{epochId:'e1',coverageRatio:1}).completeness,'partial');
assert.strictEqual(Period.buildSnapshot(secondWeek,{epochId:'e1',coverageRatio:.899}).completeness,'incomplete');

console.log('period-intelligence tests passed');
