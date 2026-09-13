'use strict';
const assert=require('assert');
const {evaluate,substantialReview,eligibleAfter}=require('./achievement-rules');
const album=(id,s,tr={})=>({id:String(id),title:`Album ${id}`,artist:`Artist ${id}`,score:s,status:'listened',genres:['Kpop'],year:2020,trackScores:tr});
const event=(id,type,a,extra={})=>({event_id:id,type,occurred_at:extra.occurred_at||'2026-09-12T12:00:00.000Z',payload:{album_id:String(a?.id||''),album:a,...extra}});
const has=(x,k,l=1)=>x.candidates.some(c=>c.key===k&&c.level===l);
const ev=(e,eligible)=>evaluate({event:e,eligibleEvents:eligible});

// start-from-zero: historic data never enters eligibleEvents.
const old=Array.from({length:10},(_,i)=>event(`old-${i}`,'album_rated',album(i,i===0?10:8),{occurred_at:'2025-01-01T00:00:00.000Z'}));
let current=event('new-1','album_rated',album('new',8)); let r=ev(current,[current]);
assert.strictEqual(eligibleAfter([...old,current],'2026-09-12T00:00:00.000Z').length,1,'events before tracking start are ignored');
assert(has(r,'the_beginning'),'first post-activation rating unlocks The Beginning');
assert(!has(r,'archivist'),'10 historic ratings do not unlock Archivist');
assert(!has(r,'masterpiece'),'historic 10 does not unlock Masterpiece');
assert.strictEqual(r.progress.find(p=>p.key==='archivist').currentValue,1,'Archivist begins at 1 after first new rating');

const postTen=event('new-10','album_rated',album('ten',10)); assert(has(ev(postTen,[current,postTen]),'masterpiece'),'new 10 unlocks Masterpiece');
const postLow=event('new-low','album_rated',album('low',3)); assert(has(ev(postLow,[current,postLow]),'savage'),'new score <= 3 unlocks Savage');
const tenRatings=Array.from({length:10},(_,i)=>event(`post-${i}`,'album_rated',album(`p${i}`,8),{occurred_at:`2026-09-12T12:${String(i).padStart(2,'0')}:00.000Z`}));
r=ev(tenRatings[9],tenRatings); assert(has(r,'archivist',1),'10 eligible ratings unlock Archivist I');

const rescored=album('r',9); const firstRescore=event('rescore-1','album_rescored',rescored,{previous_score:8,new_score:9,delta:1});
assert(has(ev(firstRescore,[firstRescore]),'second_thoughts'),'post-activation re-score unlocks Second Thoughts');
assert(has(ev(firstRescore,[firstRescore]),'it_grew_on_me'),'positive delta unlocks It Grew On Me');
const downRescore=event('rescore-down','album_rescored',album('r',7.8),{previous_score:9,new_score:7.8,delta:-1.2});
assert(has(ev(downRescore,[downRescore]),'what_was_i_thinking'),'negative delta unlocks What Was I Thinking?');

const no=album('no',9,{a:9,b:9,c:9,d:9,e:9,f:9}); assert(has(ev(event('tracks','track_scores_saved',no),[event('tracks','track_scores_saved',no)]),'no_skip'),'post action unlocks No Skip');
const bal=album('bal',8,{a:8,b:8.1,c:8.2,d:8.1,e:8,f:8.2}); assert(has(ev(event('balanced','track_scores_saved',bal),[event('balanced','track_scores_saved',bal)]),'perfectly_balanced'),'post action unlocks Perfectly Balanced');
const roll=album('roll',7,{a:3,b:4,c:5,d:6,e:7,f:9}); assert(has(ev(event('roller','track_scores_saved',roll),[event('roller','track_scores_saved',roll)]),'roller_coaster'),'post action unlocks Roller Coaster');
const one=album('one',5,{a:9,b:4,c:4,d:4,e:4}); assert(has(ev(event('one','track_scores_saved',one),[event('one','track_scores_saved',one)]),'one_good_song'),'post action unlocks One Good Song');

const initial=event('rate-a','album_rated',album('a',8),{score:8,occurred_at:'2026-01-01T00:00:00.000Z'});
const r1=event('r1','album_rescored',album('a',8.3),{previous_score:8,new_score:8.3,delta:.3,occurred_at:'2026-02-01T00:00:00.000Z'});
const r2=event('r2','album_rescored',album('a',8.7),{previous_score:8.3,new_score:8.7,delta:.4,occurred_at:'2026-03-01T00:00:00.000Z'});
const r3=event('r3','album_rescored',album('a',9.2),{previous_score:8.7,new_score:9.2,delta:.5,occurred_at:'2026-04-01T00:00:00.000Z'});
r=ev(r3,[initial,r1,r2,r3]); assert(has(r,'antifragile',1)&&has(r,'antifragile',2)&&has(r,'antifragile',3),'ANTIFRAGILE follows one eligible album trajectory');
const wrongAlbum=event('other','album_rescored',album('other',10),{previous_score:8,new_score:10,delta:2,occurred_at:'2026-02-15T00:00:00.000Z'}); assert(!has(ev(r1,[r1,wrongAlbum]),'antifragile'),'different albums never combine for ANTIFRAGILE');
const review=event('review','review_written',album('talk',8),{substantial:true,excerpt:'A real review with enough words',occurred_at:'2026-01-01T00:00:00.000Z'}); const talk=event('talk','album_rescored',album('talk',8.8),{previous_score:8,new_score:8.8,delta:.8,occurred_at:'2026-02-02T00:00:00.000Z'}); assert(has(ev(talk,[review,talk]),'talk_that_talk'),'Talk That Talk requires eligible review before 30-day re-score');
assert(substantialReview('This is a thoughtful review with actual words.',album('s',8)));assert(!substantialReview('Album s Artist s',album('s',8)));
console.log('PASS start-from-zero, ratings, tracks, re-scores, ANTIFRAGILE and Talk That Talk');
