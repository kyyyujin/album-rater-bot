'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const Discovery=require('./discovery-rules');
const {achievementTrustBoundary}=require('./secret-visibility');

const DAY=86400000;
const album={id:'vault-album-1',title:'Example Album',artist:'Example Artist',score:7};
const event=(id,type,at,score,extra={})=>({
  event_id:id,
  type,
  occurred_at:at,
  payload:{album_id:album.id,album:{...album,score},new_score:score,score,...extra}
});
const initial=(score=7,at='2026-01-01T00:00:00.000Z')=>event('initial','album_rated',at,score);
const rescore=(id,score,days,previousScore=7)=>event(id,'album_rescored',new Date(Date.parse('2026-01-01T00:00:00.000Z')+days*DAY).toISOString(),score,{previous_score:previousScore,delta:Number((score-previousScore).toFixed(2))});
const evaluate=(events,current=events.at(-1))=>Discovery.evaluateVault({event:current,eligibleEvents:events});
const match=result=>result.candidates.find(row=>row.key==='same_song_different_me');

const definition=Discovery.DEFINITIONS.find(row=>row.key==='same_song_different_me');
assert(definition&&definition.enabled!==false,'family is active server-side');
assert.strictEqual(definition.rarity,'Legendary');
assert.strictEqual(definition.metadata.discovery,true);
assert.strictEqual(definition.metadata.emblemEligible,false);
assert(!('blockedBySpecAmbiguity' in definition.metadata),'Recording ambiguity marker was removed');

assert(!match(evaluate([initial(),rescore('delta-1.99',8.99,365)])),'1.99 after 365 days must not unlock');
assert(match(evaluate([initial(),rescore('delta-2.00',9,365)])),'2.00 after 365 days must unlock');
assert(match(evaluate([initial(),rescore('delta-over-2.00',9.25,366)])),'a delta over 2.00 must unlock');
assert(!match(evaluate([initial(),rescore('too-soon',9,364)])),'2.00 before 365 days must not unlock');
assert(match(evaluate([initial(),rescore('exact-boundary',9,365)])),'the exact 365-day boundary must unlock');
assert(match(evaluate([initial(7),rescore('positive',9,365)])),'7.00 to 9.00 is valid');
const negativeInitial=initial(9);
const negativeRescore=rescore('negative',7,365,9);
assert(match(evaluate([negativeInitial,negativeRescore])),'9.00 to 7.00 is valid');

const sequenceInitial=initial(7);
const intermediate=rescore('intermediate',8,180,7);
const sequenceFinal=rescore('sequence-final',9,365,8);
const sequenceCandidate=match(evaluate([sequenceInitial,intermediate,sequenceFinal]));
assert(sequenceCandidate,'7.00 to 8.00 to 9.00 must compare the final score to the initial score');
assert.strictEqual(sequenceCandidate.snapshot.total_difference,2);
assert.strictEqual(sequenceCandidate.snapshot.initial_event_id,'initial');
assert.strictEqual(sequenceCandidate.snapshot.qualifying_rescore_event_id,'sequence-final');

const legacyOnly=rescore('legacy-rescore',9,365,7);
legacyOnly.payload.album.scoreHistory=[
  {score:7,date:'2025-01-01',label:'legacy initial'},
  {score:9,date:'2026-01-01',label:'legacy rescore'}
];
assert(!match(evaluate([legacyOnly])),'legacy scoreHistory cannot manufacture an eligible initial event');

for(const field of ['vault_album_id','album','initial_score','initial_score_at','qualifying_rescore','qualifying_rescore_at','total_difference','elapsed_days','triggering_event_ids','rule_version','rarity']) {
  assert(Object.hasOwn(sequenceCandidate.snapshot,field),`snapshot is missing ${field}`);
}
assert.deepStrictEqual(sequenceCandidate.snapshot.album,{id:album.id,title:album.title,artist:album.artist,cover:null});
assert.deepStrictEqual(sequenceCandidate.snapshot.triggering_event_ids,['initial','sequence-final']);
assert.strictEqual(sequenceCandidate.snapshot.elapsed_days,365);
assert.strictEqual(sequenceCandidate.snapshot.rule_version,definition.ruleVersion);
assert.strictEqual(sequenceCandidate.snapshot.rarity,'Legendary');

const databaseDefinition={key:definition.key,title:definition.title,rarity:definition.rarity,is_discovery:true,emblem_eligible:false,client_metadata:{discovery:true,emblemEligible:false}};
const locked=achievementTrustBoundary({definitions:[databaseDefinition],progress:[{achievement_key:definition.key,current_value:1}],unlocks:[],showcase:[{achievement_key:definition.key}],inbox:[{achievement_key:definition.key}]});
assert.deepStrictEqual(locked.definitions,[],'locked Discovery has no client definition, slot, name, key, description or rarity');
assert.strictEqual(locked.availableCount,0,'locked Discovery does not change the visible denominator');
assert.deepStrictEqual(locked.progress,[],'locked Discovery has no client progress');
assert(!JSON.stringify(locked).includes(definition.key)&&!JSON.stringify(locked).includes(definition.title),'locked payload has no lookup oracle');
const unlocked=achievementTrustBoundary({definitions:[databaseDefinition],unlocks:[{achievement_key:definition.key,snapshot:sequenceCandidate.snapshot}]});
assert.strictEqual(unlocked.definitions[0].key,definition.key,'the authorized owner receives the definition after unlock');
assert.strictEqual(unlocked.availableCount,1,'the denominator grows only after discovery');

assert(!match(Discovery.evaluateListening({periods:[],loveDive:[],goneReturns:[]})),'Listening evaluation cannot unlock a Vault-only family');
const source=fs.readFileSync(path.join(__dirname,'discovery-rules.js'),'utf8');
const ruleStart=source.indexOf("candidates.push(candidate('same_song_different_me'");
const ruleBlock=source.slice(ruleStart,source.indexOf('if(initial&&rescores.length',ruleStart));
assert(ruleStart>=0&&ruleBlock.length>0,'Same Song rule block must exist');
for(const forbidden of ['recording','release_track','lastfm','scrobble','coverage','epoch','period']) assert(!ruleBlock.toLowerCase().includes(forbidden),`Vault-only rule unexpectedly depends on ${forbidden}`);

const phaseOneSql=fs.readFileSync(path.join(__dirname,'migrations/20260912_phase1_achievements.sql'),'utf8').toLowerCase();
const phaseFourSql=fs.readFileSync(path.join(__dirname,'migrations/20260917063000_phase4a_discovery_secrets.sql'),'utf8').toLowerCase();
assert(phaseOneSql.includes('unique(user_id,achievement_key,level)'),'unlock table enforces one family unlock per user and level');
assert(phaseFourSql.includes('on conflict(user_id,achievement_key,level) do nothing'),'duplicate reevaluation remains idempotent');

console.log('PASS Same Song, Different Me thresholds, zero-start, snapshot, secrecy and idempotency');
