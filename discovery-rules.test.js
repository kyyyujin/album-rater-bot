'use strict';
const assert=require('assert');
const Discovery=require('./discovery-rules');
const has=(result,key)=>result.candidates.some(row=>row.key===key);
const album={id:'album-1',title:'Example',artist:'Artist',score:9.99};
const event=(id,type,at,score,extra={})=>({event_id:id,type,occurred_at:at,payload:{album_id:album.id,album:{...album,score},new_score:score,score,...extra}});

let rated=event('r','album_rated','2026-01-01T00:00:00Z',9.99);
assert(has(Discovery.evaluateVault({event:rated,eligibleEvents:[rated]}),'almost_perfect'));
for(const score of [9.98,10]) { const row=event(`r${score}`,'album_rated','2026-01-01T00:00:00Z',score); assert(!has(Discovery.evaluateVault({event:row,eligibleEvents:[row]}),'almost_perfect')); }

const old=event('initial','album_rated','2026-01-01T00:00:00Z',9.5);
const milk=event('milk','album_rescored','2026-07-01T00:00:00Z',8.25,{previous_score:9.5,delta:-1.25});
assert(has(Discovery.evaluateVault({event:milk,eligibleEvents:[old,milk]}),'aged_like_milk'));
const tooSoon={...milk,event_id:'soon',occurred_at:'2026-06-29T00:00:00Z'};
assert(!has(Discovery.evaluateVault({event:tooSoon,eligibleEvents:[old,tooSoon]}),'aged_like_milk'));
const notEnough=event('small','album_rescored','2026-07-01T00:00:00Z',8.26,{previous_score:9.5,delta:-1.24});
assert(!has(Discovery.evaluateVault({event:notEnough,eligibleEvents:[old,notEnough]}),'aged_like_milk'));

const p0=event('p0','album_rated','2026-01-01T00:00:00Z',8);
const p1=event('p1','album_rescored','2026-02-01T00:00:00Z',9.2,{previous_score:8});
const p2=event('p2','album_rescored','2026-03-01T00:00:00Z',7.7,{previous_score:9.2});
const p3=event('p3','album_rescored','2026-04-01T00:00:00Z',8,{previous_score:7.7});
assert(has(Discovery.evaluateVault({event:p3,eligibleEvents:[p0,p1,p2,p3]}),'perfectly_imperfect'));
assert(!has(Discovery.evaluateVault({event:p2,eligibleEvents:[p0,p1,p2]}),'perfectly_imperfect'),'three score changes are required');

const artist=(id,count)=>({id,count,rank:1,artist:{id,name:id}});
const week=(index,qualifies=true)=>({id:`w${index}`,epoch_id:'e1',period_type:'week',local_start:`2026-${String(1+index).padStart(2,'0')}-05`,local_end:`2026-${String(1+index).padStart(2,'0')}-12`,timezone:'America/Guayaquil',coverage_ratio:1,coverage_continuous:true,completeness:'complete',rankings:{artist_segments:{day:[artist('day',qualifies?20:19)],night:[artist('night',20)]}}});
// Use actual consecutive ISO Mondays.
const starts=['2026-01-05','2026-01-12','2026-01-19','2026-01-26','2026-02-02','2026-02-09'];
const weeks=starts.map((start,index)=>({...week(index,index<4),local_start:start,local_end:new Date(Date.parse(`${start}T00:00:00Z`)+7*86400000).toISOString().slice(0,10)}));
assert(has(Discovery.evaluateListening({periods:weeks}),'double_life'));
assert(!has(Discovery.evaluateListening({periods:weeks.map((row,index)=>index===3?{...row,rankings:{artist_segments:{day:[artist('day',19)],night:[artist('night',20)]}}}:row)}),'double_life'));
assert(!has(Discovery.evaluateListening({periods:weeks.map((row,index)=>index<3?{...row,coverage_continuous:false}:row)}),'double_life'),'coverage gaps cannot prove a dominant artist');
const tied={...weeks[0],rankings:{artist_segments:{day:[artist('a',20),artist('b',20)],night:[artist('n',20)]}}};
assert(!has(Discovery.evaluateListening({periods:[tied,...weeks.slice(1).map((row,index)=>index<3?row:{...row,rankings:{artist_segments:{day:[artist('d',19)],night:[artist('n',20)]}}})]}),'double_life'),'a tied leader is not unique evidence');

const love={epoch_id:'e1',artist:{id:'a',name:'A'},first_played_at:'2026-01-01T00:00:00Z',window_start:'2026-01-01T00:00:00Z',window_end:'2026-01-31T00:00:00Z',window_complete:true,identity_complete:true,coverage_continuous:true,coverage_ratio:1,artist_scrobbles:40,total_scrobbles:100,artist_rank:3,evidence_version:1};
assert(has(Discovery.evaluateListening({loveDive:[love]}),'love_dive'));
for(const change of [{artist_scrobbles:39},{total_scrobbles:99},{artist_rank:4},{identity_complete:false},{coverage_continuous:false}])assert(!has(Discovery.evaluateListening({loveDive:[{...love,...change}]}),'love_dive'));

const gone={canonical:true,same_epoch:true,coverage_continuous:true,return_scrobbles:10,epoch_id:'e1',release_group:{id:'g'},ghosted_unlock_id:'u',ghosted_at:'2026-07-01T00:00:00Z',absence_start:'2026-01-01T00:00:00Z',return_started_at:'2026-07-02T00:00:00Z',return_window_end:'2026-07-16T00:00:00Z',absence_days:182,return_scrobble_ids:Array.from({length:10},(_,i)=>`s${i}`),coverage_ratio:1};
assert(has(Discovery.evaluateListening({goneReturns:[gone]}),'gone_but_not_forgotten'));
assert(!has(Discovery.evaluateListening({goneReturns:[{...gone,return_scrobbles:9}]}),'gone_but_not_forgotten'));
assert(!has(Discovery.evaluateListening({goneReturns:[{...gone,coverage_continuous:false}]}),'gone_but_not_forgotten'));
assert(!has(Discovery.evaluateListening({goneReturns:[{...gone,absence_days:179}]}),'gone_but_not_forgotten'));

console.log('Discovery rule tests passed');
