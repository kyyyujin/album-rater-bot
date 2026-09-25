'use strict';

const DAY=86400000;
const DEFINITIONS=[
  {key:'comfort_album',title:'Comfort Album',category:'Listening',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'night_shift',title:'Night Shift',category:'Listening',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'all_roads_lead_to',title:'All Roads Lead To…',category:'Listening',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'time_traveler',title:'Time Traveler',category:'Listening',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'from_dusk_till_dawn',title:'From Dusk Till Dawn',category:'Listening',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'lost_and_found',title:'Lost and Found',category:'Listening',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'my_world',title:'My World',category:'Listening',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{}}
];
const candidate=(key,snapshot)=>({key,level:1,snapshot});
const release=row=>row.release_group||{id:row.release_group_id,mbid:row.musicbrainz_release_group_mbid||null,title:row.display_title||'',artist:row.artist_name||''};
const artist=row=>row.artist||{id:row.artist_id,mbid:row.musicbrainz_artist_mbid||null,name:row.display_name||''};

function comfortAlbum(periods=[]) {
  const months=periods.filter(p=>p.period_type==='month'&&p.completeness==='complete'&&p.coverage_continuous!==false), byRelease=new Map();
  for(const p of months)for(const row of p.rankings?.release_groups||[])if(Number(row.rank)<=5&&Number(row.count)>=15){if(!byRelease.has(row.id))byRelease.set(row.id,[]);byRelease.get(row.id).push({period_snapshot_id:p.id,local_start:p.local_start,local_end:p.local_end,rank:Number(row.rank),scrobbles:Number(row.count),release_group:row.release_group});}
  const hit=[...byRelease].map(([id,items])=>({id,items})).filter(x=>new Set(x.items.map(y=>y.local_start)).size>=3).sort((a,b)=>a.items[2].local_end.localeCompare(b.items[2].local_end))[0];
  return hit?candidate('comfort_album',{release_group:hit.items[0].release_group||{id:hit.id},months:hit.items.slice(0,3),distinct_months:new Set(hit.items.map(x=>x.local_start)).size,evidence_version:1}):null;
}
function nightShift(rows=[]) { const hit=rows.find(row=>row.identity_complete&&row.coverage_continuous&&Number(row.night_scrobbles)>=45&&Number(row.total_scrobbles)>=60); return hit?candidate('night_shift',{artist:artist(hit),window_start:hit.window_start,window_end:hit.window_end,night_scrobbles:Number(hit.night_scrobbles),total_scrobbles:Number(hit.total_scrobbles),local_hours:'00:00–04:59',epoch_id:hit.epoch_id,evidence_version:1}):null; }
function allRoads(rows=[]) { const hit=rows.find(row=>row.identity_complete&&row.coverage_continuous&&Number(row.total_scrobbles)>=150&&Number(row.artist_scrobbles)/Number(row.total_scrobbles)>=.5); return hit?candidate('all_roads_lead_to',{artist:artist(hit),window_start:hit.window_start,window_end:hit.window_end,artist_scrobbles:Number(hit.artist_scrobbles),total_scrobbles:Number(hit.total_scrobbles),share:Number((Number(hit.artist_scrobbles)/Number(hit.total_scrobbles)).toFixed(4)),epoch_id:hit.epoch_id,evidence_version:1}):null; }
function timeTraveler(row) { if(!row?.identity_complete||!row.coverage_continuous)return null; const decades=Object.entries(row.decade_tracks||{}).filter(([,tracks])=>new Set(tracks).size>=3); return decades.length>=5?candidate('time_traveler',{window_start:row.window_start,window_end:row.window_end,decades:Object.fromEntries(decades.map(([d,t])=>[d,[...new Set(t)].slice(0,20)])),distinct_decades:decades.length,epoch_id:row.epoch_id,evidence_version:1}):null; }
function fromDusk(row) { if(!row?.coverage_continuous)return null; const hours=Array.from({length:24},(_,hour)=>Number(row.hour_counts?.[hour]||row.hour_counts?.[String(hour)]||0)); return hours.every(n=>n>=3)?candidate('from_dusk_till_dawn',{window_start:row.window_start,window_end:row.window_end,hour_counts:hours,timezone:row.timezone,epoch_id:row.epoch_id,evidence_version:1}):null; }
function lostAndFound(rows=[]) { const hit=rows.find(row=>row.same_epoch&&row.identity_complete&&row.coverage_at_previous&&row.coverage_at_return&&Number(row.gap_days)>=365); return hit?candidate('lost_and_found',{release_group:release(hit),previous_scrobble_id:hit.previous_scrobble_id,previous_played_at:hit.previous_played_at,return_scrobble_id:hit.return_scrobble_id,return_played_at:hit.return_played_at,gap_days:Number(hit.gap_days),epoch_id:hit.epoch_id,endpoint_coverage:{previous:true,return:true},evidence_version:1}):null; }
function myWorld(periods=[]) {
  const weeks=periods.filter(p=>p.period_type==='week'&&p.completeness==='complete'&&p.coverage_continuous!==false).sort((a,b)=>a.local_start.localeCompare(b.local_start)); let run=[];
  for(const p of weeks){const top=(p.rankings?.artists||[]).find(x=>Number(x.rank)===1), valid=top&&Number(p.scrobble_total)>=25&&Number(top.count)>=8; if(valid&&run.length&&top.id===run[0].artist.id&&Date.parse(`${p.local_start}T00:00:00Z`)-Date.parse(`${run.at(-1).local_start}T00:00:00Z`)===7*DAY)run.push({period_snapshot_id:p.id,local_start:p.local_start,local_end:p.local_end,artist:top.artist||{id:top.id},artist_scrobbles:Number(top.count),total_scrobbles:Number(p.scrobble_total)}); else run=valid?[{period_snapshot_id:p.id,local_start:p.local_start,local_end:p.local_end,artist:top.artist||{id:top.id},artist_scrobbles:Number(top.count),total_scrobbles:Number(p.scrobble_total)}]:[]; if(run.length>=6)return candidate('my_world',{artist:run[0].artist,weeks:run.slice(0,6),consecutive_weeks:6,evidence_version:1});}
  return null;
}
function evaluate(input={}) { const candidates=[comfortAlbum(input.periods),nightShift(input.nightShift),allRoads(input.allRoads),timeTraveler(input.timeTraveler),fromDusk(input.fromDusk),lostAndFound(input.lostAndFound),myWorld(input.periods)].filter(Boolean); return {candidates,progress:[]}; }

module.exports={DAY,DEFINITIONS,comfortAlbum,nightShift,allRoads,timeTraveler,fromDusk,lostAndFound,myWorld,evaluate};
