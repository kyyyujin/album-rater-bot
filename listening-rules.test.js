'use strict';
const assert=require('assert');
const Rules=require('./listening-rules');

const release=(n,id='rg1')=>({release_group_id:id,scrobble_count:n,display_title:'Album',artist_name:'Artist'});
const artist=(n,id='a1')=>({artist_id:id,scrobble_count:n,display_name:'Artist'});
function has(result,key,level=1){ return result.candidates.some(x=>x.key===key&&x.level===level); }

let r=Rules.evaluate({releaseGroups:[release(24)],artists:[artist(99)]});
assert(!has(r,'on_repeat')&&!has(r,'dedicated'),'under first level stays locked');
r=Rules.evaluate({releaseGroups:[release(25),release(100,'rg2'),release(250,'rg3')],artists:[artist(100),artist(500,'a2'),artist(1500,'a3')]});
assert(has(r,'on_repeat',1)&&has(r,'on_repeat',2)&&has(r,'on_repeat',3),'On Repeat levels');
assert(has(r,'dedicated',1)&&has(r,'dedicated',2)&&has(r,'dedicated',3),'Dedicated levels');
r=Rules.evaluate({hyperfixation:{total:50,album_count:20,coverage:.9,release_group:{id:'rg'}},lucidDream:{scrobbles:99,days:Array(15).fill('2026-01-01')},magnetic:[]});
assert(has(r,'hyperfixation'),'Hyperfixation exact boundary');
assert(!has(r,'lucid_dream'),'Lucid Dream needs 100');
r=Rules.evaluate({hyperfixation:{total:50,album_count:19,coverage:.99},lucidDream:{scrobbles:100,days:['2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05','2026-01-06','2026-01-07','2026-01-08','2026-01-09','2026-01-10','2026-01-11','2026-01-12','2026-01-13','2026-01-14','2026-01-15']},magnetic:[]});
assert(!has(r,'hyperfixation'),'Hyperfixation needs 20 album plays');
assert(has(r,'lucid_dream'),'Lucid Dream needs 15 distinct days');
r=Rules.evaluate({hyperfixation:{total:70,album_count:30,coverage:.89},magnetic:[]});
assert(!has(r,'hyperfixation'),'Hyperfixation rejects coverage below 90%');
r=Rules.evaluate({magnetic:[{release_group_id:'rg',days:['2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05','2026-01-06'],streak_scrobbles:30}]});
assert(!has(r,'magnetic'),'Magnetic needs seven consecutive local days');
r=Rules.evaluate({magnetic:[{release_group_id:'rg',days:['2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05','2026-01-06','2026-01-07'],streak_scrobbles:14}]});
assert(has(r,'magnetic'),'Magnetic exact boundary');
r=Rules.evaluate({magnetic:[{release_group_id:'rg',days:['2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05','2026-01-06','2026-01-07'],streak_scrobbles:13}]});
assert(!has(r,'magnetic'),'Magnetic needs 14 plays');
console.log('PASS listening levels, Hyperfixation, Lucid Dream and Magnetic thresholds');
