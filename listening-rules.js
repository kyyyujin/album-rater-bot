/* Phase 2 listening rules. They consume only the server-maintained ledger. */
'use strict';

const LEVELS = { on_repeat:[25,100,250], dedicated:[100,500,1500] };
const DEFINITIONS = [
  {key:'on_repeat',title:'On Repeat',category:'Listening',rarity:'Common',maxLevel:3,ruleVersion:1,metadata:{levelRarities:['Common','Rare','Epic']}},
  {key:'dedicated',title:'Dedicated',category:'Listening',rarity:'Rare',maxLevel:3,ruleVersion:1,metadata:{levelRarities:['Rare','Epic','Legendary']}},
  {key:'hyperfixation',title:'Hyperfixation',category:'Listening',rarity:'Epic',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'lucid_dream',title:'Lucid Dream',category:'Listening',rarity:'Rare',maxLevel:1,ruleVersion:1,metadata:{}},
  {key:'magnetic',title:'Magnetic',category:'Listening',rarity:'Rare',maxLevel:1,ruleVersion:1,metadata:{}},
  // Track identity deliberately remains inactive until a future phase can
  // prove MusicBrainz recording identity without title-only matching.
  {key:'i_cant_stop_me',title:"I CAN'T STOP ME",category:'Listening',rarity:'Epic',maxLevel:1,ruleVersion:1,enabled:false,metadata:{}}
];

function nextProgress(levels, value) {
  const currentLevel=levels.filter(level=>value>=level).length;
  return {currentLevel,currentValue:value,targetValue:levels[Math.min(currentLevel,levels.length-1)]};
}
function candidate(key,level,snapshot) { return {key,level,snapshot}; }
function localDayStamp(value) { return typeof value==='string' ? value.slice(0,10) : ''; }
function daysBetween(a,b) { return Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000); }

function maxConsecutive(days) {
  const unique=[...new Set((days||[]).map(localDayStamp).filter(Boolean))].sort();
  let best=[],run=[];
  for(const day of unique) {
    if(!run.length || daysBetween(run.at(-1),day)===1) run.push(day);
    else run=[day];
    if(run.length>best.length) best=[...run];
  }
  return best;
}

function evaluate(input={}) {
  const candidates=[],progress=[];
  const releases=(input.releaseGroups||[]).filter(x=>x?.release_group_id&&Number.isFinite(Number(x.scrobble_count)));
  const artists=(input.artists||[]).filter(x=>x?.artist_id&&Number.isFinite(Number(x.scrobble_count)));
  const highestRelease=releases.reduce((best,row)=>!best||Number(row.scrobble_count)>Number(best.scrobble_count)?row:best,null);
  const highestArtist=artists.reduce((best,row)=>!best||Number(row.scrobble_count)>Number(best.scrobble_count)?row:best,null);
  progress.push({key:'on_repeat',...(nextProgress(LEVELS.on_repeat,Number(highestRelease?.scrobble_count||0)))});
  progress.push({key:'dedicated',...(nextProgress(LEVELS.dedicated,Number(highestArtist?.scrobble_count||0)))});
  for(const row of releases) {
    const count=Number(row.scrobble_count);
    LEVELS.on_repeat.forEach((needed,index)=>{ if(count>=needed) candidates.push(candidate('on_repeat',index+1,{release_group:{id:row.release_group_id,mbid:row.musicbrainz_release_group_mbid||null,title:row.display_title||'',artist:row.artist_name||'',artwork:row.artwork||null},scrobbles:count,level:index+1})); });
  }
  for(const row of artists) {
    const count=Number(row.scrobble_count);
    LEVELS.dedicated.forEach((needed,index)=>{ if(count>=needed) candidates.push(candidate('dedicated',index+1,{artist:{id:row.artist_id,mbid:row.musicbrainz_artist_mbid||null,name:row.display_name||''},scrobbles:count,level:index+1})); });
  }
  const hyper=input.hyperfixation;
  if(hyper) {
    const total=Number(hyper.total||0), album=Number(hyper.album_count||0), coverage=Number(hyper.coverage||0), share=total?album/total:0;
    progress.push({key:'hyperfixation',currentLevel:0,currentValue:album,targetValue:20});
    if(coverage>=.9&&total>=50&&album>=20&&share>=.35) candidates.push(candidate('hyperfixation',1,{release_group:hyper.release_group,window_start:hyper.window_start,window_end:hyper.window_end,total_scrobbles:total,album_scrobbles:album,share:Math.round(share*10000)/100,coverage:Math.round(coverage*10000)/100}));
  }
  const lucid=input.lucidDream || {scrobbles:0,days:[]};
  const lucidTotal=Number(lucid.scrobbles||0), lucidDays=[...new Set(lucid.days||[])].length;
  progress.push({key:'lucid_dream',currentLevel:0,currentValue:lucidTotal,targetValue:100});
  if(lucidTotal>=100&&lucidDays>=15) candidates.push(candidate('lucid_dream',1,{night_scrobbles:lucidTotal,local_days:lucidDays,hours:'00:00–04:59'}));
  const magnetic=(input.magnetic||[]).map(row=>({...row,streak:maxConsecutive(row.days)}));
  const strongest=magnetic.reduce((best,row)=>!best||row.streak.length>best.streak.length?row:best,null);
  progress.push({key:'magnetic',currentLevel:0,currentValue:strongest?.streak.length||0,targetValue:7});
  for(const row of magnetic) if(row.streak.length>=7&&Number(row.streak_scrobbles||0)>=14) candidates.push(candidate('magnetic',1,{release_group:{id:row.release_group_id,mbid:row.musicbrainz_release_group_mbid||null,title:row.display_title||'',artist:row.artist_name||'',artwork:row.artwork||null},local_days:row.streak,streak_scrobbles:Number(row.streak_scrobbles),streak_length:row.streak.length}));
  return {candidates,progress};
}

module.exports={DEFINITIONS,LEVELS,nextProgress,maxConsecutive,evaluate};
