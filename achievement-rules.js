/* Canonical Vault rules. Only durable events after achievement tracking begins count. */
'use strict';

const LEVELS = { archivist:[10,25,50,100,250], genre_explorer:[5,12,20], artist_archivist:[3,7,15] };
const DEFINITION_ROWS = [
  ['the_beginning','The Beginning','Common',1], ['archivist','Archivist','Common',5],
  ['masterpiece','Masterpiece','Rare',1], ['savage','Savage','Rare',1],
  ['second_thoughts','Second Thoughts','Common',1], ['it_grew_on_me','It Grew On Me','Rare',1],
  ['what_was_i_thinking','What Was I Thinking?','Rare',1], ['antifragile','ANTIFRAGILE','Rare',3],
  ['aged_like_wine','Aged Like Wine','Epic',1], ['no_skip','No Skip','Epic',1],
  ['perfectly_balanced','Perfectly Balanced','Epic',1], ['roller_coaster','Roller Coaster','Rare',1],
  ['one_good_song','One Good Song','Rare',1], ['genre_explorer','Genre Explorer','Common',3],
  ['curator','Curator','Epic',1], ['tier_collector','Tier Collector','Epic',1],
  ['talk_that_talk','Talk That Talk','Epic',1],
  ['generational_run','Generational Run','Legendary',1], ['icon','ICON','Epic',1],
  ['artist_archivist','Artist Archivist','Rare',3]
];
const DEFINITION_META = {
  archivist:{levelRarities:['Common','Rare','Epic','Legendary','Mythic']},
  genre_explorer:{levelRarities:['Common','Rare','Epic']},
  antifragile:{levelRarities:['Rare','Epic','Legendary']},
  artist_archivist:{levelRarities:['Rare','Epic','Legendary'],dynamicTitle:true}
};
const DEFINITIONS = DEFINITION_ROWS.map(([key,title,rarity,maxLevel]) => ({
  key,title,category:'Vault',rarity,maxLevel,
  ruleVersion:['generational_run','icon','artist_archivist'].includes(key)?2:1,
  metadata:DEFINITION_META[key] || {}
}));

function score(v){ const n=Number(v); return Number.isFinite(n) ? Math.round((n+Number.EPSILON)*100)/100 : null; }
function tier(s){ s=score(s); if(s===null)return null; if(s===10)return'SS'; if(s>=9.8)return'S+'; if(s>=9.4)return'S'; if(s>=9)return'S−'; if(s>=8.9)return'A+'; if(s>=8.8)return'A'; if(s>=8.7)return'A−'; if(s>=8.5)return'B+'; if(s>=8)return'B−'; if(s>=7.5)return'C+'; return'C−'; }
function normText(v){ return String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase(); }
function genre(v){ const g=String(v||'').trim().replace(/\s+/g,' '); if(/^k[ -]?pop$/i.test(g))return'K-pop'; return g ? g.replace(/\b\w/g,c=>c.toUpperCase()) : ''; }
function albumId(a){ return String(a?.id ?? a?._dbId ?? `${normText(a?.artist)}::${normText(a?.title)}`); }
function brief(a){ return a ? {id:albumId(a),title:a.title||'',artist:a.artist||'',artwork:a.coverUrl||null,year:a.year||null} : null; }
function eventAlbum(e){ return e?.payload?.album || null; }
function trackNumbers(a){ return Object.values(a?.trackScores||{}).map(score).filter(n=>n!==null); }
function substantialReview(text,a){ const plain=String(text||'').replace(/<[^>]*>|[`*_~]/g,' ').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(), tokens=plain.match(/[\p{L}\p{N}]+/gu)||[], letters=(plain.match(/\p{L}/gu)||[]).length, normalized=normText(plain), forbidden=[normText(a?.title),normText(a?.artist),normText(`${a?.title||''} ${a?.artist||''}`)].filter(Boolean); return letters>=16&&tokens.length>=3&&!forbidden.includes(normalized); }
function candidate(key,level,snapshot){ return {key,level,snapshot}; }
function nextProgress(levels,value){ const current=levels.filter(n=>value>=n).length; return {currentLevel:current,currentValue:value,targetValue:levels[Math.min(current,levels.length-1)]}; }
function ratedAlbums(events){ const unique=new Map(); for(const e of events){ if(e.type!=='album_rated')continue; const a=eventAlbum(e); if(a?.status==='listened'&&score(a.score)!==null)unique.set(albumId(a),a); } return [...unique.values()]; }
function metrics(events){ const albums=ratedAlbums(events),artists=new Map(),genres=new Set(),decades=new Set(),tiers=new Set(); for(const a of albums){ const artist=normText(a.artist); if(artist)artists.set(artist,(artists.get(artist)||0)+1); (Array.isArray(a.genres)?a.genres:String(a.genre||'').split(/[,/]/)).map(genre).filter(Boolean).forEach(g=>genres.add(g)); const y=Number(a.year); if(Number.isInteger(y)&&y>=1900&&y<=2099)decades.add(Math.floor(y/10)*10); tiers.add(tier(a.score)); } return {albums,artists,genres,decades,tiers}; }
function albumEvents(events,id){ return events.filter(e=>['album_rated','album_rescored'].includes(e.type)&&String(e.payload?.album_id||albumId(eventAlbum(e)))===id).sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at)); }
function eligibleAfter(events,trackingStartedAt){ const start=Date.parse(trackingStartedAt); return (events||[]).filter(e=>Number.isFinite(Date.parse(e?.occurred_at))&&Date.parse(e.occurred_at)>start); }
function eventScore(e){ return score(e?.payload?.new_score ?? e?.payload?.score ?? eventAlbum(e)?.score); }
function latestAlbumFacts(events){ const out=new Map(); for(const e of events){ if(!['album_rated','album_rescored'].includes(e.type))continue; const a=eventAlbum(e),s=eventScore(e); if(!a||s===null)continue; const id=String(e.payload?.album_id||albumId(a)),old=out.get(id); if(!old||Date.parse(e.occurred_at)>=Date.parse(old.event.occurred_at))out.set(id,{album:a,event:e,score:s}); } return out; }
function canonicalCandidates(events,identities,releaseGroups,discographies){ const latest=latestAlbumFacts(events),byGroup=new Map(),byArtist=new Map(); for(const [id,fact] of latest){ const identity=identities?.[id]; if(!identity?.release_group_id||identity.status!=='resolved')continue; const old=byGroup.get(identity.release_group_id); if(!old||Date.parse(fact.event.occurred_at)>Date.parse(old.event.occurred_at))byGroup.set(identity.release_group_id,{...fact,identity}); } for(const [groupId,fact] of byGroup){ const rg=releaseGroups?.[groupId]; if(!rg?.artist_id||!rg?.musicbrainz_release_group_mbid)continue; const item={groupId,releaseGroup:rg,...fact}; if(!byArtist.has(rg.artist_id))byArtist.set(rg.artist_id,[]); byArtist.get(rg.artist_id).push(item); } return {byArtist,discographies:discographies||{}}; }
function canonicalSnapshotGroup(item){ return {id:item.groupId,mbid:item.releaseGroup.musicbrainz_release_group_mbid,title:item.releaseGroup.display_title,first_release_date:item.releaseGroup.first_release_date,primary_type:item.releaseGroup.primary_type,score:item.score,tier:tier(item.score),album:brief(item.album)}; }
function evaluateCanonical({eligibleEvents,canonicalIdentityByAlbumId,releaseGroupsById,artistDiscographies}){
  const candidates=[],progress=[],data=canonicalCandidates(eligibleEvents,canonicalIdentityByAlbumId,releaseGroupsById,artistDiscographies);
  for(const [artistId,groups] of data.byArtist){
    const artist=groups[0].releaseGroup.artist||{id:artistId,display_name:'Artist'};
    const sorted=[...groups].sort((a,b)=>Date.parse(a.event.occurred_at)-Date.parse(b.event.occurred_at)), count=groups.length, p=nextProgress(LEVELS.artist_archivist,count);
    progress.push({key:'artist_archivist',artistId,...p});
    LEVELS.artist_archivist.forEach((needed,index)=>{ if(count>=needed){ const finisher=sorted[needed-1]||sorted.at(-1); candidates.push(candidate('artist_archivist',index+1,{canonical_artist:{id:artistId,mbid:artist.musicbrainz_artist_mbid||null,name:artist.display_name||''},level:index+1,release_group_count:count,completed_release_group:canonicalSnapshotGroup(finisher),display_title:`${artist.display_name||'Artist'} Archivist`})); } });
    const iconic=groups.filter(g=>g.score>=9); if(iconic.length>=4)candidates.push(candidate('icon',1,{canonical_artist:{id:artistId,mbid:artist.musicbrainz_artist_mbid||null,name:artist.display_name||''},release_groups:iconic.sort((a,b)=>Date.parse(a.event.occurred_at)-Date.parse(b.event.occurred_at)).slice(0,4).map(canonicalSnapshotGroup)}));
    const discography=data.discographies?.[artistId];
    if(discography?.complete&&Array.isArray(discography.release_group_ids)){ const scored=new Map(groups.map(g=>[g.groupId,g])); for(let i=0;i<=discography.release_group_ids.length-3;i++){ const trio=discography.release_group_ids.slice(i,i+3).map(id=>scored.get(id)); if(trio.every(Boolean)&&trio.every(x=>x.score>=9)){ candidates.push(candidate('generational_run',1,{canonical_artist:{id:artistId,mbid:artist.musicbrainz_artist_mbid||null,name:artist.display_name||''},release_groups:trio.map(canonicalSnapshotGroup),canonical_order_source:discography.source||'musicbrainz_discography',discography_complete_at:discography.complete_at||null})); break; } } }
  }
  return {candidates,progress};
}
function evaluate({event,eligibleEvents=[],canonicalIdentityByAlbumId={},releaseGroupsById={},artistDiscographies={}}){
  const candidates=[],progress=[],m=metrics(eligibleEvents),a=eventAlbum(event),type=event.type,archivist=nextProgress(LEVELS.archivist,m.albums.length),explorer=nextProgress(LEVELS.genre_explorer,m.genres.size);
  progress.push({key:'archivist',...archivist},{key:'genre_explorer',...explorer});
  LEVELS.archivist.forEach((n,i)=>{if(m.albums.length>=n)candidates.push(candidate('archivist',i+1,{total:m.albums.length,album:brief(a)}));});
  LEVELS.genre_explorer.forEach((n,i)=>{if(m.genres.size>=n)candidates.push(candidate('genre_explorer',i+1,{genres:[...m.genres].sort(),total:m.genres.size,album:brief(a)}));});
  const biggestArtist=Math.max(0,...m.artists.values()); if(m.albums.length>=30&&m.artists.size>=12&&m.genres.size>=8&&m.decades.size>=3&&biggestArtist/m.albums.length<=.25)candidates.push(candidate('curator',1,{total:m.albums.length,artists:m.artists.size,genres:m.genres.size,decades:[...m.decades].sort(),album:brief(a)})); if(m.albums.length>=25&&m.tiers.size>=8)candidates.push(candidate('tier_collector',1,{total:m.albums.length,tiers:[...m.tiers],album:brief(a)}));
  if(type==='album_rated'&&a){ const s=score(a.score); candidates.push(candidate('the_beginning',1,{album:brief(a),score:s,tier:tier(s)})); if(s===10)candidates.push(candidate('masterpiece',1,{album:brief(a),score:10,tier:'SS'})); if(s<=3)candidates.push(candidate('savage',1,{album:brief(a),score:s})); }
  if(type==='track_scores_saved'&&a){ const tracks=trackNumbers(a); if(tracks.length>=5){ const min=Math.min(...tracks),max=Math.max(...tracks); if(tracks.length>=6&&min>=9)candidates.push(candidate('no_skip',1,{album:brief(a),min_track_score:min,track_count:tracks.length})); if(tracks.length>=6&&max-min<=.25)candidates.push(candidate('perfectly_balanced',1,{album:brief(a),min_track_score:min,max_track_score:max,average:score(tracks.reduce((q,n)=>q+n,0)/tracks.length),track_count:tracks.length})); if(tracks.length>=6&&max-min>=4)candidates.push(candidate('roller_coaster',1,{album:brief(a),min_track_score:min,max_track_score:max,delta:score(max-min),track_count:tracks.length})); if(score(a.score)<6&&max>=9)candidates.push(candidate('one_good_song',1,{album:brief(a),album_score:score(a.score),best_track_score:max,track_count:tracks.length})); } }
  if(type==='album_rescored'&&a){ const p=event.payload||{},before=score(p.previous_score),after=score(p.new_score??a.score),delta=score(p.delta??(after-before)),id=albumId(a),timeline=albumEvents(eligibleEvents,id),previous=timeline.filter(e=>e.event_id!==event.event_id).at(-1),days=previous?Math.floor((Date.parse(event.occurred_at)-Date.parse(previous.occurred_at))/86400000):0,base={album:brief(a),before,after,delta,previous_at:previous?.occurred_at||null}; if(Math.abs(delta)>=.01)candidates.push(candidate('second_thoughts',1,base)); if(delta>=1)candidates.push(candidate('it_grew_on_me',1,base)); if(delta<=-1)candidates.push(candidate('what_was_i_thinking',1,base)); if(delta>=1&&days>=180)candidates.push(candidate('aged_like_wine',1,{...base,days})); const rescored=timeline.filter(e=>e.type==='album_rescored'),positive=rescored.filter(e=>score(e.payload?.delta)>=.25),separated=positive.filter((e,i)=>!i||Date.parse(e.occurred_at)-Date.parse(positive[i-1].occurred_at)>=14*86400000),rating=timeline.find(e=>e.type==='album_rated'),anchor=score(rating?.payload?.score??rating?.payload?.album?.score??rescored[0]?.payload?.previous_score),gain=anchor===null?0:score(after-anchor),memoryTimeline=rescored.map(e=>({at:e.occurred_at,before:score(e.payload?.previous_score),after:score(e.payload?.new_score),delta:score(e.payload?.delta)})); if(separated.length>=2&&gain>=.5)candidates.push(candidate('antifragile',1,{...base,timeline:memoryTimeline,total_gain:gain})); if(separated.length>=3&&gain>=1)candidates.push(candidate('antifragile',2,{...base,timeline:memoryTimeline,total_gain:gain})); if(separated.length>=3&&gain>=1&&after>=9)candidates.push(candidate('antifragile',3,{...base,timeline:memoryTimeline,total_gain:gain,tier:tier(after)})); const review=eligibleEvents.filter(e=>e.type==='review_written'&&String(e.payload?.album_id)===id&&e.payload?.substantial&&Date.parse(event.occurred_at)-Date.parse(e.occurred_at)>=30*86400000).sort((x,y)=>Date.parse(y.occurred_at)-Date.parse(x.occurred_at))[0]; if(review&&Math.abs(delta)>=.75)candidates.push(candidate('talk_that_talk',1,{...base,review_at:review.occurred_at,days_since_review:Math.floor((Date.parse(event.occurred_at)-Date.parse(review.occurred_at))/86400000),review_excerpt:review.payload?.excerpt||null})); }
  const canonical=evaluateCanonical({eligibleEvents,canonicalIdentityByAlbumId,releaseGroupsById,artistDiscographies});
  return {candidates:[...candidates,...canonical.candidates],progress:[...progress,...canonical.progress],artistProgress:canonical.progress.filter(p=>p.key==='artist_archivist')};
}
module.exports={DEFINITIONS,LEVELS,score,tier,normText,genre,albumId,brief,eventAlbum,trackNumbers,substantialReview,metrics,ratedAlbums,eligibleAfter,eventScore,latestAlbumFacts,canonicalCandidates,evaluate};
