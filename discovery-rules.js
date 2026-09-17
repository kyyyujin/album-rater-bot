'use strict';

const DAY = 86400000;

// Discovery definitions live exclusively in the server bundle and the private
// definitions table. The read-model trust boundary removes every locked row.
const DEFINITIONS = [
  {key:'almost_perfect',title:'Almost Perfect',category:'Discovery',rarity:'Rare',maxLevel:1,ruleVersion:1,metadata:{discovery:true,emblemEligible:false}},
  {key:'aged_like_milk',title:'Aged Like Milk',category:'Discovery',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{discovery:true,emblemEligible:false}},
  {key:'perfectly_imperfect',title:'Perfectly Imperfect',category:'Discovery',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{discovery:true,emblemEligible:false}},
  {key:'double_life',title:'Double Life',category:'Discovery',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{discovery:true,emblemEligible:false}},
  // The recovered final spec describes an album rescore while the Phase 4A
  // work prompt requires Recording identity. Until one authoritative semantic
  // exists this definition is registered, disabled and impossible to unlock.
  {key:'same_song_different_me',title:'Same Song, Different Me',category:'Discovery',rarity:'Legendary',maxLevel:1,ruleVersion:1,enabled:false,metadata:{discovery:true,emblemEligible:false,blockedBySpecAmbiguity:true}},
  {key:'love_dive',title:'LOVE DIVE',category:'Discovery',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{discovery:true,emblemEligible:false}},
  {key:'gone_but_not_forgotten',title:'Gone But Not Forgotten',category:'Discovery',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{discovery:true,emblemEligible:false}}
];

function candidate(key,snapshot) { return {key,level:1,snapshot}; }
function numeric(value) { const n=Number(value); return Number.isFinite(n)?n:null; }
function roundedHundredths(value) { const n=numeric(value); return n===null?null:Math.round((n+Number.EPSILON)*100)/100; }
function albumId(event) { return String(event?.payload?.album_id||event?.payload?.album?.id||''); }
function eventScore(event) { return numeric(event?.payload?.new_score??event?.payload?.score??event?.payload?.album?.score); }
function albumSnapshot(event) {
  const album=event?.payload?.album||{};
  return {id:albumId(event),title:String(album.title||''),artist:String(album.artist||''),cover:album.cover||album.cover_url||null};
}
function orderedAlbumScores(events,id) {
  return (events||[]).filter(event=>albumId(event)===id&&['album_rated','album_rescored'].includes(event.type))
    .map(event=>({event_id:event.event_id,type:event.type,at:event.occurred_at,score:eventScore(event)}))
    .filter(row=>row.score!==null).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
}

function evaluateVault({event,eligibleEvents=[]}={}) {
  const candidates=[];
  if(!event)return {candidates};
  const score=eventScore(event), id=albumId(event);
  if(['album_rated','album_rescored'].includes(event.type)&&roundedHundredths(score)===9.99) {
    candidates.push(candidate('almost_perfect',{album:albumSnapshot(event),score,canonical_score:9.99,event_id:event.event_id,event_type:event.type,rating_at:event.occurred_at}));
  }
  if(event.type==='album_rescored'&&id) {
    const timeline=orderedAlbumScores(eligibleEvents,id), currentIndex=timeline.findIndex(row=>row.event_id===event.event_id), previous=currentIndex>0?timeline[currentIndex-1]:null;
    const before=numeric(event.payload?.previous_score??previous?.score),after=score,elapsed=previous?Date.parse(event.occurred_at)-Date.parse(previous.at):NaN;
    if(before!==null&&after!==null&&after-before<=-1.25&&Number.isFinite(elapsed)&&elapsed>=180*DAY) {
      candidates.push(candidate('aged_like_milk',{album:albumSnapshot(event),previous_event_id:previous.event_id,rescore_event_id:event.event_id,before,after,delta:roundedHundredths(after-before),previous_score_at:previous.at,rescore_at:event.occurred_at,elapsed_days:Math.floor(elapsed/DAY)}));
    }
    const initial=timeline.find(row=>row.type==='album_rated'),rescores=timeline.filter(row=>row.type==='album_rescored');
    if(initial&&rescores.length>=3&&timeline.at(-1)?.event_id===event.event_id) {
      const values=timeline.map(row=>row.score),range=Math.max(...values)-Math.min(...values);
      if(range>=1&&Math.abs(after-initial.score)<.005) candidates.push(candidate('perfectly_imperfect',{album:albumSnapshot(event),initial_score:initial.score,final_score:after,score_change_count:rescores.length,historical_range:roundedHundredths(range),initial_event_id:initial.event_id,final_event_id:event.event_id,timeline}));
    }
  }
  return {candidates};
}

function consecutiveWeeks(rows) {
  const sorted=[...(rows||[])].sort((a,b)=>String(a.local_start).localeCompare(String(b.local_start)));
  const windows=[];
  for(let i=0;i+5<sorted.length;i+=1) {
    const slice=sorted.slice(i,i+6); let valid=true;
    for(let j=1;j<slice.length;j+=1) if(Date.parse(`${slice[j].local_start}T00:00:00Z`)-Date.parse(`${slice[j-1].local_start}T00:00:00Z`)!==7*DAY)valid=false;
    if(valid&&new Set(slice.map(x=>x.epoch_id)).size===1)windows.push(slice);
  }
  return windows;
}
function uniqueLeader(rows) {
  const first=(rows||[])[0]; return first&&(rows.length===1||Number(first.count)>Number(rows[1].count))?first:null;
}
function evaluateListening(input={}) {
  const candidates=[];
  const weeks=(input.periods||[]).filter(row=>row.period_type==='week'&&row.completeness==='complete'&&row.coverage_continuous===true&&Number(row.coverage_ratio)>=.9);
  for(const window of consecutiveWeeks(weeks)) {
    const qualifying=[];
    for(const week of window) {
      const day=week.rankings?.artist_segments?.day||[],night=week.rankings?.artist_segments?.night||[];
      const dayTotal=day.reduce((n,row)=>n+Number(row.count||0),0),nightTotal=night.reduce((n,row)=>n+Number(row.count||0),0),dayLeader=uniqueLeader(day),nightLeader=uniqueLeader(night);
      const unresolved=week.rankings?.artist_segment_unresolved||{};
      if(Number(unresolved.day||0)===0&&Number(unresolved.night||0)===0&&dayTotal>=20&&nightTotal>=20&&dayLeader&&nightLeader&&String(dayLeader.id)!==String(nightLeader.id))qualifying.push({period_snapshot_id:week.id,week_start:week.local_start,week_end:week.local_end,day_total:dayTotal,night_total:nightTotal,day_leader:dayLeader,night_leader:nightLeader});
    }
    if(qualifying.length>=4) { candidates.push(candidate('double_life',{epoch_id:window[0].epoch_id,timezone:window[0].timezone,window_start:window[0].local_start,window_end:window.at(-1).local_end,period_snapshot_ids:window.map(x=>x.id),qualifying_weeks:qualifying,rule_window_weeks:6,required_qualifying_weeks:4})); break; }
  }
  for(const row of input.loveDive||[]) if(row.window_complete&&row.identity_complete&&row.coverage_continuous&&Number(row.artist_scrobbles)>=40&&Number(row.total_scrobbles)>=100&&Number(row.artist_rank)<=3) {
    candidates.push(candidate('love_dive',{epoch_id:row.epoch_id,artist:row.artist,first_artist_play:row.first_played_at,window_start:row.window_start,window_end:row.window_end,artist_scrobbles:Number(row.artist_scrobbles),total_scrobbles:Number(row.total_scrobbles),artist_rank:Number(row.artist_rank),coverage_ratio:Number(row.coverage_ratio),coverage_continuous:true,evidence_version:Number(row.evidence_version||1)}));
  }
  for(const row of input.goneReturns||[]) if(row.canonical&&row.same_epoch&&row.coverage_continuous&&Number(row.absence_days)>=180&&Number(row.return_scrobbles)>=10) {
    candidates.push(candidate('gone_but_not_forgotten',{epoch_id:row.epoch_id,release_group:row.release_group,ghosted_unlock_id:row.ghosted_unlock_id,ghosted_at:row.ghosted_at,absence_start:row.absence_start,return_started_at:row.return_started_at,return_window_end:row.return_window_end,absence_days:Number(row.absence_days),return_scrobbles:Number(row.return_scrobbles),return_scrobble_ids:row.return_scrobble_ids,coverage_ratio:Number(row.coverage_ratio),coverage_continuous:true,evidence_version:Number(row.evidence_version||1)}));
  }
  return {candidates};
}

module.exports={DAY,DEFINITIONS,roundedHundredths,orderedAlbumScores,evaluateVault,evaluateListening};
