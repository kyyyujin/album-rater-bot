'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createSchedulerPipelines } = require('./scheduler-pipelines');

(async () => {
  let releaseEnrichment;
  const enrichmentGate=new Promise(resolve=>{ releaseEnrichment=resolve; });
  let syncCalls=0,enrichmentCalls=0;
  const pipelines=createSchedulerPipelines({
    syncAll:async()=>{ syncCalls++; return [{status:'success',inserted:1}]; },
    enrichBatch:async()=>{ enrichmentCalls++; await enrichmentGate; return {processed:1,resolved:0}; }
  });

  const enrichment=pipelines.enrich(1);
  const sync=await Promise.race([
    pipelines.sync(),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('sync waited for MusicBrainz')),100))
  ]);
  assert.equal(sync.results[0].status,'success','slow MusicBrainz does not block Last.fm sync');
  assert.equal(syncCalls,1); assert.equal(enrichmentCalls,1);
  releaseEnrichment(); await enrichment;

  const failedEnrichment=createSchedulerPipelines({
    syncAll:async()=>[{status:'success',watermark:'advanced',coverage:'advanced'}],
    enrichBatch:async()=>{ throw Object.assign(new Error('MusicBrainz 503'),{status:503}); }
  });
  await assert.rejects(()=>failedEnrichment.enrich(1),/MusicBrainz 503/);
  const isolated=await failedEnrichment.sync();
  assert.deepEqual(isolated.results[0],{status:'success',watermark:'advanced',coverage:'advanced'},'enrichment failure cannot roll back sync watermark/coverage');

  const source=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
  const syncAll=source.slice(source.indexOf('async function syncAllConfiguredLastfmUsers'),source.indexOf('async function listeningTrackingReadModel'));
  assert(!syncAll.includes('runListeningEnrichmentBatch'),'sync pipeline never awaits enrichment');
  const claimMigration=fs.readFileSync(path.join(__dirname,'migrations','20260916072609_phase3a_enrichment_queue_order.sql'),'utf8');
  assert(claimMigration.toLowerCase().includes('for update of j skip locked'),'concurrent cron invocations retain SKIP LOCKED');

  console.log('PASS independent sync/enrichment failure domains, bounded concurrent worker claim and watermark isolation');
})().catch(error=>{ console.error(error); process.exitCode=1; });
