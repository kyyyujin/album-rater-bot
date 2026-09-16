'use strict';

const DAY = 86400000;

const DEFINITIONS = [
  {key:'love_at_first_listen',title:'Love at First Listen',category:'Hybrid',rarity:'Rare',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'certified_favorite',title:'Certified Favorite',category:'Hybrid',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'it_really_grew_on_me',title:'It Really Grew On Me',category:'Hybrid',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'instant_classic',title:'Instant Classic',category:'Hybrid',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'headliner',title:'Headliner',category:'Hybrid',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'soundtrack',title:'Soundtrack',category:'Hybrid',rarity:'Rare',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'contrarian',title:'Contrarian',category:'Hybrid',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'the_feels',title:'The Feels',category:'Hybrid',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'perfect_world',title:'Perfect World',category:'Hybrid',rarity:'Mythic',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'match_made_in_heaven',title:'Match Made in Heaven',category:'Hybrid',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'love_foolish',title:'LOVE FOOLISH',category:'Secret',rarity:'Epic',maxLevel:2,ruleVersion:1,metadata:{secret:true,levelRarities:['Epic','Legendary'],levelTitles:['LOVE FOOLISH','Stockholm Syndrome']}},
  {key:'paper_favorite',title:'Paper Favorite',category:'Secret',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{secret:true}},
  {key:'mixed_signals',title:'Mixed Signals',category:'Secret',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{secret:true}},
  {key:'ghosted',title:'Ghosted',category:'Secret',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{secret:true}},
  {key:'never_again',title:'Never Again',category:'Secret',rarity:'Legendary',maxLevel:1,ruleVersion:1,metadata:{secret:true}},
  {key:'till_the_end',title:'Till The End',category:'Secret',rarity:'Mythic',maxLevel:1,ruleVersion:1,metadata:{secret:true}},
  {key:'one_more_time',title:'One More Time',category:'Listening',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{secret:true}}
];

function candidate(key, level, snapshot) { return {key,level,snapshot}; }
function numeric(value) { const n=Number(value); return Number.isFinite(n)?n:null; }
function uniqueRows(rows) { const seen=new Set(); return (rows||[]).filter((row,index)=>{ const key=String(row?.id||row?.source_fingerprint||`${row?.played_at}|${row?.track_id||''}|${row?.release_group_id||''}|${index}`); if(seen.has(key))return false; seen.add(key); return true; }); }
function after(rows, at, before=null) {
  const start=Date.parse(at), end=before?Date.parse(before):Infinity;
  return uniqueRows(rows).filter(row=>{ const time=Date.parse(row.played_at); return Number.isFinite(time)&&time>start&&time<=end; });
}
function releaseSnapshot(album) {
  return {id:album.release_group?.id||album.release_group_id,mbid:album.release_group?.mbid||null,title:album.release_group?.title||'',artist:album.release_group?.artist||'',album_id:album.album_id};
}
function metric(album,key,fallbackRows=[]) { const found=album.metrics?.[key]; return found?{count:Number(found.count||0),first:found.first||null,last:found.last||null}:{count:uniqueRows(fallbackRows).length,first:fallbackRows[0]?.played_at||null,last:fallbackRows.at(-1)?.played_at||null}; }
function coverageMetric(input,key,start,end,album=null) { const found=album?.coverage_metrics?.[key]||input.period_coverage?.[key]; return found?{milliseconds:Number(found.milliseconds||0),ratio:Number(found.ratio||0),continuous:Boolean(found.continuous)}:mergedCoverage(input.coverage,input.epoch_id,start,end); }
function artistSnapshot(artist) { return {id:artist.artist?.id||artist.artist_id,mbid:artist.artist?.mbid||null,name:artist.artist?.name||''}; }
function coverageIntervals(rows, epochId, start, end) {
  return (rows||[]).filter(row=>row.epoch_id===epochId&&row.status==='covered')
    .map(row=>[Math.max(start,Date.parse(row.coverage_start)),Math.min(end,Date.parse(row.coverage_end))])
    .filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]);
}
function mergedCoverage(rows, epochId, startValue, endValue) {
  const start=Date.parse(startValue), end=Date.parse(endValue); if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return {milliseconds:0,ratio:0,continuous:false};
  const merged=[];
  for(const range of coverageIntervals(rows,epochId,start,end)) {
    const last=merged.at(-1); if(last&&range[0]<=last[1]+1) last[1]=Math.max(last[1],range[1]); else merged.push([...range]);
  }
  const milliseconds=merged.reduce((sum,[a,b])=>sum+b-a,0);
  return {milliseconds,ratio:milliseconds/(end-start),continuous:merged.length===1&&merged[0][0]<=start&&merged[0][1]>=end,segments:merged.length};
}
function days(value) { return value/DAY; }
function topRank(snapshot, kind, id) {
  const rows=snapshot?.rankings?.[kind]||[]; return rows.find(row=>String(row.id)===String(id))||null;
}
function bestRolling(input, mode) {
  const item=input?.rolling90||null; if(!item)return null;
  if(mode==='match'&&item.unique_top_artist&&item.unique_best_rated_artist&&item.top_artist_id===item.best_rated_artist_id&&item.top_artist_plays>=150&&item.best_rated_album_count>=4&&item.best_rated_mean>=8.5)return item;
  if(mode==='mixed'&&item.unique_top_artist&&item.top_artist_plays>=150&&item.top_artist_album_count>=3&&item.top_artist_rating_mean<=6.5)return item;
  return null;
}

function evaluate(input={}) {
  const now=input.now||new Date().toISOString(), nowMs=Date.parse(now), epochId=input.epoch_id;
  const candidates=[],progress=[];
  const albums=(input.albums||[]).filter(x=>x?.release_group_id&&x?.canonical===true);
  const artists=input.artists||[], periods=(input.periods||[]).filter(x=>x.completeness==='complete');
  const maxAlbumPlays=albums.reduce((n,a)=>Math.max(n,Number(a.total_scrobbles||0)),0);
  progress.push({key:'love_at_first_listen',currentLevel:0,currentValue:Math.min(maxAlbumPlays,50),targetValue:50});
  progress.push({key:'certified_favorite',currentLevel:0,currentValue:Math.min(maxAlbumPlays,250),targetValue:250});
  for(const album of albums) {
    const plays=uniqueRows(album.scrobbles), total=Number(album.total_scrobbles||plays.length||0), current=numeric(album.current_score), initial=album.initial_rating;
    const base={release_group:releaseSnapshot(album)};
    if(initial&&numeric(initial.score)>=9) {
      const fallback=after(plays,initial.at),qualifying=metric(album,'initial_after',fallback);
      if(qualifying.count>=50)candidates.push(candidate('love_at_first_listen',1,{...base,initial_score:numeric(initial.score),rated_at:initial.at,scrobbles_after_rating:qualifying.count,first_qualifying_play:qualifying.first,last_qualifying_play:qualifying.last}));
    }
    if(current!==null&&current>=9.8&&total>=250)candidates.push(candidate('certified_favorite',1,{...base,current_score:current,current_tier:album.current_tier,tracked_scrobbles:total}));
    for(const [rescoreIndex,rescore] of (album.rescores||[]).entries()) if(numeric(rescore.delta)>=1) {
      const qualifying=metric(album,`rescore_after_${rescoreIndex}`,after(plays,rescore.at)); if(qualifying.count>=100)candidates.push(candidate('it_really_grew_on_me',1,{...base,rescore_at:rescore.at,before:numeric(rescore.before),after:numeric(rescore.after),delta:numeric(rescore.delta),scrobbles_after_rescore:qualifying.count}));
    }
    if(initial&&numeric(initial.score)>=9.5) {
      const end=new Date(Date.parse(initial.at)+30*DAY).toISOString(), qualifying=metric(album,'initial_30d',after(plays,initial.at,end)), coverage=coverageMetric(input,'initial_30d',initial.at,end,album);
      if(qualifying.count>=100&&days(coverage.milliseconds)>=21)candidates.push(candidate('instant_classic',1,{...base,initial_score:numeric(initial.score),rated_at:initial.at,window_end:end,scrobbles_in_30_days:qualifying.count,covered_days:Math.round(days(coverage.milliseconds)*100)/100,epoch_id:epochId}));
    }
    const trackScores=(album.track_scores||[]).filter(x=>numeric(x.score)!==null);
    if(current!==null&&current<=6&&trackScores.length>=5) for(const track of trackScores) if(numeric(track.score)>=9.5&&track.track_id&&Number(track.scrobble_count)>=50) candidates.push(candidate('contrarian',1,{...base,album_score:current,rated_track_count:trackScores.length,track:{id:track.track_id,mbid:track.recording_mbid||null,title:track.title||''},track_score:numeric(track.score),track_scrobbles:Number(track.scrobble_count)}));
    if(initial&&numeric(initial.score)>=7&&numeric(initial.score)<=8.49) for(const [rescoreIndex,rescore] of (album.rescores||[]).entries()) if(numeric(rescore.after)>=9&&numeric(rescore.after)-numeric(initial.score)>=1) {
      const beforeRescore=metric(album,`initial_to_rescore_${rescoreIndex}`,after(plays,initial.at,rescore.at)); if(beforeRescore.count>=100)candidates.push(candidate('the_feels',1,{...base,initial_score:numeric(initial.score),initial_rating_at:initial.at,rescore_at:rescore.at,rescore_score:numeric(rescore.after),total_increase:Math.round((numeric(rescore.after)-numeric(initial.score))*100)/100,scrobbles_before_rescore:beforeRescore.count}));
    }
    if(current!==null&&current>=9.5&&trackScores.length>=6&&trackScores.every(x=>numeric(x.score)>=9)&&total>=250)candidates.push(candidate('perfect_world',1,{...base,album_score:current,track_count:trackScores.length,min_track_score:Math.min(...trackScores.map(x=>numeric(x.score))),tracked_scrobbles:total}));
    if(current!==null&&current<=6&&total>=100)candidates.push(candidate('love_foolish',1,{...base,album_score:current,tracked_scrobbles:total,display_title:'LOVE FOOLISH'}));
    if(current!==null&&current<=5&&total>=250)candidates.push(candidate('love_foolish',2,{...base,album_score:current,tracked_scrobbles:total,display_title:'Stockholm Syndrome'}));
    if(initial&&numeric(initial.score)>=9.5&&nowMs-Date.parse(initial.at)>=180*DAY) {
      const coverage=coverageMetric(input,'initial_now',initial.at,now,album), playsAfter=metric(album,'initial_after',after(plays,initial.at));
      if(days(coverage.milliseconds)>=120&&playsAfter.count<=5)candidates.push(candidate('paper_favorite',1,{...base,initial_score:numeric(initial.score),rated_at:initial.at,days_since_rating:Math.floor((nowMs-Date.parse(initial.at))/DAY),covered_days:Math.floor(days(coverage.milliseconds)),plays_after_rating:playsAfter.count,epoch_id:epochId}));
    }
    if(current!==null&&current<=3&&album.current_score_at&&nowMs-Date.parse(album.current_score_at)>=365*DAY) {
      const coverage=coverageMetric(input,'current_now',album.current_score_at,now,album), playsAfter=metric(album,'current_after',after(plays,album.current_score_at));
      if(days(coverage.milliseconds)>=180&&playsAfter.count===0)candidates.push(candidate('never_again',1,{...base,score:current,score_at:album.current_score_at,days_without_play:Math.floor((nowMs-Date.parse(album.current_score_at))/DAY),covered_days:Math.floor(days(coverage.milliseconds)),epoch_id:epochId}));
    }
  }
  for(const artist of artists) if(Number(artist.rated_release_groups)>=5&&Number(artist.total_scrobbles)>=500)candidates.push(candidate('headliner',1,{artist:artistSnapshot(artist),rated_release_groups:Number(artist.rated_release_groups),tracked_scrobbles:Number(artist.total_scrobbles),release_groups:artist.release_groups||[]}));
  const match=bestRolling(input,'match'); if(match)candidates.push(candidate('match_made_in_heaven',1,{artist:match.artist,window_start:match.window_start,window_end:match.window_end,artist_scrobbles:match.top_artist_plays,rated_albums:match.best_rated_album_count,mean_score:match.best_rated_mean,rankings_version:match.version}));
  const mixed=bestRolling(input,'mixed'); if(mixed)candidates.push(candidate('mixed_signals',1,{artist:mixed.top_artist,window_start:mixed.window_start,window_end:mixed.window_end,artist_scrobbles:mixed.top_artist_plays,rated_albums:mixed.top_artist_album_count,mean_score:mixed.top_artist_rating_mean,rankings_version:mixed.version}));
  for(const week of periods.filter(x=>x.period_type==='week'&&Number(x.scrobble_total)>=25)) {
    const leaders=(week.rankings?.release_groups||[]).filter(x=>Number(x.rank)===1),first=leaders[0]; if(leaders.length!==1)continue;
    const album=albums.find(x=>String(x.release_group_id)===String(first.id)); if(!album)continue;
    const review=(album.reviews||[]).filter(x=>Number(x.char_count)>=80&&Date.parse(x.at)<Date.parse(week.utc_end)).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
    if(review)candidates.push(candidate('soundtrack',1,{release_group:releaseSnapshot(album),review_at:review.at,review_char_count:Number(review.char_count),week_start:week.local_start,week_end:week.local_end,week_scrobbles:Number(first.count),week_total:Number(week.scrobble_total),coverage_ratio:Number(week.coverage_ratio),period_snapshot_id:week.id}));
  }
  const months=periods.filter(x=>x.period_type==='month').sort((a,b)=>String(a.local_start).localeCompare(String(b.local_start)));
  for(let i=0;i<months.length;i++) for(let j=i+2;j<months.length;j++) {
    const first=months[i],later=months[j],firstLeaders=(first.rankings?.release_groups||[]).filter(x=>Number(x.rank)===1),laterLeaders=(later.rankings?.release_groups||[]).filter(x=>Number(x.rank)===1),leader=firstLeaders[0],laterLeader=laterLeaders[0]; if(firstLeaders.length!==1||laterLeaders.length!==1||String(laterLeader?.id)!==String(leader?.id)||Number(leader.count)<20||Number(laterLeader.count)<20)continue;
    const intervening=months.slice(i+1,j); if(intervening.length&&intervening.every(m=>!m.rankings?.release_groups?.some(x=>Number(x.rank)===1&&String(x.id)===String(leader.id)))) candidates.push(candidate('one_more_time',1,{release_group:leader.release_group||{id:leader.id},first_month:first.local_start,return_month:later.local_start,first_month_scrobbles:Number(leader.count),return_month_scrobbles:Number(laterLeader.count),intervening_months:intervening.map(x=>x.local_start),period_snapshot_ids:[first.id,...intervening.map(x=>x.id),later.id]}));
  }
  for(const month of months) for(const leader of month.rankings?.release_groups||[]) if(Number(leader.count)>=80) {
    const album=albums.find(x=>String(x.release_group_id)===String(leader.id)); if(!album||nowMs-Date.parse(month.utc_end)<180*DAY)continue;
    const coverage=coverageMetric(input,`period_${month.id}_now`,month.utc_end,now), later=album.last_played_at&&Date.parse(album.last_played_at)>Date.parse(month.utc_end), totalAfter=(input.daily_totals||[]).filter(x=>String(x.local_date)>=String(month.local_end)).reduce((n,x)=>n+Number(x.scrobble_count||0),0), albumAfter=(input.daily_release_counts||[]).filter(x=>String(x.release_group_id)===String(leader.id)&&String(x.local_date)>=String(month.local_end)).reduce((n,x)=>n+Number(x.scrobble_count||0),0), other=Math.max(0,totalAfter-albumAfter);
    if(coverage.continuous&&!later&&other>=150)candidates.push(candidate('ghosted',1,{release_group:releaseSnapshot(album),peak_month:month.local_start,peak_month_scrobbles:Number(leader.count),days_without_play:Math.floor((nowMs-Date.parse(month.utc_end))/DAY),other_music_scrobbles:other,coverage_ratio:coverage.ratio,epoch_id:epochId,period_snapshot_id:month.id}));
  }
  const first60=periods.find(x=>x.period_type==='tracking_60d'); if(first60) for(const early of (first60.rankings?.release_groups||[]).filter(x=>Number(x.rank)<=5)) for(const month of months) {
    const age=(Date.parse(month.utc_start)-Date.parse(first60.utc_start))/DAY, later=month.rankings?.release_groups?.find(x=>String(x.id)===String(early.id)&&Number(x.rank)<=5);
    if(age>=330&&age<=395&&Number(early.count)>=15&&Number(later?.count)>=15)candidates.push(candidate('till_the_end',1,{release_group:early.release_group||{id:early.id},first_window_scrobbles:Number(early.count),later_month:month.local_start,later_month_scrobbles:Number(later.count),first_snapshot_id:first60.id,later_snapshot_id:month.id}));
  }
  return {candidates,progress};
}

module.exports={DEFINITIONS,DAY,uniqueRows,mergedCoverage,evaluate};
