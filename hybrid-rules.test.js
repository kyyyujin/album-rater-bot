'use strict';
const assert=require('assert');
const Rules=require('./hybrid-rules');

const DAY=Rules.DAY, epoch='epoch-1', start='2026-01-01T00:00:00.000Z';
const at=n=>new Date(Date.parse(start)+n*DAY).toISOString();
const plays=(count,group='g1',track='t1',from=1)=>Array.from({length:count},(_,i)=>({id:`${group}-${track}-${from+i}`,played_at:at(from+i/100),release_group_id:group,track_id:track}));
const covered=(a,b,id=epoch)=>[{epoch_id:id,status:'covered',coverage_start:a,coverage_end:b}];
const baseAlbum=overrides=>({album_id:'a1',canonical:true,release_group_id:'g1',artist_id:'ar1',release_group:{id:'g1',title:'Album',artist:'Artist'},initial_rating:{score:9.5,at:start},current_score:9.8,current_score_at:start,current_tier:'S+',rescores:[],reviews:[],track_scores:[],total_scrobbles:0,scrobbles:[],...overrides});
const keys=result=>new Set(result.candidates.map(x=>`${x.key}:${x.level}`));
function input(album,extra={}) { return {epoch_id:epoch,now:at(400),albums:album?[album]:[],artists:[],coverage:covered(start,at(500)),periods:[],all_scrobbles:[],...extra}; }

assert.strictEqual(Rules.DEFINITIONS.length,17,'ten Hybrid plus seven visible Secrets');
assert(!keys(Rules.evaluate(input(baseAlbum({total_scrobbles:49,scrobbles:plays(49)})))).has('love_at_first_listen:1'));
assert(keys(Rules.evaluate(input(baseAlbum({total_scrobbles:50,scrobbles:plays(50)})))).has('love_at_first_listen:1'));
assert(keys(Rules.evaluate(input(baseAlbum({total_scrobbles:50,scrobbles:[],metrics:{initial_after:{count:50,first:at(1),last:at(2)},initial_30d:{count:50}}})))).has('love_at_first_listen:1'),'server-side window counters avoid raw-ledger scans');
const duplicate=plays(49); duplicate.push({...duplicate[0]});
assert(!keys(Rules.evaluate(input(baseAlbum({total_scrobbles:49,scrobbles:duplicate})))).has('love_at_first_listen:1'),'duplicates never create the 50th play');
assert(!keys(Rules.evaluate(input(baseAlbum({total_scrobbles:249,scrobbles:plays(249)})))).has('certified_favorite:1'));
assert(keys(Rules.evaluate(input(baseAlbum({total_scrobbles:250,scrobbles:plays(250)})))).has('certified_favorite:1'));
assert(keys(Rules.evaluate(input(baseAlbum({current_score:8,rescores:[{at:at(2),before:7,after:8,delta:1}],total_scrobbles:100,scrobbles:plays(100,'g1','t1',3)})))).has('it_really_grew_on_me:1'));

const instant=baseAlbum({initial_rating:{score:9.5,at:start},total_scrobbles:100,scrobbles:plays(100,'g1','t1',1)});
assert(keys(Rules.evaluate(input(instant,{now:at(31),coverage:covered(start,at(21))}))).has('instant_classic:1'));
assert(!keys(Rules.evaluate(input(instant,{now:at(31),coverage:covered(start,new Date(Date.parse(start)+20.9*DAY).toISOString())}))).has('instant_classic:1'));
assert(!keys(Rules.evaluate(input({...instant,canonical:false},{now:at(31)}))).has('instant_classic:1'),'unresolved albums are ineligible');

const artist={artist_id:'ar1',artist:{id:'ar1',name:'Artist'},rated_release_groups:5,total_scrobbles:500,release_groups:[]};
assert(keys(Rules.evaluate(input(null,{artists:[artist]}))).has('headliner:1'));
assert(!keys(Rules.evaluate(input(null,{artists:[{...artist,rated_release_groups:4}]}))).has('headliner:1'));

const week={id:'p1',period_type:'week',completeness:'complete',local_start:'2026-01-05',local_end:'2026-01-12',utc_start:at(4),utc_end:at(11),coverage_ratio:.95,scrobble_total:25,rankings:{release_groups:[{id:'g1',rank:1,count:12}]}};
const reviewed=baseAlbum({reviews:[{at:at(3),char_count:80}]});
assert(keys(Rules.evaluate(input(reviewed,{periods:[week]}))).has('soundtrack:1'));
assert(!keys(Rules.evaluate(input(reviewed,{periods:[{...week,completeness:'partial'}]}))).has('soundtrack:1'));
assert(!keys(Rules.evaluate(input(reviewed,{periods:[{...week,rankings:{release_groups:[{id:'g1',rank:1,count:12},{id:'g2',rank:1,count:12}]}}]}))).has('soundtrack:1'),'weekly #1 ties are not canonical winners');

const contrarian=baseAlbum({current_score:6,track_scores:[{title:'Hit',score:9.5,track_id:'t1',scrobble_count:50},...Array.from({length:4},(_,i)=>({title:`x${i}`,score:5,track_id:`x${i}`,scrobble_count:0}))]});
assert(keys(Rules.evaluate(input(contrarian))).has('contrarian:1'));
assert(!keys(Rules.evaluate(input({...contrarian,track_scores:contrarian.track_scores.map((x,i)=>i?x:{...x,track_id:null})}))).has('contrarian:1'),'title-only track evidence is rejected');

const feels=baseAlbum({initial_rating:{score:8,at:start},current_score:9,rescores:[{at:at(20),before:8,after:9,delta:1}],scrobbles:plays(100,'g1','t1',1),total_scrobbles:100});
assert(keys(Rules.evaluate(input(feels))).has('the_feels:1'));
assert(!keys(Rules.evaluate(input({...feels,scrobbles:plays(99,'g1','t1',1),total_scrobbles:99}))).has('the_feels:1'));
const perfect=baseAlbum({current_score:9.5,total_scrobbles:250,track_scores:Array.from({length:6},(_,i)=>({title:`t${i}`,score:9,track_id:`t${i}`}))});
assert(keys(Rules.evaluate(input(perfect))).has('perfect_world:1'));

const rolling={version:1,window_start:start,window_end:at(90),top_artist_id:'ar1',top_artist_plays:150,unique_top_artist:true,top_artist:{id:'ar1'},top_artist_album_count:4,top_artist_rating_mean:6.5,best_rated_artist_id:'ar1',best_rated_album_count:4,best_rated_mean:8.5,unique_best_rated_artist:true,artist:{id:'ar1'}};
let result=Rules.evaluate(input(null,{rolling90:rolling})); assert(keys(result).has('match_made_in_heaven:1')); assert(keys(result).has('mixed_signals:1'));
assert(!keys(Rules.evaluate(input(null,{rolling90:{...rolling,unique_top_artist:false}}))).has('match_made_in_heaven:1'),'ranking ties are conservative');

result=Rules.evaluate(input(baseAlbum({current_score:5,total_scrobbles:250,scrobbles:plays(250)}))); assert(keys(result).has('love_foolish:1')); assert(keys(result).has('love_foolish:2'));
const paper=baseAlbum({initial_rating:{score:9.5,at:start},current_score:9.5,total_scrobbles:5,scrobbles:plays(5)});
assert(keys(Rules.evaluate(input(paper,{now:at(180),coverage:covered(start,at(120))}))).has('paper_favorite:1'));
assert(!keys(Rules.evaluate(input({...paper,total_scrobbles:6,scrobbles:plays(6)},{now:at(180),coverage:covered(start,at(120))}))).has('paper_favorite:1'));
const never=baseAlbum({initial_rating:null,current_score:3,current_score_at:start,total_scrobbles:0,scrobbles:[]});
assert(keys(Rules.evaluate(input(never,{now:at(365),coverage:covered(start,at(180))}))).has('never_again:1'));

const month=(id,date,group,rank=1,count=20)=>({id,period_type:'month',completeness:'complete',local_start:date,local_end:date,utc_start:at(Number(id)*30),utc_end:at(Number(id)*30+1),coverage_ratio:1,scrobble_total:count,rankings:{release_groups:[{id:group,rank,count}]}});
const m1=month('1','2026-02-01','g1'),m2=month('2','2026-03-01','g2'),m3=month('3','2026-04-01','g1');
assert(keys(Rules.evaluate(input(baseAlbum({}),{periods:[m1,m2,m3]}))).has('one_more_time:1'));
assert(!keys(Rules.evaluate(input(baseAlbum({}),{periods:[m1,{...m2,rankings:{release_groups:[{id:'g1',rank:1,count:20}]}},m3]}))).has('one_more_time:1'));

const peak={...m1,utc_end:at(31),rankings:{release_groups:[{id:'g1',rank:1,count:80}]}};
const ghostEvidence={now:at(220),periods:[peak],daily_totals:[{local_date:'2026-02-02',scrobble_count:150}],daily_release_counts:[]};
assert(keys(Rules.evaluate(input(baseAlbum({scrobbles:[],total_scrobbles:80}),{...ghostEvidence,coverage:covered(at(31),at(220))}))).has('ghosted:1'));
assert(!keys(Rules.evaluate(input(baseAlbum({scrobbles:[],total_scrobbles:80}),{...ghostEvidence,coverage:[...covered(at(31),at(100)),...covered(at(101),at(220))]}))).has('ghosted:1'),'Ghosted requires continuous negative evidence');
const first60={id:'f60',period_type:'tracking_60d',completeness:'complete',local_start:'2026-01-01',local_end:'2026-03-02',utc_start:start,utc_end:at(60),coverage_ratio:1,scrobble_total:30,rankings:{release_groups:[{id:'g1',rank:5,count:15}]}};
const late={id:'late',period_type:'month',completeness:'complete',local_start:'2026-12-01',local_end:'2027-01-01',utc_start:at(330),utc_end:at(360),coverage_ratio:1,scrobble_total:30,rankings:{release_groups:[{id:'g1',rank:5,count:15}]}};
assert(keys(Rules.evaluate(input(baseAlbum({}),{periods:[first60,late]}))).has('till_the_end:1'));

const c=Rules.mergedCoverage([...covered(start,at(2)),...covered(at(2),at(4))],epoch,start,at(4)); assert.strictEqual(c.continuous,true); assert.strictEqual(c.ratio,1);
assert.strictEqual(Rules.mergedCoverage(covered(start,at(4),'other'),epoch,start,at(4)).ratio,0,'coverage cannot cross epochs');
assert.strictEqual(Rules.mergedCoverage([...covered(start,at(1)),...covered(at(2),at(4))],epoch,start,at(4)).continuous,false,'a gap is not zero listening');

console.log('hybrid-rules tests passed');
