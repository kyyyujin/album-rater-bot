'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyEnrichmentError, retryDelayMs } = require('./enrichment-reliability');

const classified = error => classifyEnrichmentError(error);

assert.equal(classified(Object.assign(new Error('network timeout'),{code:'ETIMEDOUT'})).status,'retry','transport timeout retries');
assert.equal(classified(Object.assign(new Error('socket reset'),{code:'ECONNRESET'})).status,'retry','connection reset retries');
assert.equal(classified(Object.assign(new Error('MusicBrainz 503'),{status:503})).status,'retry','HTTP 503 retries');
assert.equal(classified(Object.assign(new Error('MusicBrainz 429'),{status:429})).status,'retry','HTTP 429 retries');
assert.equal(classified(Object.assign(new Error('complete exact search: no result'),{resolution:'musicbrainz_no_unequivocal_album_match',retry:true})).status,'unresolved','completed no-match is canonical unresolved even if legacy code marked it retryable');
assert.equal(classified(Object.assign(new Error('multiple candidates'),{resolution:'ambiguous_release_group'})).status,'ambiguous','multiple canonical candidates are ambiguous');
assert.equal(classified(Object.assign(new Error('not present'),{resolution:'track_not_in_verified_release'})).status,'unresolved','track absent from a verified release is canonical unresolved');
assert.equal(classified(new Error('unexpected invariant failure')).status,'failed','unknown internal failure is permanent failed, not canonical unresolved');

for (const attempts of [1,2,6,12,100]) {
  const outcome=classified(Object.assign(new Error('MusicBrainz 503'),{status:503}));
  assert.equal(outcome.status,'retry');
  assert(retryDelayMs(attempts)>0,'every transient attempt retains a future recoverable cooldown');
}
assert.equal(retryDelayMs(100),24*60*60*1000,'repeated transient failures cap at a one-day recoverable cooldown');
assert(retryDelayMs(1,2*60*60*1000)>=2*60*60*1000,'Retry-After is respected');

const migration=fs.readFileSync(path.join(__dirname,'migrations','20260916154500_post_phase3a_enrichment_reliability.sql'),'utf8');
assert(migration.includes("j.status='unresolved'"));
assert(migration.includes("j.resolution_reason='enrichment_error'"));
assert(migration.includes("^request to https://musicbrainz\\.org/"),'recovery is limited to recorded MusicBrainz transport failures');
assert(!migration.includes("j.resolution_reason='musicbrainz_no_unequivocal_album_match'"),'canonical no-match jobs are not recovery targets');
assert(!migration.includes("j.resolution_reason='track_not_in_verified_release'"),'verified-release no-match jobs are not recovery targets');
assert(migration.includes("'album_vault_listening_enrichment'"));
assert(migration.includes("/internal/listening/enrich"));
assert(migration.includes("body:='{" + '\"limit\":1' + "}'::jsonb"),'cron enrichment remains bounded');
assert(migration.includes('for update of j skip locked')===false,'existing SKIP LOCKED claim function is not replaced by recovery migration');

console.log('PASS enrichment error taxonomy, recoverable cooldown and precise historical transport recovery');
